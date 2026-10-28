// ── App-level driver tracking ──────────────────────────────────────────────
//
// WHAT WAS WRONG
//
// Tracking used to live INSIDE `DriverTrackingCard`, which is rendered only on
// the driver's home screen (`/`). Every effect that watches the position and
// every interval that posts a fix belongs to that component's lifecycle, so the
// moment the driver opened Orders, Stock, a new order, or an order detail —
// which is what a driver actually does while on a trip — the card unmounted,
// `clearWatch` ran and the posting interval was cleared. The driver's position
// silently stopped reaching the server, and the owner's map froze or showed
// nothing at all for a vehicle that was genuinely on transit.
//
// THE FIX
//
// The tracker is now mounted ONCE, above the router, for the whole signed-in
// session. It keeps the single `watchPosition` subscription and the single
// posting interval alive across every route change, and the card on the home
// screen becomes a pure VIEW of this state instead of the owner of it.
//
// Exactly one instance runs, which matters: two instances would open two
// `watchPosition` subscriptions and post each fix twice, drawing a zig-zag.

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { trpc } from "@/_core/trpc";
import { useAccount } from "@/lib/useAccount";
import { useLiveTracking, type LiveTracking } from "@/lib/useLiveTracking";

/** The active trip the driver is on, as the card and the tracker both see it. */
export interface ActiveTrip {
  orderId: string;
  status: string;
  customerName?: string | null;
  customerAddress?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  vehicleName?: string | null;
  vehicleNumber?: string | null;
  orderDateBs?: string | null;
}

export interface TrackingContextValue extends LiveTracking {
  trip: ActiveTrip | null;
  lastPingAt: string | null;
  isDriver: boolean;
  /** False until the driver's trip has been resolved once (avoids a flash). */
  ready: boolean;
}

const TrackingContext = createContext<TrackingContextValue | null>(null);

export function TrackingProvider({ children }: { children: ReactNode }) {
  const { account } = useAccount();
  const isDriver = account?.role === "driver";

  // The driver's own active trip. Polled so the tracker starts on its own when
  // an order is locked for dispatch (the driver does not have to reload), and
  // stops when the trip is returned.
  const tripQuery = trpc.tracking.myTrip.useQuery(undefined, {
    enabled: isDriver,
    refetchInterval: 30_000,
  });

  const trip = (isDriver ? (tripQuery.data?.trip ?? null) : null) as ActiveTrip | null;
  const live = useLiveTracking(trip);

  const value = useMemo<TrackingContextValue>(
    () => ({
      ...live,
      trip,
      lastPingAt: (tripQuery.data?.lastPingAt as string | null | undefined) ?? null,
      isDriver,
      ready: !isDriver || !tripQuery.isLoading,
    }),
    [live, trip, tripQuery.data?.lastPingAt, tripQuery.isLoading, isDriver],
  );

  return <TrackingContext.Provider value={value}>{children}</TrackingContext.Provider>;
}

/**
 * The live tracking state for the signed-in driver.
 *
 * Outside the provider this returns an inert state rather than throwing, so a
 * screen that happens to be rendered in isolation (a test, a preview) does not
 * crash on a missing provider.
 */
export function useTracking(): TrackingContextValue {
  const ctx = useContext(TrackingContext);
  if (ctx) return ctx;
  return {
    trip: null,
    lastPingAt: null,
    isDriver: false,
    ready: true,
    permission: "unknown",
    tracking: false,
    blocked: false,
    lastFix: null,
    lastSentAt: null,
    sentCount: 0,
    queuedCount: 0,
    error: null,
    requestPermission: () => undefined,
  };
}
