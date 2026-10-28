// ── Connectivity + sync state ────────────────────────────────────────────────
//
// A tiny external store, read through `useSyncExternalStore`, so the online /
// offline banner, the pending count and the conflict badge all read the same
// truth and update the instant it changes.
//
// Online is decided by `navigator.onLine` AND confirmed by the server being
// reachable — a phone that is "connected" to a Wi-Fi network with no route out
// reports `online: true`, and that is exactly when a queued write would fail.

export interface OfflineState {
  /** There is a usable connection to the server right now. */
  online: boolean;
  /** False until the first reachability check has finished. */
  checked: boolean;
  syncing: boolean;
  /** Writes waiting to be uploaded. */
  pending: number;
  /** Changes that could not be applied and need the user's attention. */
  conflicts: number;
  /** Epoch ms of the last successful sync, or null. */
  lastSyncAt: number | null;
  /** True once the app has had to serve stored data instead of the network. */
  servedFromCache: boolean;
  /** A transient message for the banner (e.g. why a write was refused). */
  notice: string | null;
}

let state: OfflineState = {
  online: typeof navigator === "undefined" ? true : navigator.onLine !== false,
  checked: false,
  syncing: false,
  pending: 0,
  conflicts: 0,
  lastSyncAt: null,
  servedFromCache: false,
  notice: null,
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function getState(): OfflineState {
  return state;
}

export function setState(patch: Partial<OfflineState>): void {
  const next = { ...state, ...patch };
  if (
    next.online === state.online &&
    next.checked === state.checked &&
    next.syncing === state.syncing &&
    next.pending === state.pending &&
    next.conflicts === state.conflicts &&
    next.lastSyncAt === state.lastSyncAt &&
    next.servedFromCache === state.servedFromCache &&
    next.notice === state.notice
  ) {
    return;
  }
  state = next;
  emit();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isOffline(): boolean {
  return !state.online;
}

/** Mark that the app is showing stored data rather than fresh network data. */
export function noteServedFromCache(): void {
  if (!state.servedFromCache) setState({ servedFromCache: true });
}

export function noteLiveData(): void {
  if (state.servedFromCache) setState({ servedFromCache: false });
}

export function setNotice(notice: string | null): void {
  setState({ notice });
}

/**
 * Decide whether the app is online: the browser's own flag first, then a real
 * (cheap) request to the app's own API. The request is what turns "connected to
 * a router" into "the server is actually reachable".
 *
 * It deliberately does NOT call a tRPC procedure. A tRPC GET can be answered
 * from a service-worker or HTTP cache, which would report success while the app
 * is genuinely offline — and the request would be indistinguishable from real
 * traffic. A cache-busting HEAD is unambiguous: a response means the server is
 * reachable.
 */
export async function probeReachability(): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`/trpc/__reachability?ts=${Date.now()}`, {
      method: "HEAD",
      headers: { "x-offline-probe": "1" },
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    return res.status > 0;
  } catch {
    return false;
  }
}
