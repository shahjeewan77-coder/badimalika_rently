// ── Driver live tracking ──────────────────────────────────────────────────────
//
// The driver's side of GPS tracking. While the driver has an ACTIVE trip (an
// order locked for dispatch, on transit, or on rent) this hook:
//
//   * watches the device's position with the browser Geolocation API,
//   * posts a fix to the server every TRACK_INTERVAL_MS (~30s), and immediately
//     when the first fix of a trip arrives,
//   * stops the moment the trip ends or the component unmounts.
//
// It is deliberately built on the app's normal tRPC mutation, so a fix taken
// with no connection goes into the SAME offline outbox as every other write and
// is replayed when the connection returns — no separate sync path to keep
// correct. The server still refuses a ping from a driver with no active trip,
// which is what stops a stale queue reporting a position after the trip ended.
//
// Permission denial is a normal state, not an error: the driver keeps working,
// the card explains why nothing is being sent, and no pings are queued.

import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/_core/trpc";
import { TRACK_INTERVAL_MS, isFixFresh, isTripActive } from "@/lib/offline/registry";

export type GeoPermission = "unknown" | "granted" | "denied" | "unsupported";

export interface LiveFix {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  at: number;
}

export interface LiveTracking {
  /** Whether the browser can and may report a position. */
  permission: GeoPermission;
  /** True while fixes are actually being sent. */
  tracking: boolean;
  /** True when a trip is active but we are not sending (permission/unsupported). */
  blocked: boolean;
  lastFix: LiveFix | null;
  lastSentAt: number | null;
  /** Fixes that actually reached the server. */
  sentCount: number;
  /**
   * Fixes that are safe on this device but have NOT reached the server yet.
   *
   * Kept separate from `sentCount` on purpose: a queued fix is not a delivered
   * one, and reporting it as "sent" told the driver their position was being
   * shared while the owner's map showed nothing.
   */
  queuedCount: number;
  error: string | null;
  /** Ask the browser for permission (prompts the user). */
  requestPermission: () => void;
}

interface TripLike {
  orderId: string;
  status: string;
}

export function useLiveTracking(trip: TripLike | null | undefined): LiveTracking {
  const ping = trpc.tracking.ping.useMutation();
  const [permission, setPermission] = useState<GeoPermission>("unknown");
  const [lastFix, setLastFix] = useState<LiveFix | null>(null);
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const [sentCount, setSentCount] = useState(0);
  const [queuedCount, setQueuedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // The newest fix, kept in a ref so the sender always reads the latest one
  // without re-subscribing.
  const latest = useRef<LiveFix | null>(null);
  const watchId = useRef<number | null>(null);
  const lastPostRef = useRef(0);
  const pingRef = useRef(ping);
  pingRef.current = ping;
  const orderIdRef = useRef<string | null>(null);
  orderIdRef.current = trip?.orderId ?? null;

  const supported = typeof navigator !== "undefined" && !!navigator.geolocation;
  const tripActive = isTripActive(trip?.status);
  const canTrack = supported && permission !== "denied" && permission !== "unsupported";
  const tracking = tripActive && canTrack && permission === "granted";
  const blocked = tripActive && !tracking;

  /**
   * Send the newest fix, throttled to the tracking interval. A fix taken while
   * the tab was asleep is dropped rather than queued, so the route stays a route
   * and not a jump.
   */
  const send = useCallback(() => {
    const fix = latest.current;
    if (!fix) return;
    if (!isFixFresh(fix.at, Date.now())) return;
    const now = Date.now();
    if (now - lastPostRef.current < TRACK_INTERVAL_MS - 5_000) return;
    lastPostRef.current = now;
    pingRef.current.mutate(
      {
        latitude: fix.latitude,
        longitude: fix.longitude,
        accuracy: fix.accuracy,
        recordedAt: new Date(fix.at).toISOString(),
        orderId: orderIdRef.current,
      },
      {
        onSuccess: (res) => {
          // The offline link answers a queued write with `{ queued: true }`.
          // That is a fix stored on the device, NOT one the owner can see, so
          // it must never be counted — or shown — as sent.
          const queued = !!(res as { queued?: boolean } | null)?.queued;
          if (queued) {
            setQueuedCount((c) => c + 1);
            setError(null);
          } else {
            setLastSentAt(Date.now());
            setSentCount((c) => c + 1);
            setQueuedCount(0);
            setError(null);
          }
        },
        onError: (e) => setError(e.message),
      },
    );
  }, []);
  const sendRef = useRef(send);
  sendRef.current = send;

  // Read the current permission without prompting, where the browser allows it.
  useEffect(() => {
    if (!supported) {
      setPermission("unsupported");
      return;
    }
    let cancelled = false;
    const perms = (navigator as Navigator & { permissions?: Permissions }).permissions;
    if (!perms?.query) return;
    perms
      .query({ name: "geolocation" as PermissionName })
      .then((status) => {
        if (cancelled) return;
        setPermission(status.state === "granted" ? "granted" : status.state === "denied" ? "denied" : "unknown");
        status.onchange = () => {
          setPermission(status.state === "granted" ? "granted" : status.state === "denied" ? "denied" : "unknown");
        };
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [supported]);

  // Watch the position ONLY while a trip is active — the driver is not tracked
  // when they are not out with equipment.
  useEffect(() => {
    if (!supported || !tripActive || permission === "denied" || permission === "unsupported") return;
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const fix: LiveFix = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy ?? null,
          at: Date.now(),
        };
        latest.current = fix;
        setLastFix(fix);
        setPermission("granted");
        setError(null);
        // Send straight away on a new fix; the throttle inside `send` keeps this
        // from becoming a burst.
        sendRef.current();
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setPermission("denied");
          setError("Location permission was denied. Allow location access in your browser to share your position.");
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          setError("Your device could not get a GPS fix. Move somewhere with a clearer view of the sky.");
        } else {
          setError(err.message || "Could not read your location.");
        }
      },
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 },
    );
    watchId.current = id;
    return () => {
      if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    };
  }, [supported, tripActive, permission]);

  // Keep posting on the interval, so a stationary driver still reports in.
  useEffect(() => {
    if (!tracking) return;
    sendRef.current();
    const timer = window.setInterval(() => sendRef.current(), TRACK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [tracking]);

  const requestPermission = useCallback(() => {
    if (!supported) {
      setPermission("unsupported");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const fix: LiveFix = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy ?? null,
          at: Date.now(),
        };
        latest.current = fix;
        setLastFix(fix);
        setPermission("granted");
        setError(null);
        sendRef.current();
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setPermission("denied");
          setError("Location permission was denied. Allow location access in your browser to share your position.");
        } else {
          setError(err.message || "Could not read your location.");
        }
      },
      { enableHighAccuracy: true, timeout: 20_000 },
    );
  }, [supported]);

  return { permission, tracking, blocked, lastFix, lastSentAt, sentCount, queuedCount, error, requestPermission };
}
