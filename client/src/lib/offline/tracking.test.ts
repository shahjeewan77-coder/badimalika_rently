import { describe, expect, it } from "vitest";
import {
  MARKER_LIVE_WINDOW_MS,
  TRACK_MAX_FIX_AGE_MS,
  conflictPolicy,
  decideQueue,
  freshnessLabel,
  isFixFresh,
  isMarkerLive,
  isQueueable,
  isTripActive,
  shouldTrack,
} from "./registry";

// ── the driver's tracking loop ────────────────────────────────────────────────

describe("isTripActive", () => {
  it("is true only for the statuses that mean the driver is out with equipment", () => {
    expect(isTripActive("on_transit")).toBe(true);
    expect(isTripActive("on_rent")).toBe(true);
  });

  it("is false for every other status, and for nothing at all", () => {
    for (const s of ["pending_approval", "approved", "returned", "rejected", "dispatched", ""]) {
      expect(isTripActive(s)).toBe(false);
    }
    expect(isTripActive(null)).toBe(false);
    expect(isTripActive(undefined)).toBe(false);
  });
});

describe("shouldTrack", () => {
  it("tracks only when a trip is active AND permission is granted", () => {
    expect(shouldTrack({ status: "on_transit" }, "granted")).toBe(true);
    expect(shouldTrack({ status: "on_rent" }, "granted")).toBe(true);
  });

  it("never tracks without permission — a denial is a normal state, not an error", () => {
    expect(shouldTrack({ status: "on_transit" }, "denied")).toBe(false);
    expect(shouldTrack({ status: "on_transit" }, "unknown")).toBe(false);
    expect(shouldTrack({ status: "on_transit" }, "unsupported")).toBe(false);
  });

  it("never tracks when there is no active trip, even with permission", () => {
    expect(shouldTrack({ status: "approved" }, "granted")).toBe(false);
    expect(shouldTrack(null, "granted")).toBe(false);
  });
});

describe("isFixFresh", () => {
  const now = 1_000_000_000_000;

  it("accepts a fix taken just now", () => {
    expect(isFixFresh(now, now)).toBe(true);
    expect(isFixFresh(now - 30_000, now)).toBe(true);
  });

  it("drops a fix older than the window, so a sleeping tab cannot draw a jump", () => {
    expect(isFixFresh(now - TRACK_MAX_FIX_AGE_MS - 1, now)).toBe(false);
  });

  it("rejects a fix from the future (a clock skew, not a real position)", () => {
    expect(isFixFresh(now + 1, now)).toBe(false);
  });
});

describe("freshnessLabel", () => {
  const now = 1_000_000_000_000;

  it("says so when there is no position at all", () => {
    expect(freshnessLabel(null, now)).toBe("no position yet");
  });

  it("reads in seconds, minutes, hours then days", () => {
    expect(freshnessLabel(now - 5_000, now)).toBe("5s ago");
    expect(freshnessLabel(now - 5 * 60_000, now)).toBe("5m ago");
    expect(freshnessLabel(now - 5 * 3_600_000, now)).toBe("5h ago");
    expect(freshnessLabel(now - 5 * 86_400_000, now)).toBe("5d ago");
  });
});

describe("isMarkerLive", () => {
  const now = 1_000_000_000_000;

  it("is live inside the window and stale outside it", () => {
    expect(isMarkerLive(now - 10_000, now)).toBe(true);
    expect(isMarkerLive(now - MARKER_LIVE_WINDOW_MS - 1, now)).toBe(false);
  });

  it("is not live with no position", () => {
    expect(isMarkerLive(null, now)).toBe(false);
  });
});

// ── offline queueing of a ping ────────────────────────────────────────────────

describe("tracking.ping in the offline outbox", () => {
  it("is queueable, so a fix taken with no signal is replayed later", () => {
    expect(isQueueable("tracking.ping")).toBe(true);
  });

  it("is queued when offline and sent when online", () => {
    expect(decideQueue("tracking.ping", false)).toBe("queue");
    expect(decideQueue("tracking.ping", true)).toBe("send");
  });

  it("uses the client-wins policy — the server does not guard a ping with a precondition", () => {
    expect(conflictPolicy("tracking.ping")).toBe("client");
  });

  it("still refuses auth writes offline, so a reset code is never parked", () => {
    expect(decideQueue("auth.requestPasswordReset", false)).toBe("reject-offline");
    expect(decideQueue("auth.login", false)).toBe("reject-offline");
  });
});
