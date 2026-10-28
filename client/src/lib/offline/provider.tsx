// ── Offline runtime ──────────────────────────────────────────────────────────
//
// Mounted once, inside the tRPC and auth providers. It owns the four things that
// have to happen outside of any single screen:
//
//   1. Watch connectivity — the browser's online/offline events, confirmed by a
//      real request to the app's own API, re-checked periodically so the banner
//      is honest about whether the server is actually reachable.
//   2. Flush the outbox when the connection returns (and after a successful
//      login, in case writes were queued on a previous visit).
//   3. Warm the cached reads after a sync, so a later offline session still has
//      orders, stock, customers and ledgers to show.
//   4. Keep the pending-sync and conflict counts the UI displays.

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { trpc } from "@/_core/trpc";
import { useAuth } from "@/_core/useAuth";
import { useAccount } from "@/lib/useAccount";
import { flush, listConflicts, outboxCount } from "./engine";
import { clearQueryCache } from "./idb";
import { rawMutation } from "./client";
import { registerSync, refreshPendingActions } from "./runtime";
import { getState, probeReachability, setState, subscribe } from "./store";

const PROBE_INTERVAL_MS = 30_000;

/**
 * How often a non-empty outbox is retried while the server is reachable.
 *
 * Without this, a write queued for a transient reason while the app believed it
 * was online was only retried on an offline→online transition, on sign-in, or by
 * hand. A single dropped request therefore stranded the write indefinitely —
 * which is exactly how a driver's location ping could sit in the queue for the
 * rest of a trip while the owner's map showed nothing.
 *
 * 4 seconds is deliberately short: the queue is normally EMPTY, so the timer
 * costs nothing, and when it is not, the pending work is the user's own click
 * waiting to land. Anything longer reads as "the button did nothing".
 */
const PENDING_RETRY_MS = 4_000;

/** The screens to warm after a sync, so they are readable offline later. */
function warmQueries(utils: ReturnType<typeof trpc.useUtils>) {
  const jobs: Array<Promise<unknown>> = [
    utils.orders.list.fetch({}),
    utils.rentals.onRent.fetch(),
    utils.equipment.list.fetch(),
    utils.customers.list.fetch(),
    utils.dashboard.summary.fetch(),
    utils.vehicles.list.fetch(),
    utils.drivers.list.fetch(),
    utils.assignments.mine.fetch({}),
    utils.assignments.forDate.fetch({}),
  ];
  const account = utils.account.me.fetch();
  jobs.push(account);
  void Promise.allSettled(jobs);
}

export function useOfflineState() {
  return useSyncExternalStore(subscribe, getState, getState);
}

