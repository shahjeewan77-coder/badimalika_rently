// ── Offline outbox engine ────────────────────────────────────────────────────
//
// Two jobs:
//
//   1. Queue a write locally (IndexedDB) and apply it optimistically to every
//      cached read it affects — so the user sees their own change immediately.
//   2. Flush the queue, in order, when the connection returns: substitute local
//      ids for the real ones the server handed back, call the procedure, apply
//      the server's answer to the same cache entries, and log anything that
//      could not be applied as a conflict instead of losing it.
//
// The optimistic patch and the post-flush patch go through the SAME code path,
// so "what the user saw offline" and "what the server confirmed" can never drift
// apart in the UI.

import { adIsoToBs, bsIso, kathmanduToday } from "@shared/bs-calendar";
import type { OrderStatus } from "@shared/rental";
import {
  STORE_CACHE,
  STORE_OUTBOX,
  cacheDel,
  idbAll,
  idbDel,
  idbPut,
  idbKeys,
  queryCacheKey,
} from "./idb";
// Every read and write of the query cache goes through the wrapped form, so a
// cached value is stored and unwrapped the same way everywhere (see idb.ts).
import { cacheGetQuery as cacheGet, cacheSetQuery as cacheSet } from "./idb";
import { setState } from "./store";
import { setIdAlias } from "./aliases";
import {
  type PatchContext,
  type RefIdMap,
  bumpSummary,
  classifyFlushError,
  conflictPolicy,
  describeAction,
  dueAfterReceipt,
  hasUnresolvedRefs,
  ledgerEditsForRemoval,
  makeLocalId,
  newOrderRow,
  newReceiptRow,
  optimisticItems,
  patchLedgerEntries,
  sortOrders,
  statusFilterOf,
  substituteRefs,
  summaryKeyFor,
  type OrderedOrderRow,
} from "./registry";

export interface OutboxAction {
  id: string;
  seq: number;
  /** The id this action's result should be registered under (its local id). */
  localId: string;
  path: string;
  input: Record<string, unknown>;
  meta: Record<string, unknown>;
  createdAt: string;
  dateAd: string;
  dateBs: string;
  attempts: number;
  lastError?: string | null;
  lastErrorCode?: string | null;
}

export interface ConflictRecord {
  id: string;
  path: string;
  description: string;
  message: string;
  code: string | null;
  at: string;
  policy: "server" | "client";
  input: Record<string, unknown>;
}

const CONFLICTS_KEY = "conflicts";

// ── queue ────────────────────────────────────────────────────────────────────

export async function listOutbox(): Promise<OutboxAction[]> {
  try {
    const rows = await idbAll<OutboxAction>(STORE_OUTBOX);
    return rows.sort((a, b) => a.seq - b.seq);
  } catch {
    return [];
  }
}

export async function outboxCount(): Promise<number> {
  return (await listOutbox()).length;
}

async function nextSeq(): Promise<number> {
  const keys = await idbKeys(STORE_OUTBOX).catch(() => [] as IDBValidKey[]);
  return keys.length === 0 ? 1 : Date.now();
}

/** Add one action to the queue and return it. */
export async function enqueue(
  path: string,
  input: Record<string, unknown>,
  meta: Record<string, unknown> = {},
): Promise<OutboxAction> {
  const today = kathmanduToday();
  const localId = (meta.localId as string | undefined) ?? makeLocalId();
  const action: OutboxAction = {
    id: crypto.randomUUID(),
    seq: await nextSeq(),
    localId,
    path,
    input,
    meta,
    createdAt: new Date().toISOString(),
    dateAd: today.ad,
    dateBs: today.bsIso,
    attempts: 0,
    lastError: null,
    lastErrorCode: null,
  };
  await idbPut(STORE_OUTBOX, action as unknown as { id: string } & Record<string, unknown>);
  // Tell the app immediately, so the banner shows the queued write and the
  // retry loop knows there is something to drain.
  await publishCounts();
  return action;
}

export async function dropAction(id: string): Promise<void> {
  await idbDel(STORE_OUTBOX, id).catch(() => undefined);
}

