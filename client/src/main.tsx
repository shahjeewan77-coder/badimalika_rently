import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { trpc } from "./_core/trpc";
import { makeOfflineTrpcClient } from "./lib/offline/client";
import { OfflineProvider } from "./lib/offline/provider";
import { LiveDataProvider } from "./lib/liveProvider";
import { AuthProvider } from "./_core/useAuth";
import App from "./App";
import "./index.css";

/**
 * `networkMode: "always"` matters here.
 *
 * React Query's default is "online", which PAUSES a request when the browser
 * reports no connection — it never calls the link, so the offline cache fallback
 * would never run and screens would sit in a permanent loading state. "always"
 * lets every request through, and the offline links in `makeOfflineTrpcClient`
 * decide what to do: serve the stored reply for a query, queue the write for a
 * mutation.
 *
 * `refetchOnWindowFocus` is a FUNCTION rather than `true`, so the behaviour can
 * differ by query: a data screen refetches the moment the tab is shown again
 * (which is what makes switching tabs instant rather than waiting for the next
 * poll), while a form that holds a half-filled draft does not — refetching those
 * would quietly discard what the user typed. Screens opt out by setting
 * `meta.refetchOnFocus: false`.
 */
function Root() {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 0,
            networkMode: "always",
            // Small but non-zero: a screen that remounts twice in a moment (a
            // click, then a route change) reuses the answer it already has
            // instead of firing the identical request again.
            staleTime: 2_000,
            refetchOnWindowFocus: (query) => query.meta?.refetchOnFocus !== false,
            // Polling must not run for a hidden tab. React Query checks this
            // flag itself, and it applies to EVERY `refetchInterval` below.
            refetchIntervalInBackground: false,
          },
          mutations: { retry: 0, networkMode: "always" },
        },
      }),
  );
  const [trpcClient] = React.useState(() => makeOfflineTrpcClient());
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <OfflineProvider>
            <LiveDataProvider>
              <TabVisibilityRefresh />
              <App />
            </LiveDataProvider>
          </OfflineProvider>
        </AuthProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

/**
 * Refetch when the tab becomes visible again.
 *
 * `refetchOnWindowFocus` covers switching windows, but not every way a tab comes
 * back: a mobile browser restoring a backgrounded tab fires
 * `visibilitychange` and may never fire a focus event at all. A driver
 * returning to their phone must see the current state immediately, so this
 * listens for the visibility event directly and treats it as "you are looking
 * at this again — make it true".
 */
function TabVisibilityRefresh() {
  const qc = useQueryClient();
  React.useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void qc.refetchQueries({ type: "active" });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [qc]);
  return null;
}

const rootEl = document.getElementById("root")!;
// A page render that is torn down and rebuilt — React StrictMode's double
// invocation of effects in development — must not create a second React root on
// the same element, which surfaces as duplicated markup or a blank page.
const mounted = new WeakMap<Element, ReturnType<typeof ReactDOM.createRoot>>();
const root = mounted.get(rootEl) ?? ReactDOM.createRoot(rootEl);
mounted.set(rootEl, root);

root.render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);

// ── Service worker ───────────────────────────────────────────────────────────
//
// Registered in development AND production. It is what makes the app open with
// no connection: navigations are network-first with a cached shell fallback, and
// the dev server's unbundled modules are cached too, so an offline reload inside
// the preview still renders.
//
// A previous build is healed rather than left in place: its caches are dropped
// and the new worker is activated immediately, so an updated app is never served
// from a stale shell.
if ("serviceWorker" in navigator && !import.meta.env.VITEST) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .then(async (reg) => {
        // Take over at once when an update is found, instead of waiting for
        // every tab to close.
        void reg.update();
        const waiting = reg.waiting;
        if (waiting) waiting.postMessage({ type: "SKIP_WAITING" });
      })
      .catch(() => {
        /* offline support is best-effort */
      });
  });
}