export function OfflineProvider({ children }: { children: ReactNode }) {
  const utils = trpc.useUtils();
  const { user, isLoading } = useAuth();
  const { account } = useAccount();
  const running = useRef(false);
  const signedIn = !isLoading && !!user;

  // ── identity: never serve one account's cached data to another ─────────────
  //
  // Only `auth.me` / `account.me` are themselves auth-aware; every other cached
  // entry belongs to whoever was signed in before. Without this reset, a driver
  // signing in after the owner keeps the owner's dashboard, nav and totals
  // rendered inside the driver's session (and `Home`, redirecting the driver
  // away from that dashboard, can leave the login form unreachable).
  //
  // `user.id` is checked first: `_core`'s login/signup/logout invalidates
  // `auth.me`, so a new `user` is the authoritative signal that the identity
  // changed; the business `account` is the fallback when `auth.me` came from
  // cache. The ref is deliberately LEFT ALONE on sign-out — the next sign-in
  // must still see a different id and reset, otherwise owner → logout → driver
  // would hand the driver the owner's cached reads.
  //
  // Two caches are dropped: the IndexedDB reads (`clearQueryCache`; the outbox
  // survives, being that user's unsent work rather than a cache) and the
  // in-memory React Query cache (`utils.invalidate()`, which marks every entry
  // stale so the active ones refetch as the new user).
  const lastIdentity = useRef<string | null>(null);
  useEffect(() => {
    const id = user?.id ?? account?.userId ?? null;
    if (!id) return;
    if (lastIdentity.current && lastIdentity.current !== id) {
      void clearQueryCache();
      void utils.invalidate();
    }
    lastIdentity.current = id;
  }, [user?.id, account?.userId, utils]);

  async function refreshCounts() {
    const [pending, conflicts] = await Promise.all([outboxCount(), listConflicts()]);
    setState({ pending, conflicts: conflicts.length });
    // The banner must be able to fall silent on its own. Once nothing is queued
    // and nothing is waiting for a decision, any previous notice is history, and
    // leaving it on screen is exactly the "still showing a warning" complaint.
    if (pending === 0 && conflicts.length === 0) setState({ notice: null });
    void refreshPendingActions();
  }

  async function runSync(reason: string) {
    if (running.current) return;
    running.current = true;
    setState({ syncing: true });
    try {
      const userId = account?.userId ?? user?.id ?? null;
      const outcome = await flush((path, input) => rawMutation(path, input), { userId });

      // Refresh whatever the server touched, plus the screens we need for the
      // next offline session.
      if (outcome.sent > 0 || outcome.conflicts > 0 || outcome.already > 0) {
        utils.orders.list.invalidate();
        utils.orders.get.invalidate();
        utils.rentals.onRent.invalidate();
        utils.dashboard.summary.invalidate();
        utils.customers.list.invalidate();
        utils.customers.ledger.invalidate();
        utils.receipts.list.invalidate();
        utils.invoices.list.invalidate();
        utils.equipment.list.invalidate();
        utils.assignments.mine.invalidate();
        utils.assignments.forDate.invalidate();
      }
      if (outcome.sent > 0) warmQueries(utils);

      setState({
        lastSyncAt: outcome.sent > 0 ? Date.now() : getState().lastSyncAt,
        servedFromCache: false,
      });
      if (outcome.conflicts > 0) {
        setState({
          notice: `${outcome.conflicts} change${outcome.conflicts === 1 ? "" : "s"} could not be applied — see the Sync page.`,
        });
      } else if (outcome.sent > 0 && outcome.already > 0) {
        // Some of the queue was a replay of work the server already had. It is
        // live; saying "synced" would be true, but saying nothing about the
        // replays is what used to turn them into a false warning.
        setState({ notice: `Synced — ${outcome.sent} change${outcome.sent === 1 ? "" : "s"} confirmed.` });
      } else if (outcome.sent > 0) {
        setState({ notice: `Synced ${outcome.sent} change${outcome.sent === 1 ? "" : "s"}.` });
      } else if (outcome.already > 0) {
        setState({ notice: "Everything was already up to date." });
      }
      void reason;
    } finally {
      running.current = false;
      setState({ syncing: false });
      await refreshCounts();
    }
  }

  // ── connectivity ──────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function check() {
      const reachable = await probeReachability();
      if (cancelled) return;
      const wasOffline = !getState().online;
      setState({ online: reachable, checked: true });
      if (reachable && wasOffline && signedIn) void runSync("connection-returned");
    }

    void check();
    const interval = window.setInterval(check, PROBE_INTERVAL_MS);

    const onOnline = () => {
      // The browser says a network exists; confirm it reaches the server.
      void check();
    };
    const onOffline = () => {
      setState({ online: false, checked: true });
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, account?.userId]);

  // ── counts, and a flush attempt after a fresh sign-in ───────────────────────
  useEffect(() => {
    void refreshCounts();
    if (signedIn && getState().online) void runSync("signed-in");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, account?.userId]);

  // ── retry anything already queued, while the server is reachable ───────────
  //
  // A write can be queued while the app considers itself online: a request that
  // died mid-flight, a probe that failed once, a tab that woke up. Waiting for an
  // offline→online transition to retry it means it may wait indefinitely, so a
  // non-empty queue is drained on a short interval instead.
  useEffect(() => {
    if (!signedIn) return;
    const tick = () => {
      if (!getState().online || getState().syncing) return;
      if (getState().pending > 0) void runSync("pending-retry");
    };
    const interval = window.setInterval(tick, PENDING_RETRY_MS);
    // Also retry the moment a write is queued, so the usual case is immediate.
    const unsubscribe = subscribe(() => {
      if (getState().pending > 0 && getState().online && !getState().syncing) void runSync("queued-now");
    });
    return () => {
      window.clearInterval(interval);
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, account?.userId]);

  // Let the banner and the Sync page ask for a flush.
  useEffect(() => {
    registerSync(() => {
      if (getState().online) {
        void runSync("manual");
      } else {
        void probeReachability().then((ok) => {
          if (ok) void runSync("manual-online");
        });
      }
    });
    return () => registerSync(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, account?.userId]);

  return <>{children}</>;
}
