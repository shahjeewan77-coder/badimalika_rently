// ── The banner's honesty rules ───────────────────────────────────────────────
//
// These pin the two failures that produced a standing "some changes may not have
// been applied" warning on an app whose data was already saved:
//
//   1. a replayed (already-applied) action being counted as a refusal, and
//   2. the strip being able to say "everything is up to date" while the outbox
//      still held a write.
//
// They also pin the recovery rules: queued work must offer Sync now, a refusal
// must not, and a drained queue must go quiet without anyone clearing it.

import { describe, expect, it } from "vitest";
import { isQuiet, syncStatus, type SyncStatusInput } from "./status";

const base: SyncStatusInput = {
  online: true,
  checked: true,
  syncing: false,
  pending: 0,
  conflicts: 0,
  lastSyncAt: null,
};

describe("syncStatus", () => {
  it("is quiet, and says so positively, when there is nothing outstanding", () => {
    const s = syncStatus(base);
    expect(s.kind).toBe("synced");
    expect(s.tone).toBe("ok");
    expect(s.canRetry).toBe(false);
    expect(isQuiet(s)).toBe(true);
    // The whole point: an accurate statement, not a warning.
    expect(s.label).not.toMatch(/not applied|may not/i);
  });

  it("never claims everything is up to date before the first check finishes", () => {
    const s = syncStatus({ ...base, checked: false });
    expect(s.kind).toBe("checking");
    expect(s.label).not.toMatch(/up to date/i);
  });

  it("reports offline with the real queued count", () => {
    const s = syncStatus({ ...base, online: false, pending: 3 });
    expect(s.kind).toBe("offline");
    expect(s.label).toMatch(/Offline/);
    expect(s.detail).toContain("3");
    // Offline cannot be retried by hand; it recovers on its own.
    expect(s.canRetry).toBe(false);
  });

  it("counts queued work and offers a one-click retry", () => {
    const s = syncStatus({ ...base, pending: 2 });
    expect(s.kind).toBe("pending");
    expect(s.label).toContain("2");
    expect(s.canRetry).toBe(true);
  });

  it("does not offer a retry while a retry is already running", () => {
    const s = syncStatus({ ...base, pending: 2, syncing: true });
    expect(s.kind).toBe("syncing");
    expect(s.canRetry).toBe(false);
  });

  it("surfaces a genuine refusal and points at the review screen", () => {
    const s = syncStatus({ ...base, conflicts: 1 });
    expect(s.kind).toBe("conflicts");
    expect(s.tone).toBe("error");
    expect(s.label).toMatch(/could not be applied/);
    expect(s.canRetry).toBe(false);
  });

  it("ranks a refusal above queued work, so the user sees the thing needing a decision", () => {
    const s = syncStatus({ ...base, pending: 4, conflicts: 2 });
    expect(s.kind).toBe("conflicts");
    expect(s.label).toContain("2");
  });

  it("goes quiet the moment the queue drains and conflicts clear — no lingering notice", () => {
    const alarm = syncStatus({ ...base, conflicts: 1 });
    expect(isQuiet(alarm)).toBe(false);

    // The same counters after the queue drained and the conflict was resolved.
    const after = syncStatus({ ...base, pending: 0, conflicts: 0 });
    expect(isQuiet(after)).toBe(true);
    expect(after.kind).toBe("synced");
  });

  it("singularises one item, pluralises many", () => {
    expect(syncStatus({ ...base, pending: 1 }).label).toMatch(/1 change waiting/);
    expect(syncStatus({ ...base, pending: 5 }).label).toMatch(/5 changes waiting/);
    expect(syncStatus({ ...base, conflicts: 1 }).label).toMatch(/1 change could not/);
    expect(syncStatus({ ...base, conflicts: 2 }).label).toMatch(/2 changes could not/);
  });

  it("mentions the last successful sync only in the quiet state", () => {
    const at = Date.now() - 60_000;
    expect(syncStatus({ ...base, lastSyncAt: at }).detail).toMatch(/Last sync/);
    expect(syncStatus({ ...base, pending: 1, lastSyncAt: at }).detail).not.toMatch(/Last sync/);
  });
});
