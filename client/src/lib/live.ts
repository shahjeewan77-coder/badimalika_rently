// ── Live polling policy ───────────────────────────────────────────────────────
//
// Every screen in this app shows shared business state: an order a driver just
// locked, a dispatch that created an invoice, a customer's due balance. Two
// people are normally looking at it at once (the owner on a laptop, drivers on
// their phones), so a screen that only refreshes when you reload is wrong — it
// silently shows yesterday's answer until someone notices.
//
// Polling is the mechanism. Two rules make it cheap and honest:
//
//   * It PAUSES when the tab is hidden. React Query's own default,
//     `refetchIntervalInBackground: false`, stops the timer for a hidden tab;
//     `refetchOnWindowFocus` then refetches the moment it comes back, so
//     returning to the tab is instant rather than up to one interval stale.
//   * It PAUSES while the app knows it is offline. Hammering a dead connection
//     every few seconds would only produce a stream of failures (and write the
//     cached reply back to IndexedDB each time). The offline links already serve
//     the stored answer, and a real reconnect triggers a refetch through the
//     offline provider.
//
// Batched transport means one poll cycle is normally ONE HTTP request for all
// the queries on the screen, so the cost is small even though the interval is
// short.

import { isOffline } from "./offline/store";

/** Background cadence for ordinary, slow-moving lists (stock, users, vehicles). */
export const LIVE_POLL_MS = 10_000;

/**
 * Cadence for the screens where a change must show up "in a few seconds":
 * orders, the dashboard, on-rent, an order's own page, and the fleet map.
 *
 * The interval is deliberately below the 30-second driver ping interval and the
 * 5-second window a person expects, while keeping the request rate modest.
 */
export const HOT_POLL_MS = 5_000;

/**
 * A `refetchInterval` that stops while the app is offline.
 *
 * React Query accepts a function here, so the decision is re-made on every tick
 * rather than fixed when the query was created — which matters, because the
 * connection state changes underneath a query that is already mounted.
 */
export function pollWhileOnline(ms: number): () => number | false {
  return () => (isOffline() ? false : ms);
}
