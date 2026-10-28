import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Captures the browser's install prompt so the app can offer an "Install" button. */
export function useInstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    if (window.matchMedia?.("(display-mode: standalone)").matches) setInstalled(true);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
  }

  return { canInstall: !!deferred && !installed, installed, install };
}

/**
 * Notice when a freshly deployed build is waiting.
 *
 * The app is served through a service worker (`/sw.js`) that caches the shell so
 * it opens offline. That is what makes an offline reload work — and it is also
 * what can leave someone running yesterday's JavaScript for days: the worker
 * keeps answering navigations from the cache it installed, and the page never
 * learns that a new build exists.
 *
 * `main.tsx` already calls `reg.update()` and skips waiting, which handles the
 * normal case. This hook covers the rest honestly:
 *
 *   * it re-checks for an update whenever the tab becomes visible again (the
 *     usual moment a long-lived SPA session would otherwise stay stale forever);
 *   * it surfaces `updatefound`, so a worker that installs mid-session is
 *     announced instead of silently taking over later;
 *   * `apply()` activates the waiting worker and reloads exactly once.
 *
 * It only ever OFFERS the reload — never reloads under the user by itself, which
 * would discard whatever they were in the middle of typing.
 */
export function useAppUpdate() {
  const [ready, setReady] = useState(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let cancelled = false;

    const check = async () => {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (!reg || cancelled) return;
        // A worker already sitting in `waiting` means the new build is installed
        // and cannot take over until every tab lets go of the old one.
        if (reg.waiting) setReady(true);
        // Otherwise ask the browser to look for a newer build than the one in
        // use. `updateViaCache: "none"` is set at registration, so this really
        // does hit the network rather than the HTTP cache.
        await reg.update().catch(() => undefined);
        if (!cancelled && reg.waiting) setReady(true);
      } catch {
        /* update detection is best-effort; never break the app over it */
      }
    };

    const onFound = () => {
      void navigator.serviceWorker.getRegistration().then((reg) => {
        if (!cancelled && reg?.waiting) setReady(true);
      });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };

    navigator.serviceWorker.addEventListener("updatefound", onFound);
    navigator.serviceWorker.ready.then((reg) => {
      if (!cancelled && reg.waiting) setReady(true);
    }).catch(() => undefined);
    document.addEventListener("visibilitychange", onVisible);
    // One check shortly after load, once the current build has settled.
    const timer = window.setTimeout(() => void check(), 8_000);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("updatefound", onFound);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  async function apply() {
    setApplying(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg?.waiting) {
        // Ask it to activate, then reload once the swap has actually happened —
        // reloading too early would re-open the OLD bundle and the notice would
        // come straight back.
        const swapped = new Promise<void>((resolve) => {
          navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
          window.setTimeout(resolve, 2_000);
        });
        reg.waiting.postMessage({ type: "SKIP_WAITING" });
        await swapped;
      }
    } catch {
      /* fall through to a plain reload */
    }
    window.location.reload();
  }

  return { ready, applying, apply };
}