/**
 * Push the real queue length into the shared state.
 *
 * The store's `pending` count is what the retry loop reads to decide whether
 * anything needs draining, and what the banner shows. It used to be recomputed
 * only on sign-in and after a sync — so a write queued mid-session (a request
 * that died while the app still believed it was online) left `pending` at 0, the
 * retry loop saw nothing to do, and the write sat in IndexedDB until the next
 * reload. Publishing on every queue change is what makes a stranded write
 * visible to the very loop meant to drain it.
 */
async function publishCounts(): Promise<void> {
  try {
    const [rows, conflicts] = await Promise.all([listOutbox(), listConflicts()]);
    setState({ pending: rows.length, conflicts: conflicts.length });
  } catch {
    /* counts are advisory; never fail a write over them */
  }
}

async function recordAttempt(id: string, error: string, code: string | null): Promise<void> {
  const row = (await idbAll<OutboxAction>(STORE_OUTBOX).catch(() => [])).find((a) => a.id === id);
  if (!row) return;
  await idbPut(STORE_OUTBOX, { ...row, attempts: row.attempts + 1, lastError: error, lastErrorCode: code } as unknown as { id: string } & Record<string, unknown>).catch(() => undefined);
}

// ── conflicts ────────────────────────────────────────────────────────────────

export async function listConflicts(): Promise<ConflictRecord[]> {
  const rows = await cacheGet<ConflictRecord[]>(CONFLICTS_KEY).catch(() => undefined);
  return rows ?? [];
}

async function addConflict(action: OutboxAction, message: string, code: string | null): Promise<void> {
  const existing = await listConflicts();
  const next: ConflictRecord[] = [
    {
      id: action.id,
      path: action.path,
      description: describeAction(action.path, action.input, action.meta),
      message,
      code,
      at: new Date().toISOString(),
      policy: conflictPolicy(action.path),
      input: action.input,
    },
    ...existing,
  ].slice(0, 50);
  await cacheSet(CONFLICTS_KEY, next).catch(() => undefined);
}

export async function dismissConflict(id: string): Promise<void> {
  const remaining = (await listConflicts()).filter((c) => c.id !== id);
  await cacheSet(CONFLICTS_KEY, remaining).catch(() => undefined);
  await publishCounts();
}

export async function clearConflicts(): Promise<void> {
  await cacheDel(CONFLICTS_KEY).catch(() => undefined);
}

// ── optimistic / confirmed patching ──────────────────────────────────────────

interface CachedEntry {
  key: string;
  value: unknown;
}

/** Every cached value whose key starts with one of `prefixes`. */
async function entriesFor(prefixes: string[]): Promise<CachedEntry[]> {
  const keys = await idbKeys(STORE_CACHE).catch(() => [] as IDBValidKey[]);
  const wanted = keys.map((k: IDBValidKey) => String(k)).filter((k) => prefixes.some((p) => k.startsWith(p)));
  const out: CachedEntry[] = [];
  for (const key of wanted) {
    const value = await cacheGet(key).catch(() => undefined);
    if (value !== undefined) out.push({ key, value });
  }
  return out;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? (value as unknown[]) : null;
}

/** Names for optimistic rows, read from the cached lists. */
export async function buildLookups(): Promise<PatchContext["lookups"]> {
  const equipment = new Map<string, { name: string; code: string | null; unit: string }>();
  const customers = new Map<string, string>();

  for (const { value } of await entriesFor(["equipment.list"])) {
    const rows = asArray(value) as Array<{ id: string; name: string; code: string | null; unit: string }> | null;
    for (const r of rows ?? []) equipment.set(r.id, { name: r.name, code: r.code, unit: r.unit });
  }
  for (const { value } of await entriesFor(["customers.list"])) {
    const rows = asArray(value) as Array<{ id: string; name: string }> | null;
    for (const r of rows ?? []) customers.set(r.id, r.name);
  }
  return { equipment, customers };
}

