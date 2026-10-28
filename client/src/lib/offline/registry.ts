// ── Offline action registry (pure) ───────────────────────────────────────────
//
// Everything here is a plain function over plain data — no IndexedDB, no fetch,
// no React — so the decisions that matter (may this be queued? which cache entry
// does it change? is this failure a conflict or a retry?) are unit-testable
// without a browser.
//
// ── Conflict policy, in one place ────────────────────────────────────────────
//
// Two rules cover every case, and both are applied when a queued action finally
// reaches the server:
//
//   * SERVER WINS for anything the server owns or guards. An approval, a lock, a
//     dispatch, a return and an owner's edit are all guarded state transitions:
//     if the server no longer agrees the order is in the expected state, the
//     queued action did not happen. We never overwrite that — the local change is
//     undone, the server's version is refetched, and the conflict is logged.
//   * CLIENT WINS for a record the client owns and the server does not guard:
//     creating a customer / order / receipt / vehicle (the server only assigns an
//     id), a driver's own vehicle assignment for a day, and a field patch on a row
//     the user owns. These are applied as-is.
//
// Nothing is dropped silently: every non-retryable failure is written to a
// conflict log the owner can read on the Sync page.

import { buildLedger, type LedgerReceipt } from "@shared/ledger";
import type { OrderStatus } from "@shared/rental";

// ── which procedures may be queued offline ───────────────────────────────────

/**
 * Writes that are safe to perform with no connection: they are the user's own
 * data, the server does not guard them with a state precondition, or (for the
 * order transitions) a guarded attempt is a legitimate thing to make — it simply
 * reports a conflict if someone else got there first.
 */
export const QUEUEABLE = new Set<string>([
  "orders.create",
  "orders.update",
  "orders.approve",
  "orders.reject",
  "orders.lock",
  "orders.dispatch",
  "orders.return",
  "receipts.create",
  "receipts.remove",
  "customers.create",
  "customers.setOpeningBalance",
  "assignments.setMine",
  "equipment.create",
  "equipment.update",
  "vehicles.create",
  "drivers.create",
  // A location ping is the driver's own data and the server does not guard it
  // with a state precondition, so it is safe to hold in the outbox and replay
  // when the connection returns. The server still refuses a ping from a driver
  // with no active trip, which is what stops a stale queue reporting a position
  // after the trip ended.
  "tracking.ping",
]);

/**
 * Writes that must NEVER be queued, because replaying them later would be
 * meaningless or unsafe: signing in has to happen now, a mailed one-time code is
 * only valid for its session, and account provisioning needs a live server
 * response. Offline these are refused with a clear message instead of being
 * parked in the outbox.
 */
export const NEVER_QUEUE = new Set<string>([
  "auth.login",
  "auth.signup",
  "auth.logout",
  "auth.requestPasswordReset",
  "auth.verifyResetCode",
  "auth.resetPassword",
  "account.seed",
  "users.createDriver",
]);

export type QueueDecision = "send" | "queue" | "reject-offline";

/**
 * What to do with a mutation. `online` is the client's current connectivity.
 *
 * The middle branch is why the outbox works at all: while online, a queueable
 * write is attempted normally, and the link queues it only if that attempt
 * fails. While offline it is queued immediately.
 */
export function decideQueue(path: string, online: boolean): QueueDecision {
  if (NEVER_QUEUE.has(path)) return online ? "send" : "reject-offline";
  if (QUEUEABLE.has(path)) return online ? "send" : "queue";
  return online ? "send" : "reject-offline";
}

/** True when this write is one the outbox is allowed to hold. */
export function isQueueable(path: string): boolean {
  return QUEUEABLE.has(path);
}

const CONFLICT_POLICY: Record<string, "server" | "client"> = {
  "orders.create": "client",
  "orders.update": "server",
  "orders.approve": "server",
  "orders.reject": "server",
  "orders.lock": "server",
  "orders.dispatch": "server",
  "orders.return": "server",
  "receipts.create": "client",
  "receipts.remove": "client",
  "customers.create": "client",
  "customers.setOpeningBalance": "client",
  "assignments.setMine": "client",
  "equipment.create": "client",
  "equipment.update": "client",
  "vehicles.create": "client",
  "drivers.create": "client",
  "tracking.ping": "client",
};

/** Which side wins when this action cannot be applied as written. */
export function conflictPolicy(path: string): "server" | "client" {
  return CONFLICT_POLICY[path] ?? "server";
}

