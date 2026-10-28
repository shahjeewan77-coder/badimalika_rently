// ── Tracking (owner only) ─────────────────────────────────────────────────────
//
// The owner's live view of the fleet: an interactive map of every driver's
// newest position and every active delivery site, plus the route taken on any
// past trip.
//
// Owner-only, enforced twice: the route is wrapped in the owner guard in
// App.tsx, and every procedure it calls is `requireOwner` on the server — so a
// driver can never reach a position, a route, or another driver's data.

import { useState } from "react";
import { useLocation } from "wouter";
import { Navigation, RefreshCw, Route as RouteIcon, Truck, MapPin, Clock } from "lucide-react";
import { trpc } from "@/_core/trpc";
import { AppLayout } from "@/components/AppLayout";
import { PageHeader, Spinner, EmptyState, Badge, Table, THead, TBody, TR, TH, TD } from "@/components/ui/primitives";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { OwnerTrackingMap, MapLegend } from "@/components/OwnerTrackingMap";
import { freshnessLabel, isMarkerLive } from "@/lib/offline/registry";
import { bsDisplay, relativeTime } from "@/lib/format";
import { HOT_POLL_MS, LIVE_POLL_MS, pollWhileOnline } from "@/lib/live";

export default function Tracking() {
  const [, navigate] = useLocation();
  const [selectedTrip, setSelectedTrip] = useState<string | null>(null);

  // The map is the one screen where "a few seconds" is the whole point: a driver's
  // position arrives every ~30s and must appear without anyone pressing
  // Refresh. 5s keeps the marker honest without flooding the server.
  const live = trpc.tracking.live.useQuery(undefined, { refetchInterval: pollWhileOnline(HOT_POLL_MS) });
  const trips = trpc.tracking.trips.useQuery(undefined, {
    refetchInterval: pollWhileOnline(LIVE_POLL_MS),
  });
  const history = trpc.tracking.history.useQuery(
    { orderId: selectedTrip ?? "" },
    { enabled: !!selectedTrip, refetchInterval: pollWhileOnline(LIVE_POLL_MS) },
  );

  const markers = live.data?.markers ?? [];
  const sites = (live.data?.trips ?? [])
    .filter((t) => t.latitude != null && t.longitude != null)
    .map((t) => ({
      orderId: t.orderId,
      customerName: t.customerName,
      customerAddress: t.customerAddress,
      driverName: t.driverName,
      vehicleName: t.vehicleName,
      vehicleNumber: t.vehicleNumber,
      status: t.status,
      latitude: t.latitude as number,
      longitude: t.longitude as number,
    }));

  const route = (history.data?.points ?? []).map((p) => ({
    latitude: p.latitude,
    longitude: p.longitude,
    recordedAt: p.recordedAt,
  }));

  const now = Date.now();

  return (
    <AppLayout>
      <PageHeader
        title="Live tracking"
        subtitle="Where every driver is right now, and the route each trip took."
        actions={
          <Button variant="outline" onClick={() => live.refetch()} disabled={live.isFetching}>
            <RefreshCw className={live.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} /> Refresh
          </Button>
        }
      />

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <Navigation className="h-4 w-4 text-primary" /> Fleet map
          </CardTitle>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            {live.data?.at ? `updated ${relativeTime(live.data.at)}` : "loading…"}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {live.isLoading ? (
            <Spinner />
          ) : (
            <>
              <OwnerTrackingMap markers={markers} sites={sites} route={selectedTrip ? route : undefined} />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <MapLegend />
                {selectedTrip && (
                  <Button variant="ghost" size="sm" onClick={() => setSelectedTrip(null)}>
                    Clear route
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Live drivers */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Truck className="h-4 w-4 text-primary" /> Drivers ({markers.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {markers.length === 0 ? (
              <EmptyState
                icon={<Truck className="h-5 w-5" />}
                title="No driver positions yet"
                description="A driver's position appears here once they are on an active trip and their device shares its location."
              />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Driver</TH>
                    <TH>Vehicle</TH>
                    <TH>Last update</TH>
                  </TR>
                </THead>
                <TBody>
                  {markers.map((m) => {
                    const at = new Date(m.recordedAt).getTime();
                    const isLive = isMarkerLive(at, now);
                    return (
                      <TR key={m.driverId}>
                        <TD className="font-medium">
                          {m.driverName ?? "—"}
                          {m.customerName && <span className="block text-xs text-muted-foreground">→ {m.customerName}</span>}
                        </TD>
                        <TD className="text-muted-foreground">
                          {m.vehicleName ? `${m.vehicleName} (${m.vehicleNumber})` : "—"}
                        </TD>
                        <TD>
                          <Badge tone={isLive ? "success" : "muted"}>{freshnessLabel(at, now)}</Badge>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Active deliveries */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MapPin className="h-4 w-4 text-primary" /> Active deliveries ({(live.data?.trips ?? []).length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {(live.data?.trips ?? []).length === 0 ? (
              <EmptyState
                icon={<MapPin className="h-5 w-5" />}
                title="Nothing on the road"
                description="Orders that are on transit or on rent appear here with their delivery site."
              />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Customer</TH>
                    <TH>Driver</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {(live.data?.trips ?? []).map((t) => (
                    <TR key={t.orderId} className="cursor-pointer" onClick={() => navigate(`/orders/${t.orderId}`)}>
                      <TD className="font-medium">
                        {t.customerName ?? "—"}
                        {t.latitude == null && <span className="block text-xs text-amber-600 dark:text-amber-400">no site coordinates</span>}
                      </TD>
                      <TD className="text-muted-foreground">{t.driverName ?? "Unassigned"}</TD>
                      <TD>
                        <Badge tone={t.status === "on_rent" ? "accent" : "info"}>{t.status === "on_rent" ? "On rent" : "On transit"}</Badge>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Trip route history */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <RouteIcon className="h-4 w-4 text-primary" /> Trip history
          </CardTitle>
          <p className="text-sm text-muted-foreground">Pick a trip to draw the route it took on the map above.</p>
        </CardHeader>
        <CardContent>
          {trips.isLoading ? (
            <Spinner />
          ) : (trips.data ?? []).length === 0 ? (
            <EmptyState
              icon={<RouteIcon className="h-5 w-5" />}
              title="No routes recorded yet"
              description="Once a driver shares their location on a trip, the route is kept here so you can see where the vehicle went."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Customer</TH>
                  <TH>Driver</TH>
                  <TH>Vehicle</TH>
                  <TH>Date (BS)</TH>
                  <TH className="text-right">Points</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {(trips.data ?? []).map((t) => (
                  <TR key={t.orderId ?? "unknown"}>
                    <TD className="font-medium">{t.customerName ?? "—"}</TD>
                    <TD className="text-muted-foreground">{t.driverName ?? "—"}</TD>
                    <TD className="text-muted-foreground">{t.vehicleName ? `${t.vehicleName} (${t.vehicleNumber})` : "—"}</TD>
                    <TD className="text-muted-foreground">{t.orderDateBs ? `BS ${t.orderDateBs}` : bsDisplay(null)}</TD>
                    <TD className="text-right tabular-nums">{t.points}</TD>
                    <TD className="text-right">
                      <Button
                        variant={selectedTrip === t.orderId ? "default" : "outline"}
                        size="sm"
                        disabled={!t.orderId}
                        onClick={() => setSelectedTrip(t.orderId ?? null)}
                      >
                        <RouteIcon className="h-4 w-4" /> {selectedTrip === t.orderId ? "Showing" : "Show route"}
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </AppLayout>
  );
}
