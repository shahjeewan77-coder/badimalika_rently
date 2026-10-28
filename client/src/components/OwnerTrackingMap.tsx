// ── Owner live map ────────────────────────────────────────────────────────────
//
// An interactive map of the fleet, for the owner only. It plots:
//
//   * one marker per driver, at their newest reported position, labelled with
//     the driver, the vehicle and how long ago the fix arrived;
//   * one marker per active delivery site (the customer's coordinates);
//   * optionally, the route taken on one trip, as a polyline.
//
// Clicking a marker opens a popup with the details. The map refreshes itself on
// an interval, so a moving vehicle updates without the owner touching anything.
//
// It is written against the raw Web Mercator projection and OpenStreetMap raster
// tiles rather than a mapping library: the platform installs strictly from the
// lockfile, so a new runtime dependency is not something this app can rely on.
// The maths is the standard slippy-map one — project a lat/lng to world pixels at
// a zoom, subtract the top-left of the viewport, and place the tile images and
// markers at those offsets.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { freshnessLabel, isMarkerLive } from "@/lib/offline/registry";

export interface DriverMarker {
  driverId: string;
  driverName: string | null;
  driverPhone: string | null;
  vehicleName: string | null;
  vehicleNumber: string | null;
  orderStatus: string | null;
  customerName: string | null;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  recordedAt: string | Date;
}

export interface SiteMarker {
  orderId: string;
  customerName: string | null;
  customerAddress: string | null;
  driverName: string | null;
  vehicleName: string | null;
  vehicleNumber: string | null;
  status: string;
  latitude: number;
  longitude: number;
}

export interface RoutePoint {
  latitude: number;
  longitude: number;
  recordedAt: string | Date;
}

interface Props {
  markers: DriverMarker[];
  sites: SiteMarker[];
  route?: RoutePoint[];
  height?: number;
  fallbackCenter?: [number, number];
}

const TILE = 256;
const MIN_Z = 3;
const MAX_Z = 19;
const KATHMANDU: [number, number] = [27.7172, 85.324];

/** Web Mercator: lat/lng → world pixel coordinates at a zoom. */
function project(lat: number, lng: number, z: number) {
  const scale = TILE * 2 ** z;
  const x = ((lng + 180) / 360) * scale;
  const s = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
  return { x, y };
}

/** The inverse: world pixel coordinates at a zoom → lat/lng. */
function unproject(x: number, y: number, z: number) {
  const scale = TILE * 2 ** z;
  const lng = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { lat, lng };
}

/** The largest zoom at which every point fits inside the viewport. */
function fitZoom(points: { latitude: number; longitude: number }[], w: number, h: number): number {
  if (points.length === 0) return 12;
  if (points.length === 1) return 14;
  for (let z = MAX_Z; z >= MIN_Z; z--) {
    const xs = points.map((p) => project(p.latitude, p.longitude, z).x);
    const ys = points.map((p) => project(p.latitude, p.longitude, z).y);
    const dx = Math.max(...xs) - Math.min(...xs);
    const dy = Math.max(...ys) - Math.min(...ys);
    if (dx <= w * 0.8 && dy <= h * 0.8) return z;
  }
  return MIN_Z;
}