export type FlushVerdict = "applied" | "conflict" | "retry";

/**
 * Classify the outcome of replaying one queued action.
 *
 * "retry" is the important one: a dropped connection or a transient server fault
 * must leave the action queued, not throw the user's work away.
 */
export function classifyFlushError(code: string | null | undefined, httpStatus?: number | null): FlushVerdict {
  if (!code && !httpStatus) return "retry";
  switch (code) {
    case "TOO_MANY_REQUESTS":
    case "INTERNAL_SERVER_ERROR":
    case "TIMEOUT":
    case "CLIENT_CLOSED_REQUEST":
      return "retry";
    case "BAD_REQUEST":
    case "UNAUTHORIZED":
    case "FORBIDDEN":
    case "NOT_FOUND":
    case "CONFLICT":
    case "PRECONDITION_FAILED":
    case "UNPROCESSABLE_CONTENT":
      return "conflict";
    default:
      break;
  }
  if (httpStatus === 0 || httpStatus === undefined || httpStatus === null) return "retry";
  if (httpStatus >= 500) return "retry";
  return "conflict";
}

// ── local ids and references ─────────────────────────────────────────────────

/** A server-side id that a queued action can be pointed at once it resolves. */
export type RefIdMap = Record<string, string>;

const REF_PREFIX = "pending-";

export function makeLocalId(uuid: string = crypto.randomUUID()): string {
  return `${REF_PREFIX}${uuid}`;
}

export function isLocalId(id: unknown): id is string {
  return typeof id === "string" && id.startsWith(REF_PREFIX);
}

/**
 * Every local id referenced anywhere inside a queued action's input.
 *
 * Used to resolve dependencies at flush time: an order that references a
 * customer created in an earlier queued action cannot be sent until that
 * customer exists on the server, and the customer's id is what fills the hole.
 */
export function collectRefs(input: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown): void => {
    if (isLocalId(v)) found.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(input);
  return [...found];
}