/** Apply one action to every cached read it changes. */
export async function applyAction(action: OutboxAction, result: Record<string, unknown> | null): Promise<void> {
  const lookups = await buildLookups();
  const ctx: PatchContext = {
    localId: action.localId,
    nowIso: action.createdAt,
    dateAd: action.dateAd,
    dateBs: action.dateBs,
    userId: String(action.meta.userId ?? ""),
    role: (action.meta.role as "owner" | "driver") ?? "owner",
    driverId: (action.meta.driverId as string | null) ?? null,
    driverName: (action.meta.driverName as string | null) ?? null,
    input: action.input,
    result,
    meta: action.meta,
    lookups,
  };
  const path = action.path;

  if (path === "orders.create") return applyOrderCreate(ctx);
  if (path.startsWith("orders.")) return applyOrderTransition(path, ctx);
  if (path.startsWith("receipts.")) return applyReceipt(path, ctx);
  if (path === "customers.create") return applyCustomerCreate(ctx);
  if (path === "customers.setOpeningBalance") return applyOpeningBalance(ctx);
  if (path === "assignments.setMine") return applyAssignment(ctx);
  if (path === "equipment.create" || path === "equipment.update") return applyEquipment(path, ctx);
  if (path === "vehicles.create") return applySimpleAppend("vehicles.list", ctx, vehicleRow(ctx));
  if (path === "drivers.create") return applySimpleAppend("drivers.list", ctx, driverRow(ctx));
}

function vehicleRow(ctx: PatchContext) {
  return { id: ctx.result?.id ?? ctx.localId, name: String(ctx.input.name ?? ""), number: String(ctx.input.number ?? ""), type: (ctx.input.type as string) ?? null, pendingSync: !ctx.result };
}

function driverRow(ctx: PatchContext) {
  return { id: ctx.result?.id ?? ctx.localId, name: String(ctx.input.name ?? ""), phone: (ctx.input.phone as string) ?? null, licenseNo: (ctx.input.licenseNo as string) ?? null, userId: null, pendingSync: !ctx.result };
}

async function applyOrderCreate(ctx: PatchContext): Promise<void> {
  const confirmedId = ctx.result ? String(ctx.result.id ?? ctx.localId) : null;
  const row = newOrderRow(ctx);
  if (confirmedId) {
    row.id = confirmedId;
    row.pendingSync = false;
  }

  // Insert into every cached order list. On the post-flush pass the same helper
  // runs again with the server's id, so the row is consolidated under one key
  // rather than left duplicated under the local id.
  for (const { key, value } of await entriesFor(["orders.list"])) {
    const kept = ((asArray(value) ?? []) as OrderedOrderRow[]).filter(
      (r) => r.id !== ctx.localId && r.id !== confirmedId,
    );
    await cacheSet(key, sortOrders([row, ...kept])).catch(() => undefined);
  }

  // The dashboard's pending counter moves once, at ENQUEUE time. On the
  // post-flush pass it is already counted, so bumping again would double it.
  if (!confirmedId) {
    for (const { key, value } of await entriesFor(["dashboard.summary"])) {
      await cacheSet(key, bumpSummary(value as never, "pending", 1)).catch(() => undefined);
    }
  }

  // A warm detail entry so the order can be opened offline — under the local id
  // while queued, and under the real id once the server has assigned one.
  const detail = {
    order: { ...row, approvedAt: null, dispatchedAt: null, customerPhone: null, customerAddress: null },
    items: optimisticItems(ctx).map((i) => ({ ...i, pendingSync: !ctx.result })),
    invoice: null,
    pendingSync: !ctx.result,
  };
  await cacheSet(queryCacheKey("orders.get", { id: row.id }), detail).catch(() => undefined);
  if (confirmedId && confirmedId !== ctx.localId) {
    await cacheDel(queryCacheKey("orders.get", { id: ctx.localId })).catch(() => undefined);
  }
}

const NEXT_STATUS: Partial<Record<string, OrderStatus>> = {
  "orders.approve": "approved",
  "orders.reject": "rejected",
  "orders.lock": "on_transit",
  "orders.dispatch": "on_rent",
  "orders.return": "returned",
};

