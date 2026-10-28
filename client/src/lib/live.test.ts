// ── Live polling policy ───────────────────────────────────────────────────────
//
// The bug these guard against had no error and no stack trace: screens simply
// never refetched, so a change made in one session never reached another. Two
// decisions carry that fix and both are easy to invert by accident, so both are
// pinned here.

import { describe, expect, it, afterEach } from "vitest";
import { HOT_POLL_MS, LIVE_POLL_MS, pollWhileOnline } from "./live";
import { getState, setState } from "./offline/store";

describe("poll intervals", () => {
  it("keeps the fast cadence inside the 'a few seconds' promise", () => {
    // The requirement is that another session's change shows up within a few
    // seconds. A five-second interval is the outer edge of that before the
    // request even starts.
    expect(HOT_POLL_MS).toBeLessThanOrEqual(5_000);
    // Slower cadence still has to be quick enough to be useful, not a token poll.
    expect(LIVE_POLL_MS).toBeGreaterThanOrEqual(HOT_POLL_MS);
    expect(LIVE_POLL_MS).toBeLessThanOrEqual(15_000);
  });
});

describe("pollWhileOnline", () => {
  afterEach(() => {
    // Leave the shared store as the tests found it, so a later file is unaffected.
    setState({ online: true, checked: true });
  });

  it("polls while the app is online", () => {
    setState({ online: true, checked: true });
    expect(pollWhileOnline(HOT_POLL_MS)()).toBe(HOT_POLL_MS);
  });

  it("stops polling while the app is offline", () => {
    // Polling a dead connection only produces a stream of failures and rewrites
    // the cached reply on every attempt. The offline link serves the stored
    // answer instead, and a real reconnect triggers the refetch.
    setState({ online: false, checked: true });
    expect(pollWhileOnline(HOT_POLL_MS)()).toBe(false);
    expect(getState().online).toBe(false);
  });

  it("re-reads the connection state on every tick", () => {
    // The interval is a FUNCTION rather than a fixed number precisely so that a
    // query mounted while offline starts polling again when the connection
    // returns, without remounting.
    setState({ online: false, checked: true });
    const tick = pollWhileOnline(HOT_POLL_MS);
    expect(tick()).toBe(false);
    setState({ online: true, checked: true });
    expect(tick()).toBe(HOT_POLL_MS);
  });
});
