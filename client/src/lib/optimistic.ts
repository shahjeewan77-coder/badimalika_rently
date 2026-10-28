// ── Optimistic cache patches ──────────────────────────────────────────────────
//
// A status change (lock → dispatch → return) is a round trip. Waiting for it
// before touching the screen is what makes a button feel like it "did not
// respond": the click was registered, the request is in flight, and nothing
// visible happens for a second or more.
//
// So the change is written into the cache IMMEDIATELY, before the request even
// leaves. The server's answer then replaces it on `onSettled` — and if the write
// fails, `onError` restores the snapshot taken here, so a refused action never
// leaves a lie on the screen.
//
// The key-matching helper is deliberately tolerant: tRPC's react-query keys are
// `[pathSegments, { input, type }]`, and reading them by joining the first
// element means this keeps working regardless of the input object, so one patch
// covers every cached variant (every status filter, every list input).

import type { QueryClient } from "@tanstack/react-query";

export interface CacheSnapshot {
  key: readonly unknown[];
  data: unknown;
}

/** True when a react-query key belongs to a tRPC path such as `orders.list`. */
function matchesPath(key: readonly unknown[], path: string): boolean {
  if (!Array.isArray(key) || key.length === 0) return false;
  const first = key[0];
  if (Array.isArray(first)) return first.join(".") === path;
  return first === path;
}

function keysFor(qc: QueryClient, paths: string[]): Array<{ key: readonly unknown[]; data: unknown }> {
  const out: Array<{ key: readonly unknown[]; data: unknown }> = [];
  for (const q of qc.getQueryCache().getAll()) {
    if (paths.some((p) => matchesPath(q.queryKey, p))) {
      out.push({ key: q.queryKey, data: q.state.data });
    }
  }
  return out;
}

/** Everything that a patch is about to change, so it can be put back exactly. */
export function snapshotPaths(qc: QueryClient, paths: string[]): CacheSnapshot[] {
  return keysFor(qc, paths).map(({ key, data }) => ({ key, data }));
}

export function restoreSnapshot(qc: QueryClient, snaps: CacheSnapshot[] | undefined): void {
  if (!snaps) return;
  for (const s of snaps) {
    qc.setQueryData(s.key as never, s.data as never);
  }
}

/**
 * Move an order to `status` in every cached read that shows it.
 *
 * An order that is now `returned` also leaves the On Rent list, because that
 * list is defined as "currently out with a customer" — patching only its status
 * would leave a returned order sitting in On Rent until the refetch lands.
 */
export function patchOrderStatus(qc: QueryClient, orderId: string, status: string): void {
  for (const q of qc.getQueryCache().getAll()) {
    if (matchesPath(q.queryKey, "orders.get")) {
      const detail = q.state.data as { order?: { id?: string; status?: string } } | undefined;
      if (detail?.order) {
        qc.setQueryData(q.queryKey as never, { ...detail, order: { ...detail.order, status } } as never);
      }
      continue;
    }

    if (matchesPath(q.queryKey, "orders.list")) {
      const rows = q.state.data as Array<{ id?: string; status?: string }> | undefined;
      if (Array.isArray(rows)) {
        qc.setQueryData(
          q.queryKey as never,
          rows.map((r) => (r.id === orderId ? { ...r, status } : r)) as never,
        );
      }
      continue;
    }

    if (matchesPath(q.queryKey, "rentals.onRent")) {
      const rows = q.state.data as Array<{ id?: string }> | undefined;
      if (Array.isArray(rows)) {
        qc.setQueryData(
          q.queryKey as never,
          (status === "returned" ? rows.filter((r) => r.id !== orderId) : rows) as never,
        );
      }
    }
  }
}

/** Add one driver position to the cached fleet map, so a ping shows at once. */
export function patchLiveMarker(qc: QueryClient, marker: Record<string, unknown>): void {
  for (const q of qc.getQueryCache().getAll()) {
    if (!matchesPath(q.queryKey, "tracking.live")) continue;
    const data = q.state.data as { markers?: Array<Record<string, unknown>> } | undefined;
    if (!data?.markers) continue;
    const rest = data.markers.filter((m) => m.driverId !== marker.driverId);
    qc.setQueryData(q.queryKey as never, { ...data, markers: [marker, ...rest] } as never);
  }
}