async function applyOrderTransition(path: string, ctx: PatchContext): Promise<void> {
  const id = String(ctx.input.id ?? "");
  if (path === "orders.update") return applyOrderHeaderEdit(ctx, id);

  const next = NEXT_STATUS[path];
  if (!next) return;

  // Before the flush the action only knows the local id; afterwards the server's
  // id comes back, so both are treated as the same record.
  const realId = String(ctx.result?.id ?? id);
  const ids = new Set([id, realId]);
  let from: OrderStatus | null = null;

  for (const { key, value } of await entriesFor(["orders.list"])) {
    const rows = (asArray(value) ?? []) as Array<{ id: string; status?: OrderStatus }>;
    const filter = statusFilterOf(key);
    const out: Array<Record<string, unknown>> = [];
    for (const r of rows) {
      if (!ids.has(r.id)) {
        out.push(r as unknown as Record<string, unknown>);
        continue;
      }
      from = r.status ?? from;
      // A filtered view (?status=pending_approval) must lose a row that no
      // longer matches it — otherwise approving an order leaves it sitting in
      // the "Pending approval" list until the next refresh.
      if (filter && filter !== next) continue;
      out.push({
        ...r,
        status: next,
        pendingSync: !ctx.result,
        ...(path === "orders.lock" ? { lockedByDriverId: ctx.driverId } : {}),
      });
    }
    await cacheSet(key, out).catch(() => undefined);
  }

  // One pipeline counter out, one in — never counted twice, whichever view
  // happened to contain the row.
  if (from && from !== next) {
    for (const { key, value } of await entriesFor(["dashboard.summary"])) {
      const movedOut = bumpSummary(value as never, summaryKeyFor(from), -1);
      await cacheSet(key, bumpSummary(movedOut as never, summaryKeyFor(next), 1)).catch(() => undefined);
    }
  }

  // The order's own page keeps up, under whichever id it is cached by.
  for (const detailId of ids) {
    const detailKey = queryCacheKey("orders.get", { id: detailId });
    const detail = await cacheGet<{ order?: Record<string, unknown> }>(detailKey).catch(() => undefined);
    if (detail?.order) {
      await cacheSet(detailKey, {
        ...detail,
        order: { ...detail.order, status: next, pendingSync: !ctx.result },
      }).catch(() => undefined);
    }
  }
  if (realId !== id) await cacheDel(queryCacheKey("orders.get", { id })).catch(() => undefined);

  // On Rent list.
  if (path === "orders.dispatch" || path === "orders.return") {
    // A dispatch mints the sales invoice, so the customer's ledger gains a debit.
    if (path === "orders.dispatch") await applyDispatchLedger(ctx, realId);
    for (const { key, value } of await entriesFor(["rentals.onRent"])) {
      const rows = (asArray(value) ?? []) as Array<Record<string, unknown>>;
      if (path === "orders.return") {
        await cacheSet(key, rows.filter((r) => r.id !== realId && r.id !== id)).catch(() => undefined);
      } else if (!rows.some((r) => r.id === realId)) {
        const detail = (await cacheGet<{ order: Record<string, unknown> }>(
          queryCacheKey("orders.get", { id: realId }),
        ).catch(() => undefined)) ?? { order: {} };
        await cacheSet(key, [{ ...(detail.order ?? {}), id: realId, pendingSync: !ctx.result }, ...rows]).catch(() => undefined);
      }
    }
  }
}

async function applyOrderHeaderEdit(ctx: PatchContext, id: string): Promise<void> {
  const realId = String(ctx.result?.id ?? id);
  const ids = new Set([id, realId]);
  const patch = {
    ...(ctx.input.customerId ? { customerId: String(ctx.input.customerId) } : {}),
    ...(ctx.input.orderDateAd ? { orderDateAd: String(ctx.input.orderDateAd) } : {}),
    driverId: (ctx.input.driverId as string | null) ?? null,
    vehicleId: (ctx.input.vehicleId as string | null) ?? null,
    notes: (ctx.input.notes as string | null) ?? null,
  };
  for (const { key, value } of await entriesFor(["orders.list"])) {
    const rows = (asArray(value) ?? []) as Array<Record<string, unknown>>;
    await cacheSet(
      key,
      rows.map((r) => (ids.has(String(r.id)) ? { ...r, ...patch, pendingSync: !ctx.result } : r)),
    ).catch(() => undefined);
  }
  for (const detailId of ids) {
    const detailKey = queryCacheKey("orders.get", { id: detailId });
    const detail = await cacheGet<{ order?: Record<string, unknown>; items?: unknown[] }>(detailKey).catch(() => undefined);
    if (!detail?.order) continue;
    await cacheSet(detailKey, {
      ...detail,
      order: { ...detail.order, ...patch, pendingSync: !ctx.result },
      items: (ctx.input.items as unknown[]) ?? detail.items,
    }).catch(() => undefined);
  }
}