/** The centre of a set of points, at a given zoom. */
function centerOf(points: { latitude: number; longitude: number }[], z: number) {
  if (points.length === 0) return { lat: KATHMANDU[0], lng: KATHMANDU[1] };
  const xs = points.map((p) => project(p.latitude, p.longitude, z).x);
  const ys = points.map((p) => project(p.latitude, p.longitude, z).y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  return unproject(cx, cy, z);
}

export function OwnerTrackingMap({ markers, sites, route, height = 420, fallbackCenter = KATHMANDU }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(12);
  const [center, setCenter] = useState({ lat: fallbackCenter[0], lng: fallbackCenter[1] });
  const [selected, setSelected] = useState<string | null>(null);
  const fittedRef = useRef(false);
  const dragRef = useRef<{ x: number; y: number; lat: number; lng: number } | null>(null);

  // Measure the container, and keep measuring as it resizes.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const allPoints = useMemo(
    () => [
      ...markers.map((m) => ({ latitude: m.latitude, longitude: m.longitude })),
      ...sites.map((s) => ({ latitude: s.latitude, longitude: s.longitude })),
    ],
    [markers, sites],
  );

  // Fit the view once, when the first positions arrive — a refresh must not yank
  // the owner's pan/zoom away.
  useEffect(() => {
    if (fittedRef.current || size.w === 0 || allPoints.length === 0) return;
    const z = fitZoom(allPoints, size.w, size.h);
    setZoom(z);
    setCenter(centerOf(allPoints, z));
    fittedRef.current = true;
  }, [allPoints, size.w, size.h]);

  // When a route is selected, frame it.
  useEffect(() => {
    if (!route || route.length < 2 || size.w === 0) return;
    const z = fitZoom(route, size.w, size.h);
    setZoom(z);
    setCenter(centerOf(route, z));
    setSelected(null);
  }, [route, size.w, size.h]);

  const topLeft = useMemo(() => {
    const c = project(center.lat, center.lng, zoom);
    return { x: c.x - size.w / 2, y: c.y - size.h / 2 };
  }, [center, zoom, size.w, size.h]);

  const tiles = useMemo(() => {
    if (size.w === 0) return [];
    const n = 2 ** zoom;
    const startX = Math.floor(topLeft.x / TILE);
    const endX = Math.floor((topLeft.x + size.w) / TILE);
    const startY = Math.floor(topLeft.y / TILE);
    const endY = Math.floor((topLeft.y + size.h) / TILE);
    const out: { key: string; url: string; left: number; top: number }[] = [];
    for (let tx = startX; tx <= endX; tx++) {
      for (let ty = startY; ty <= endY; ty++) {
        if (ty < 0 || ty >= n) continue;
        const wrappedX = ((tx % n) + n) % n;
        out.push({
          key: `${zoom}/${tx}/${ty}`,
          url: `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${ty}.png`,
          left: tx * TILE - topLeft.x,
          top: ty * TILE - topLeft.y,
        });
      }
    }
    return out;
  }, [zoom, topLeft, size.w, size.h]);

  const toScreen = useCallback(
    (lat: number, lng: number) => {
      const p = project(lat, lng, zoom);
      return { x: p.x - topLeft.x, y: p.y - topLeft.y };
    },
    [zoom, topLeft],
  );

  // ── pan ─────────────────────────────────────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, lat: center.lat, lng: center.lng };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const start = project(d.lat, d.lng, zoom);
    const next = unproject(start.x - (e.clientX - d.x), start.y - (e.clientY - d.y), zoom);
    setCenter(next);
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  const zoomBy = (delta: number) => setZoom((z) => Math.min(MAX_Z, Math.max(MIN_Z, z + delta)));

  const fitAll = () => {
    if (allPoints.length === 0) return;
    const z = fitZoom(allPoints, size.w, size.h);
    setZoom(z);
    setCenter(centerOf(allPoints, z));
    setSelected(null);
  };

  const now = Date.now();
  const hasAnything = markers.length > 0 || sites.length > 0 || (route?.length ?? 0) > 0;

  const routePath = useMemo(() => {
    if (!route || route.length < 2) return "";
    return route
      .map((p, i) => {
        const s = toScreen(p.latitude, p.longitude);
        return `${i === 0 ? "M" : "L"}${s.x.toFixed(1)},${s.y.toFixed(1)}`;
      })
      .join(" ");
  }, [route, toScreen]);

  const selectedMarker = markers.find((m) => m.driverId === selected) ?? null;
  const selectedSite = sites.find((s) => s.orderId === selected) ?? null;
  const selectedPos = selectedMarker
    ? toScreen(selectedMarker.latitude, selectedMarker.longitude)
    : selectedSite
      ? toScreen(selectedSite.latitude, selectedSite.longitude)
      : null;

  return (
    <div className="relative overflow-hidden rounded-xl border bg-muted/30" style={{ height }}>
      <div
        ref={containerRef}
        className="h-full w-full cursor-grab touch-none select-none active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        {/* tiles */}
        {tiles.map((t) => (
          <img
            key={t.key}
            src={t.url}
            alt=""
            draggable={false}
            className="pointer-events-none absolute"
            style={{ left: t.left, top: t.top, width: TILE, height: TILE }}
          />
        ))}

        {/* route */}
        {routePath && (
          <svg className="pointer-events-none absolute inset-0 h-full w-full">
            <path d={routePath} fill="none" stroke="#0ea5e9" strokeWidth={4} strokeOpacity={0.85} strokeLinejoin="round" strokeLinecap="round" />
          </svg>
        )}

        {/* delivery sites */}
        {sites.map((s) => {
          const p = toScreen(s.latitude, s.longitude);
          return (
            <button
              key={`site-${s.orderId}`}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setSelected(s.orderId);
              }}
              className="absolute z-10 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md border-2 border-white bg-amber-500 text-[11px] font-bold text-white shadow"
              style={{ left: p.x, top: p.y }}
              title={s.customerName ?? "Delivery site"}
            >
              ▣
            </button>
          );
        })}

        {/* drivers */}
        {markers.map((m) => {
          const p = toScreen(m.latitude, m.longitude);
          const live = isMarkerLive(new Date(m.recordedAt).getTime(), now);
          return (
            <button
              key={`drv-${m.driverId}`}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setSelected(m.driverId);
              }}
              className="absolute z-20 -translate-x-1/2 -translate-y-1/2"
              style={{ left: p.x, top: p.y }}
              title={m.driverName ?? "Driver"}
            >
              <span className="relative flex h-6 w-6 items-center justify-center">
                {live && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-60" />}
                <span
                  className="relative inline-flex h-3.5 w-3.5 rounded-full border-2 border-white shadow"
                  style={{ background: live ? "#0ea5e9" : "#94a3b8" }}
                />
              </span>
            </button>
          );
        })}

        {/* popup */}
        {selectedPos && (selectedMarker || selectedSite) && (
          <div
            className="absolute z-30 w-56 -translate-x-1/2 rounded-lg border bg-card p-3 text-xs shadow-lg"
            style={{ left: selectedPos.x, top: selectedPos.y - 12, transform: "translate(-50%, -100%)" }}
          >
            <button
              type="button"
              className="absolute right-1.5 top-1.5 text-muted-foreground hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                setSelected(null);
              }}
            >
              ✕
            </button>
            {selectedMarker ? (
              <>
                <p className="font-semibold">{selectedMarker.driverName ?? "Driver"}</p>
                <p className="text-muted-foreground">
                  {selectedMarker.vehicleName ?? "No vehicle"}
                  {selectedMarker.vehicleNumber ? ` · ${selectedMarker.vehicleNumber}` : ""}
                </p>
                {selectedMarker.customerName && <p className="text-muted-foreground">Delivering to {selectedMarker.customerName}</p>}
                <p className={isMarkerLive(new Date(selectedMarker.recordedAt).getTime(), now) ? "mt-1 font-semibold text-sky-600" : "mt-1 font-semibold text-muted-foreground"}>
                  {isMarkerLive(new Date(selectedMarker.recordedAt).getTime(), now) ? "● Live" : "○ Last seen"} —{" "}
                  {freshnessLabel(new Date(selectedMarker.recordedAt).getTime(), now)}
                </p>
                {selectedMarker.accuracy != null && (
                  <p className="text-[11px] text-muted-foreground">±{Math.round(selectedMarker.accuracy)} m accuracy</p>
                )}
                {selectedMarker.driverPhone && <p className="text-[11px] text-muted-foreground">{selectedMarker.driverPhone}</p>}
              </>
            ) : selectedSite ? (
              <>
                <p className="font-semibold">{selectedSite.customerName ?? "Delivery site"}</p>
                {selectedSite.customerAddress && <p className="text-muted-foreground">{selectedSite.customerAddress}</p>}
                <p className="text-muted-foreground">
                  {selectedSite.driverName ?? "Unassigned"}
                  {selectedSite.vehicleName ? ` · ${selectedSite.vehicleName}` : ""}
                </p>
                <p className="mt-1 font-semibold text-amber-600">Delivery site</p>
              </>
            ) : null}
          </div>
        )}
      </div>

      {/* controls */}
      <div className="absolute right-3 top-3 z-30 flex flex-col overflow-hidden rounded-lg border bg-card shadow">
        <button type="button" className="h-8 w-8 text-lg leading-none hover:bg-muted" onClick={() => zoomBy(1)} title="Zoom in">
          +
        </button>
        <button type="button" className="h-8 w-8 border-t text-lg leading-none hover:bg-muted" onClick={() => zoomBy(-1)} title="Zoom out">
          −
        </button>
        <button type="button" className="h-8 w-8 border-t text-[10px] font-semibold hover:bg-muted" onClick={fitAll} title="Fit all">
          FIT
        </button>
      </div>

      <div className="pointer-events-none absolute bottom-0 right-0 z-20 bg-card/80 px-1.5 py-0.5 text-[10px] text-muted-foreground">
        © OpenStreetMap
      </div>

      {!hasAnything && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-card/70 p-6 text-center">
          <div className="max-w-sm space-y-1">
            <p className="font-semibold">No positions to show yet</p>
            <p className="text-sm text-muted-foreground">
              Driver markers appear once a driver on an active trip shares their location. Delivery sites appear once a customer has
              coordinates set.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/** A compact legend for the map. */
export function MapLegend() {
  const items = useMemo(
    () => [
      { color: "#0ea5e9", label: "Driver — live" },
      { color: "#94a3b8", label: "Driver — last seen" },
      { color: "#f59e0b", label: "Delivery site" },
    ],
    [],
  );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}
