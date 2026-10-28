// Shared rental-domain constants (client + server).

export const RENTAL_BASES = ["day", "hour", "pillar"] as const;
export type RentalBasis = (typeof RENTAL_BASES)[number];

export const BASIS_LABELS: Record<RentalBasis, string> = {
  day: "Per Day",
  hour: "Per Hour",
  pillar: "Per Pillar",
};

export const BASIS_UNIT_LABELS: Record<RentalBasis, string> = {
  day: "Days",
  hour: "Hours",
  pillar: "Pillars",
};

export const ORDER_STATUSES = [
  "pending_approval",
  "approved",
  "on_transit",
  "dispatched",
  "on_rent",
  "returned",
  "rejected",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const STATUS_LABELS: Record<OrderStatus, string> = {
  pending_approval: "Pending Approval",
  approved: "Approved",
  on_transit: "On Transit",
  dispatched: "Dispatched",
  on_rent: "On Rent",
  returned: "Returned",
  rejected: "Rejected",
};

// Tailwind classes for status pills.
export const STATUS_STYLES: Record<OrderStatus, string> = {
  pending_approval: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  approved: "bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300",
  on_transit: "bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300",
  dispatched: "bg-cyan-100 text-cyan-800 dark:bg-cyan-500/15 dark:text-cyan-300",
  on_rent: "bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300",
  returned: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  rejected: "bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300",
};

export const USER_ROLE_LABELS: Record<string, string> = {
  owner: "Owner / Admin",
  driver: "Driver",
};

export function formatMoney(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  return "Rs " + v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatQty(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}
