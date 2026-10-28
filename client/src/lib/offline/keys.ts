// ── Cache keys + offline call options ────────────────────────────────────────
//
// Kept apart from the links so both the links and the engine can share them
// without an import cycle, and so the key format is testable on its own.

import { queryCacheKey } from "./idb";

export { queryCacheKey };

/** The IndexedDB key for one query. */
export function queryKeyFor(path: string, input: unknown): string {
  return queryCacheKey(path, input);
}

export const CACHE_PREFIXES = {
  orders: "orders.list",
  orderDetail: "orders.get",
  customers: "customers.list",
  customerLedger: "customers.ledger",
  receipts: "receipts.list",
  rentals: "rentals.onRent",
  equipment: "equipment.list",
  movements: "equipment.movements",
  invoices: "invoices.list",
  dashboard: "dashboard.summary",
  vehicles: "vehicles.list",
  drivers: "drivers.list",
  assignmentsMine: "assignments.mine",
  assignmentsForDate: "assignments.forDate",
  account: "account.me",
} as const;

/**
 * Which cached reads are needed to open the app's main screens offline.
 *
 * The offline engine warms these after a successful sync so a session that goes
 * offline mid-shift still has its orders, stock, customers and ledgers readable.
 */
export const WARM_QUERIES: Array<{ path: string; input?: unknown }> = [
  { path: "account.me" },
  { path: "orders.list", input: {} },
  { path: "rentals.onRent" },
  { path: "equipment.list" },
  { path: "customers.list" },
  { path: "receipts.list" },
  { path: "invoices.list" },
  { path: "dashboard.summary" },
  { path: "vehicles.list" },
  { path: "drivers.list" },
  { path: "assignments.mine", input: {} },
  { path: "assignments.forDate", input: {} },
];