/** Return a copy of `input` with every resolved local id replaced by its real id. */
export function substituteRefs(input: unknown, idMap: RefIdMap): unknown {
  const walk = (v: unknown): unknown => {
    if (isLocalId(v)) return idMap[v] ?? v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(input);
}

/** True when every local id this action needs has already been resolved. */
export function hasUnresolvedRefs(input: unknown, idMap: RefIdMap): boolean {
  return collectRefs(input).some((ref) => !idMap[ref]);
}

// ── cache patching ───────────────────────────────────────────────────────────
//
// A queued action is applied optimistically to the cached reads it affects, so
// the user sees their own change immediately and the same code path also applies
// the server's answer after a successful flush (which is what clears the
// "waiting to sync" mark).

export interface PatchContext {
  localId: string;
  nowIso: string;
  /** Local date of the action, so an offline order carries a real BS date. */
  dateAd: string;
  dateBs: string;
  userId: string;
  role: "owner" | "driver";
  driverId: string | null;
  driverName: string | null;
  /** Extra context recorded with the action (vehicle name, previous balance…). */
  meta: Record<string, unknown>;
  input: Record<string, unknown>;
  /** Server reply, present only when applying after a successful flush. */
  result?: Record<string, unknown> | null;
  /** Name lookups built from the cached lists, for optimistic rows. */
  lookups: {
    equipment: Map<string, { name: string; code: string | null; unit: string }>;
    customers: Map<string, string>;
  };
}

export interface OrderedOrderRow {
  id: string;
  status: OrderStatus;
  orderDateAd: string;
  orderDateBs: string;
  notes: string | null;
  lockedByDriverId: string | null;
  driverId: string | null;
  vehicleId: string | null;
  customerId: string;
  createdAt: string | Date;
  customerName: string | null;
  driverName: string | null;
  vehicleName: string | null;
  vehicleNumber: string | null;
  pendingSync?: boolean;
}

export function sortOrders<T extends { createdAt: string | Date }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function bump(rows: OrderedOrderRow[], id: string, patch: Partial<OrderedOrderRow>, keep: boolean): OrderedOrderRow[] {
  const next = rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
  return keep ? next : next.filter((r) => r.id !== id);
}

export interface SummaryLike {
  orders?: Partial<Record<"total" | "pending" | "approved" | "onTransit" | "onRent" | "returned" | "rejected", number>>;
  [k: string]: unknown;
}

export type StatusKey = keyof NonNullable<SummaryLike["orders"]>;

const SUMMARY_KEY: Record<OrderStatus, StatusKey> = {
  pending_approval: "pending",
  approved: "approved",
  on_transit: "onTransit",
  on_rent: "onRent",
  returned: "returned",
  rejected: "rejected",
  dispatched: "onRent",
};

export function summaryKeyFor(status: OrderStatus): StatusKey {
  return SUMMARY_KEY[status];
}

/**
 * Add `delta` to one pipeline counter, and to the total.
 *
 * A status change is a MOVE: the caller bumps the old counter by -1 and the new
 * one by +1, so the total correctly cancels out. A brand-new order bumps its
 * counter and the total together. (The server's own summary derives these the
 * same way, so a refresh always agrees with what was shown offline.)
 */
export function bumpSummary(
  summary: SummaryLike | undefined,
  key: StatusKey,
  delta: number,
): SummaryLike | undefined {
  if (!summary?.orders) return summary;
  const orders = { ...summary.orders };
  orders[key] = Math.max(0, (orders[key] ?? 0) + delta);
  orders.total = Math.max(0, (orders.total ?? 0) + delta);
  return { ...summary, orders };
}

/** The `?status=` filter a cached `orders.list` key was fetched with, if any. */
export function statusFilterOf(cacheKey: string): OrderStatus | null {
  const idx = cacheKey.indexOf("|");
  if (idx < 0) return null;
  try {
    const input = JSON.parse(cacheKey.slice(idx + 1)) as { status?: string } | null;
    return (input?.status as OrderStatus | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Optimistic order row for a freshly queued (not yet sent) order. */
export function newOrderRow(ctx: PatchContext): OrderedOrderRow {
  return {
    id: ctx.localId,
    status: "pending_approval",
    orderDateAd: ctx.dateAd,
    orderDateBs: ctx.dateBs,
    notes: (ctx.input.notes as string | null) ?? null,
    lockedByDriverId: null,
    driverId: ctx.driverId,
    vehicleId: null,
    customerId: (ctx.input.customerId as string) ?? "",
    createdAt: ctx.nowIso,
    customerName: optimisticCustomerName(ctx) ?? null,
    driverName: ctx.driverName,
    vehicleName: null,
    vehicleNumber: null,
    pendingSync: true,
  };
}

/**
 * Just the fields this rebuild reads off a ledger row.
 *
 * Deliberately narrower than the server's `LedgerRow`: the shape here only has
 * to be enough to re-derive the balances, so the helper stays usable on a value
 * that came back from a cache entry rather than straight from the API.
 */
export interface LedgerRowLike {
  id: string;
  kind: "invoice" | "receipt" | string;
  description: string;
  dateAd: string;
  dateBs: string;
  debit: number;
  credit: number;
}

/** The customer name to show before the server has replied. */
export function optimisticCustomerName(ctx: PatchContext): string | undefined {
  const existing = ctx.input.customerId as string | undefined;
  if (isLocalId(existing)) {
    const created = ctx.input.__newCustomerName;
    if (typeof created === "string" && created) return created;
  }
  if (existing) return ctx.lookups.customers.get(existing);
  const nc = ctx.input.newCustomer as { name?: string } | undefined;
  return nc?.name;
}

/** Items for a locally queued order, using the cached equipment names. */
export function optimisticItems(ctx: PatchContext) {
  const items = (ctx.input.items as Array<Record<string, unknown>> | undefined) ?? [];
  return items.map((it, i) => {
    const eqId = String(it.equipmentId ?? "");
    const eq = ctx.lookups.equipment.get(eqId);
    const rate = Number(it.rate ?? 0);
    const units = Number(it.units ?? 0);
    const billedQty = Number(it.billedQty ?? 0);
    return {
      id: `${ctx.localId}-i${i}`,
      equipmentId: eqId,
      basis: String(it.basis ?? "day"),
      rate,
      actualQty: Number(it.actualQty ?? 0),
      billedQty,
      units,
      lineAmount: Math.round((rate * units * billedQty + Number.EPSILON) * 100) / 100,
      equipmentName: eq?.name ?? null,
      equipmentCode: eq?.code ?? null,
      unit: eq?.unit ?? null,
      pendingSync: true,
    };
  });
}

// ── receipts and the customer ledger ─────────────────────────────────────────

export interface ReceiptRow {
  id: string;
  customerId: string;
  customerName: string | null;
  amount: number;
  mode: string;
  referenceNo: string | null;
  notes: string | null;
  dateAd: string;
  dateBs: string;
  createdAt: string | Date;
  pendingSync?: boolean;
}

export function newReceiptRow(ctx: PatchContext): ReceiptRow {
  return {
    id: ctx.localId,
    customerId: String(ctx.input.customerId ?? ""),
    customerName: ctx.lookups.customers.get(String(ctx.input.customerId ?? "")) ?? null,
    amount: Number(ctx.input.amount ?? 0),
    mode: String(ctx.input.mode ?? "cash"),
    referenceNo: (ctx.input.referenceNo as string | null) ?? null,
    notes: (ctx.input.notes as string | null) ?? null,
    dateAd: (ctx.input.dateAd as string) ?? ctx.dateAd,
    dateBs: ctx.dateBs,
    createdAt: ctx.nowIso,
    pendingSync: true,
  };
}

interface LedgerLike {
  rows: LedgerRowLike[];
  totals: { openingBalance: number; totalInvoiced: number; totalReceived: number; closingDue: number };
  customer?: { id: string };
}

/**
 * Re-derive a cached customer ledger with one receipt added or removed.
 *
 * The ledger is rebuilt through the same pure `buildLedger` helper the server
 * uses, so a receipt recorded offline moves the closing balance by exactly the
 * amount the server will move it by on sync — the running balance shown offline
 * is the real one, not an approximation.
 */
export interface LedgerEdit {
  kind: "receipt" | "invoice";
  id: string;
  amount: number;
  dateAd: string;
  dateBs: string;
  description: string;
}

/**
 * Rebuild a cached customer ledger after adding or removing one or more entries.
 *
 * Everything goes back through the same pure `buildLedger` helper the server
 * uses, so a receipt recorded offline moves the closing balance by exactly the
 * amount the server will move it by on sync — the running balance the owner
 * reads offline is the real one, not an approximation. Used for receipts AND for
 * the invoice a driver's offline dispatch eventually produces.
 */
export function patchLedgerEntries(
  ledger: LedgerLike | undefined,
  edits: LedgerEdit[],
  remove: boolean,
): LedgerLike | undefined {
  if (!ledger || !Array.isArray(ledger.rows) || !ledger.totals) return ledger;
  const touched = new Set(edits.map((e) => e.id));

  const invoices = ledger.rows
    .filter((r) => r.kind === "invoice" && !touched.has(r.id))
    .map((r) => ({
      id: r.id,
      number: r.description.replace(/^Sales invoice\s+/, ""),
      dateAd: r.dateAd,
      dateBs: r.dateBs,
      total: Number(r.debit) || 0,
    }));

  const receipts: LedgerReceipt[] = ledger.rows
    .filter((r) => r.kind === "receipt" && !touched.has(r.id))
    .map((r) => ({
      id: r.id,
      amount: Number(r.credit) || 0,
      dateAd: r.dateAd,
      dateBs: r.dateBs,
      description: r.description,
    }));

  if (!remove) {
    for (const edit of edits) {
      if (edit.kind === "invoice") {
        invoices.push({ id: edit.id, number: edit.description, dateAd: edit.dateAd, dateBs: edit.dateBs, total: edit.amount });
      } else {
        receipts.push({ id: edit.id, amount: edit.amount, dateAd: edit.dateAd, dateBs: edit.dateBs, description: edit.description });
      }
    }
  }

  const rebuilt = buildLedger(Number(ledger.totals.openingBalance) || 0, invoices, receipts);
  return { ...ledger, rows: rebuilt.rows, totals: rebuilt.totals };
}

/**
 * The edits needed to REMOVE an entry the caller only knows the id of — the
 * amount and dates come back off the cached row, so a receipt can be deleted
 * offline without the caller having to remember its value.
 */
export function ledgerEditsForRemoval(ledger: LedgerLike | undefined, id: string): LedgerEdit[] {
  if (!ledger || !Array.isArray(ledger.rows)) return [];
  const row = ledger.rows.find((r) => r.id === id);
  if (!row) return [];
  return [
    row.kind === "invoice"
      ? { kind: "invoice", id: row.id, amount: Number(row.debit) || 0, dateAd: row.dateAd, dateBs: row.dateBs, description: row.description.replace(/^Sales invoice\s+/, "") }
      : { kind: "receipt", id: row.id, amount: Number(row.credit) || 0, dateAd: row.dateAd, dateBs: row.dateBs, description: row.description },
  ];
}

/** A customer's due, after applying a receipt delta, rounded like the server does. */
export function dueAfterReceipt(due: number, amount: number, remove: boolean): number {
  const v = (Number(due) || 0) + (remove ? amount : -amount);
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

// ── live GPS tracking rules (pure) ───────────────────────────────────────────
//
// The decisions the driver's tracking loop makes, kept here so they are
// unit-testable without a browser: is this trip one we should be reporting on,
// and is a fix worth sending?

/** How often the driver's device posts a location fix while on a trip. */
export const TRACK_INTERVAL_MS = 30_000;

/**
 * A fix older than this is not worth sending: the driver has moved on, and a
 * burst of stale points would draw a misleading route. Used to drop a fix that
 * was taken while the tab was asleep.
 */
export const TRACK_MAX_FIX_AGE_MS = 5 * 60_000;

/** The order statuses that mean the driver is out with equipment. */
export const TRACKING_STATUSES = ["on_transit", "on_rent"] as const;

export type TrackingStatus = (typeof TRACKING_STATUSES)[number];

/** True when this order status means a trip is in progress. */
export function isTripActive(status: string | null | undefined): status is TrackingStatus {
  return !!status && (TRACKING_STATUSES as readonly string[]).includes(status);
}

/**
 * Should the driver's device be sending pings right now?
 *
 * Tracking runs only while a trip is active AND the driver has granted location
 * permission. A denied permission is a normal state, not an error: the driver
 * keeps working, the card explains why nothing is being sent, and no pings are
 * queued.
 */
export function shouldTrack(trip: { status?: string | null } | null | undefined, permission: string): boolean {
  if (permission !== "granted") return false;
  return isTripActive(trip?.status);
}

/**
 * Is this fix fresh enough to send? A fix taken while the tab was suspended is
 * dropped rather than queued, so the route stays a route and not a jump.
 */
export function isFixFresh(takenAtMs: number, nowMs: number): boolean {
  const age = nowMs - takenAtMs;
  return age >= 0 && age <= TRACK_MAX_FIX_AGE_MS;
}

/**
 * A short, human label for how long ago the last fix arrived — what the owner's
 * map shows next to each marker so a stale position is obvious.
 */
export function freshnessLabel(lastAtMs: number | null | undefined, nowMs: number): string {
  if (!lastAtMs) return "no position yet";
  const secs = Math.max(0, Math.round((nowMs - lastAtMs) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/**
 * A marker is "live" when its last fix is recent enough to trust. Older than
 * this and the map shows it greyed, so the owner is never misled into thinking a
 * parked vehicle is moving.
 */
export const MARKER_LIVE_WINDOW_MS = 3 * 60_000;

export function isMarkerLive(lastAtMs: number | null | undefined, nowMs: number): boolean {
  if (!lastAtMs) return false;
  return nowMs - lastAtMs <= MARKER_LIVE_WINDOW_MS;
}

// ── human-readable labels for the Sync page ──────────────────────────────────

const LABELS: Record<string, string> = {
  "orders.create": "New order",
  "orders.update": "Edit order",
  "orders.approve": "Approve order",
  "orders.reject": "Reject order",
  "orders.lock": "Lock order for dispatch",
  "orders.dispatch": "Dispatch order",
  "orders.return": "Mark order picked up",
  "receipts.create": "Record receipt",
  "receipts.remove": "Delete receipt",
  "customers.create": "New customer",
  "customers.setOpeningBalance": "Set opening balance",
  "assignments.setMine": "Set today's vehicle",
  "equipment.create": "New equipment",
  "equipment.update": "Update equipment",
  "vehicles.create": "New vehicle",
  "drivers.create": "New driver",
  "tracking.ping": "Location update",
};

export function describeAction(path: string, input?: Record<string, unknown>, meta?: Record<string, unknown>): string {
  const base = LABELS[path] ?? path;
  const detail =
    (meta?.customerName as string | undefined) ??
    (input?.customerName as string | undefined) ??
    (input?.name as string | undefined) ??
    (input?.newCustomer as { name?: string } | undefined)?.name;
  return detail ? `${base} — ${detail}` : base;
}