/** The invoice a dispatch creates shows up in the affected customer's ledger. */
async function applyDispatchLedger(ctx: PatchContext, orderId: string): Promise<void> {
  const detail = await cacheGet<{ order?: { customerId?: string; customerName?: string }; invoice?: { invoiceNo?: string; total?: number } }>(
    queryCacheKey("orders.get", { id: orderId }),
  ).catch(() => undefined);
  const customerId = detail?.order?.customerId;
  if (!customerId) return;
  const invoice = ctx.result?.invoice as { id?: string; invoiceNo?: string; total?: number; invoiceDateAd?: string; invoiceDateBs?: string } | undefined;
  const amount = Number(invoice?.total ?? detail?.invoice?.total ?? 0);
  if (!amount) return;

  const edit = {
    kind: "invoice" as const,
    id: String(invoice?.id ?? `dispatch-${orderId}`),
    amount,
    dateAd: invoice?.invoiceDateAd ?? ctx.dateAd,
    dateBs: invoice?.invoiceDateBs ?? ctx.dateBs,
    description: invoice?.invoiceNo ?? "Sales invoice",
  };
  for (const { key, value } of await entriesFor(["customers.ledger"])) {
    const ledger = value as { customer?: { id?: string } } | undefined;
    if (ledger?.customer?.id && ledger.customer.id !== customerId) continue;
    await cacheSet(key, patchLedgerEntries(value as never, [edit], false)).catch(() => undefined);
  }
  for (const { key, value } of await entriesFor(["customers.list"])) {
    const rows = (asArray(value) ?? []) as Array<Record<string, unknown>>;
    await cacheSet(key, rows.map((r) => (r.id === customerId ? { ...r, due: dueAfterReceipt(Number(r.due ?? 0), -amount, false) } : r))).catch(() => undefined);
  }
}

async function applyReceipt(path: string, ctx: PatchContext): Promise<void> {
  const remove = path === "receipts.remove";
  // After a flush the server's id is known; both it and the local id stand for
  // the same receipt, so a row cached under either is consolidated.
  const receiptId = remove ? String(ctx.input.id ?? "") : ctx.result ? String(ctx.result.id ?? ctx.localId) : ctx.localId;
  const staleIds = new Set([receiptId, ctx.localId]);
  const amount = remove ? Number((ctx.input.amount as number) ?? 0) : Number(ctx.input.amount ?? 0);
  const customerId = String(ctx.input.customerId ?? "");
  const dateAd = (ctx.input.dateAd as string) ?? ctx.dateAd;

  // Receipt list.
  for (const { key, value } of await entriesFor(["receipts.list"])) {
    const rows = (asArray(value) ?? []) as Array<Record<string, unknown>>;
    if (remove) {
      await cacheSet(key, rows.filter((r) => !staleIds.has(String(r.id)))).catch(() => undefined);
    } else {
      const row = ctx.result ? { ...ctx.result, pendingSync: false } : newReceiptRow({ ...ctx, localId: receiptId });
      await cacheSet(key, [row, ...rows.filter((r) => !staleIds.has(String(r.id)))]).catch(() => undefined);
    }
  }

  // Customer list dues — a receipt reduces what the customer owes.
  for (const { key, value } of await entriesFor(["customers.list"])) {
    const rows = (asArray(value) ?? []) as Array<Record<string, unknown>>;
    await cacheSet(
      key,
      rows.map((r) => (r.id === customerId ? { ...r, due: dueAfterReceipt(Number(r.due ?? 0), amount, remove) } : r)),
    ).catch(() => undefined);
  }

  // Dashboard "customer dues" total.
  for (const { key, value } of await entriesFor(["dashboard.summary"])) {
    const s = value as { dues?: { total?: number; hidden?: boolean } };
    if (!s?.dues || s.dues.hidden) continue;
    await cacheSet(key, {
      ...s,
      dues: { ...s.dues, total: dueAfterReceipt(Number(s.dues.total ?? 0), amount, remove) },
    }).catch(() => undefined);
  }

  // The customer's own ledger, rebuilt through the same pure helper the server
  // uses — so the running balance shown offline is the real one.
  for (const { key, value } of await entriesFor(["customers.ledger"])) {
    const ledger = value as { customer?: { id?: string } } | undefined;
    if (ledger?.customer?.id && ledger.customer.id !== customerId) continue;
    const edits = remove
      ? ledgerEditsForRemoval(value as never, receiptId)
      : [
          {
            kind: "receipt" as const,
            id: receiptId,
            amount,
            dateAd,
            dateBs: (ctx.input.dateBs as string) ?? bsIso(adIsoToBs(dateAd)),
            description: `Receipt${ctx.input.referenceNo ? ` \u2014 ${String(ctx.input.referenceNo)}` : ""} (${String(ctx.input.mode ?? "cash")})`,
          },
        ];
    if (edits.length === 0) continue;
    await cacheSet(key, patchLedgerEntries(value as never, edits, remove)).catch(() => undefined);
  }
}

