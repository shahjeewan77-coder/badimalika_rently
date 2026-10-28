// ── Stock movement ledger (pure) ─────────────────────────────────────────────
//
// The arithmetic behind the Stock report's Closing Stock column and the
// per-item movement report. Kept pure and shared so the running balance can be
// unit-tested without a database, and so switching a date range on the report
// never needs a round trip.
//
// The identity this file is built on:
//
//   closing = opening + totalIn − totalOut
//
// `opening` is the quantity the business OWNS before any recorded movement —
// i.e. `equipment.totalQty`, which the owner set when the item was added. From
// there every dispatch takes stock out and every return puts it back, so:
//
//   closing = totalQty − (all out) + (all in)
//           = totalQty − onRentQty
//
// …which is exactly the "Available" number used everywhere else in the app.
// `closingOnHand` is supplied by the caller from the stored `onRentQty` so the
// report can PROVE that the ledger agrees with it instead of quietly assuming
// it (`drift` below is 0 when they agree).

export type MovementType = "out" | "in";

export interface LedgerMovement {
  id: string;
  /** YYYY-MM-DD (Gregorian) — the day the movement happened, which is what a
   *  range filter is compared against. */
  dateAd: string;
  /** YYYY-MM-DD (Bikram Sambat), for display. */
  dateBs: string;
  type: MovementType;
  qty: number;
  /** ORD-0007 or null when the order behind the movement was deleted. */
  orderNo: string | null;
  invoiceNo: string | null;
  customerName: string | null;
  /** The driver (or the owner) behind this movement. */
  personName: string | null;
  /** "driver" when a driver is named, "owner" when the fallback is the owner. */
  personRole: "driver" | "owner" | null;
  /** Set when this row REVERSES another movement (an owner undo). The row is a
   *  normal movement in its own right — it just also points at what it undid. */
  reversalOfId?: string | null;
  /** The owner's reason, on a reversal row. */
  note?: string | null;
  createdAt: string;
}

export interface LedgerRow extends LedgerMovement {
  qtyIn: number;
  qtyOut: number;
  /** Stock on hand AFTER this movement. */
  balance: number;
}

export interface MovementReport {
  opening: number;
  rows: LedgerRow[];
  totalIn: number;
  totalOut: number;
  closing: number;
  /** closing computed from ALL movements, ignoring the range. */
  closingAll: number;
  /** closingOnHand (from equipment.onRentQty) − closingAll. 0 when they agree. */
  drift: number;
  movementCount: number;
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** In-branch order: day first, then the moment it was recorded (so two moves on
 *  the same day keep the order they actually happened in). */
export function compareMovements(a: LedgerMovement, b: LedgerMovement): number {
  if (a.dateAd !== b.dateAd) return a.dateAd < b.dateAd ? -1 : 1;
  const at = a.createdAt ?? "";
  const bt = b.createdAt ?? "";
  if (at !== bt) return at < bt ? -1 : 1;
  return 0;
}

/**
 * Build the movement report for one item over an optional [fromAd, toAd] range.
 *
 * When a range is applied the running balance still starts from the true
 * position at the start of that range (`opening`), not from zero — so the last
 * row's balance is the real stock on hand, and `closing` equals it.
 */
export function buildMovementReport(input: {
  /** equipment.totalQty — the baseline the movement log starts from. */
  openingBase: number;
  /** Stock on hand as the rest of the app knows it (totalQty − onRentQty). */
  closingOnHand: number;
  movements: LedgerMovement[];
  fromAd?: string | null;
  toAd?: string | null;
}): MovementReport {
  const base = num(input.openingBase);
  const all = [...input.movements].sort(compareMovements);

  const from = input.fromAd || null;
  const to = input.toAd || null;

  // Everything that happened BEFORE the range is rolled into the opening
  // balance, so the first row of the range continues from real stock — the
  // single most important correctness point of a range-filtered ledger.
  let opening = base;
  let closingAll = base;
  for (const m of all) {
    const delta = m.type === "in" ? num(m.qty) : -num(m.qty);
    closingAll += delta;
    if (from && m.dateAd < from) opening += delta;
  }
  // A range with no lower bound opens at the baseline.
  if (!from) opening = base;

  const rows: LedgerRow[] = [];
  let balance = opening;
  let totalIn = 0;
  let totalOut = 0;

  for (const m of all) {
    if (from && m.dateAd < from) continue;
    if (to && m.dateAd > to) continue;
    const qtyIn = m.type === "in" ? num(m.qty) : 0;
    const qtyOut = m.type === "out" ? num(m.qty) : 0;
    totalIn += qtyIn;
    totalOut += qtyOut;
    balance += qtyIn - qtyOut;
    rows.push({ ...m, qtyIn, qtyOut, balance: round2(balance) });
  }

  const closing = round2(opening + totalIn - totalOut);

  return {
    opening: round2(opening),
    rows,
    totalIn: round2(totalIn),
    totalOut: round2(totalOut),
    closing,
    closingAll: round2(closingAll),
    drift: round2(closingAll - num(input.closingOnHand)),
    movementCount: all.length,
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
