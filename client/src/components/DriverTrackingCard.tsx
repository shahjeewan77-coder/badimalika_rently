// ── Driver tracking card ──────────────────────────────────────────────────────
//
// The driver's own view of live tracking: which trip they are on, whether their
// position is being shared, and — when it is not — exactly why and what to do.
//
// This is a PURE VIEW. The position watch and the posting interval live in
// `TrackingProvider`, mounted above the router, so navigating away from this
// card does not stop the driver being tracked. (It used to: the tracker was
// owned by this component, so opening Orders or a new order on a live trip
// silently killed it.)
//
// It shows NO money and no other driver's data: it is the driver's own trip and
// their own device's status, nothing else.

import { MapPin, Navigation, ShieldAlert, CheckCircle2, Radio, CloudOff } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, Spinner } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/primitives";
import { useTracking, type ActiveTrip } from "@/lib/trackingProvider";
import { freshnessLabel } from "@/lib/offline/registry";

export function DriverTrackingCard() {
  const live = useTracking();
  const active = live.trip as ActiveTrip | null;

  if (!live.ready) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Navigation className="h-4 w-4 text-primary" /> Live tracking
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Spinner />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Navigation className="h-4 w-4 text-primary" /> Live tracking
        </CardTitle>
        {active ? (
          live.tracking ? (
            <Badge tone="success">
              <Radio className="h-3 w-3" /> Sharing
            </Badge>
          ) : (
            <Badge tone="warning">Not sharing</Badge>
          )
        ) : (
          <Badge tone="muted">Idle</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {!active ? (
          <p className="text-sm text-muted-foreground">
            You are not on a trip right now. Your location is shared only while you have an order locked for dispatch, on transit, or on
            rent — it stops automatically when the trip ends.
          </p>
        ) : (
          <>
            <div className="rounded-lg border bg-muted/40 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold">{active.customerName ?? "Customer"}</p>
                <StatusPill status={active.status} />
              </div>
              {active.customerAddress && <p className="text-sm text-muted-foreground">{active.customerAddress}</p>}
              <p className="mt-1 text-xs text-muted-foreground">
                {active.vehicleName ? `${active.vehicleName} (${active.vehicleNumber})` : "No vehicle assigned"}
                {active.orderDateBs ? ` · BS ${active.orderDateBs}` : ""}
              </p>
            </div>

            {live.tracking ? (
              <div className="space-y-2 text-sm">
                <p className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-4 w-4" /> Your position is being shared with the owner.
                </p>
                <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                  <span>Last fix: {live.lastFix ? freshnessLabel(live.lastFix.at, Date.now()) : "waiting…"}</span>
                  <span>Updates sent: {live.sentCount}</span>
                </div>
                {live.queuedCount > 0 && (
                  // A queued fix has NOT reached the owner. Saying so is the whole
                  // point: the driver must never believe they are visible when
                  // they are not.
                  <p className="flex items-start gap-2 rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                    <CloudOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {live.queuedCount} update{live.queuedCount === 1 ? "" : "s"} waiting to upload — they will be sent automatically.
                  </p>
                )}
                {live.lastFix && (
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {live.lastFix.latitude.toFixed(5)}, {live.lastFix.longitude.toFixed(5)}
                    {live.lastFix.accuracy ? ` ±${Math.round(live.lastFix.accuracy)}m` : ""}
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <p className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  {live.permission === "unsupported"
                    ? "This device or browser does not support location sharing."
                    : live.permission === "denied"
                      ? "Location permission is blocked. Allow location access for this site in your browser settings, then try again."
                      : "Location sharing is off. Turn it on so the owner can see where the delivery is."}
                </p>
                {live.permission !== "unsupported" && live.permission !== "denied" && (
                  <Button onClick={live.requestPermission}>
                    <MapPin className="h-4 w-4" /> Share my location
                  </Button>
                )}
              </div>
            )}

            {live.error && <p className="text-xs text-destructive">{live.error}</p>}
            <p className="text-xs text-muted-foreground">
              Updates are sent about every 30 seconds, and keep running while you move between screens. If you lose signal they are stored
              on this device and uploaded automatically when you are back online.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