async function applyCustomerCreate(ctx: PatchContext): Promise<void> {
  const row = {
    id: ctx.result?.id ?? ctx.localId,
    name: String(ctx.input.name ?? ""),
    phone: (ctx.input.phone as string) ?? null,
    address: (ctx.input.address as string) ?? null,
    openingBalance: Number(ctx.input.openingBalance ?? 0),
    due: ctx.role === "owner" ? Number(ctx.input.openingBalance ?? 0) : 0,
    moneyHidden: ctx.role !== "owner",
    pendingSync: !ctx.result,
  };
  await applySimpleAppend("customers.list", ctx, row);
}

async function applyOpeningBalance(ctx: PatchContext): Promise<void> {
  const customerId = String(ctx.input.customerId ?? "");
  const opening = Number(ctx.input.openingBalance ?? 0);
  const delta = Number(((ctx.meta.previousOpening as number) ?? 0));
  for (const { key, value } of await entriesFor(["customers.list"])) {
    const rows = (asArray(value) ?? []) as Array<Record<string, unknown>>;
    await cacheSet(
      key,
      rows.map((r) =>
        r.id === customerId
          ? { ...r, openingBalance: opening, due: dueAfterReceipt(Number(r.due ?? 0), opening - delta, false) }
          : r,
      ),
    ).catch(() => undefined);
  }
}

async function applyAssignment(ctx: PatchContext): Promise<void> {
  const vehicleId = String(ctx.input.vehicleId ?? "");
  const realId = ctx.result ? String(ctx.result.id ?? ctx.localId) : ctx.localId;
  const dateAd = (ctx.input.dateAd as string) ?? ctx.dateAd;
  const dateBs = dateAd === ctx.dateAd ? ctx.dateBs : bsIso(adIsoToBs(dateAd));
  const vehicleName = (ctx.meta.vehicleName as string | null) ?? null;
  const vehicleNumber = (ctx.meta.vehicleNumber as string | null) ?? null;

  for (const { key, value } of await entriesFor(["assignments.mine"])) {
    const id = String((value as { id?: string } | null)?.id ?? "");
    await cacheSet(key, {
      ...(value ?? {}),
      id: id || ctx.localId,
      driverId: ctx.driverId,
      vehicleId,
      vehicleName,
      vehicleNumber,
      dateAd,
      dateBs,
      pendingSync: !ctx.result,
    }).catch(() => undefined);
  }

  for (const { key, value } of await entriesFor(["assignments.forDate"])) {
    const rows = (asArray(value) ?? []) as Array<Record<string, unknown>>;
    const others = rows.filter((r) => r.driverId !== ctx.driverId);
    await cacheSet(key, [
      ...others,
      { id: realId, driverId: ctx.driverId, driverName: ctx.driverName, vehicleId, vehicleName, vehicleNumber, dateAd, dateBs, pendingSync: !ctx.result },
    ]).catch(() => undefined);
  }
}

async function applyEquipment(path: string, ctx: PatchContext): Promise<void> {
  for (const { key, value } of await entriesFor(["equipment.list"])) {
    const rows = (asArray(value) ?? []) as Array<Record<string, unknown>>;
    if (path === "equipment.update") {
      const id = String(ctx.input.id ?? "");
      await cacheSet(
        key,
        rows.map((r) => (r.id === id ? { ...r, ...ctx.input, pendingSync: !ctx.result } : r)),
      ).catch(() => undefined);
    } else {
      const row = {
        id: ctx.result?.id ?? ctx.localId,
        name: String(ctx.input.name ?? ""),
        code: (ctx.input.code as string) ?? null,
        unit: (ctx.input.unit as string) ?? "pcs",
        totalQty: Number(ctx.input.totalQty ?? 0),
        onRentQty: 0,
        pendingSync: !ctx.result,
      };
      await cacheSet(key, [row, ...rows.filter((r) => r.id !== row.id)]).catch(() => undefined);
    }
  }
}

async function applySimpleAppend(prefix: string, _ctx: PatchContext, row: Record<string, unknown>): Promise<void> {
  for (const { key, value } of await entriesFor([prefix])) {
    const rows = (asArray(value) ?? []) as Array<Record<string, unknown>>;
    await cacheSet(key, [row, ...rows.filter((r) => r.id !== row.id)]).catch(() => undefined);
  }
}

// ── flush ────────────────────────────────────────────────────────────────────

export interface FlushOutcome {
  sent: number;
  /**
   * Actions the server reported as ALREADY in the intended state.
   *
   * Counted apart from `sent` so the banner can say "already up to date" rather
   * than claiming work was just uploaded, but deliberately NOT counted in
   * `conflicts`: the change the user made is live on the server. Treating a
   * replay as a failure was the false "some changes may not be applied" alarm.
   */
  already: number;
  conflicts: number;
  retried: number;
  /** Ids that changed on the server, so the caller can refresh what is on screen. */
  touchedPaths: string[];
}

/**
 * Replay the queue in order.
 *
 * Stops at the first action that cannot be sent right now (a dropped connection,
 * or an unresolved dependency) and leaves it — and everything after it — queued.
 * Order is preserved, which is what makes an order queued behind the customer it
 * references resolve correctly.
 */
export async function flush(
  call: (path: string, input: unknown) => Promise<unknown>,
  opts: { userId: string | null } = { userId: null },
): Promise<FlushOutcome> {
  const actions = await listOutbox();
  const idMap: RefIdMap = {};
  const outcome: FlushOutcome = { sent: 0, already: 0, conflicts: 0, retried: 0, touchedPaths: [] };

  for (const action of actions) {
    if (opts.userId && action.meta.userId && action.meta.userId !== opts.userId) {
      // A queued write belonging to a different account: leave it queued rather
      // than sending it as whoever is signed in now.
      outcome.retried += 1;
      continue;
    }
    if (hasUnresolvedRefs(action.input, idMap)) {
      outcome.retried += 1;
      continue;
    }

    const input = substituteRefs(action.input, idMap) as Record<string, unknown>;
    try {
      const result = (await call(action.path, input)) as Record<string, unknown> | null;
      if (result && typeof result === "object" && typeof result.id === "string") {
        idMap[action.localId] = result.id;
        // Remember the mapping so a bookmarked link to the offline-created
        // record still resolves now that it exists on the server.
        await setIdAlias(action.localId, result.id);
      }
      await applyAction({ ...action, input }, result ?? null);
      await dropAction(action.id);
      outcome.sent += 1;
      if (result?.alreadyApplied === true) outcome.already += 1;
      outcome.touchedPaths.push(action.path);
    } catch (err) {
      const code = errorCode(err);
      const verdict = classifyFlushError(code, httpStatus(err));
      const message = err instanceof Error ? err.message : String(err);

      if (verdict === "retry") {
        await recordAttempt(action.id, message, code);
        outcome.retried += 1;
        break; // connection is down again — keep the rest of the queue intact
      }

      // Conflict: logged, not lost. The server's version wins for anything the
      // server guards, so the action leaves the queue and the caches are left
      // alone — the caller refetches and the user sees the real state.
      await addConflict(action, message, code);
      await dropAction(action.id);
      outcome.conflicts += 1;
      outcome.touchedPaths.push(action.path);
    }
  }

  return outcome;
}

function errorCode(err: unknown): string | null {
  const e = err as { shape?: { data?: { code?: string } }; data?: { code?: string } };
  return e?.shape?.data?.code ?? e?.data?.code ?? null;
}

function httpStatus(err: unknown): number | null {
  const e = err as { shape?: { data?: { httpStatus?: number } }; data?: { httpStatus?: number } };
  return e?.shape?.data?.httpStatus ?? e?.data?.httpStatus ?? null;
}
