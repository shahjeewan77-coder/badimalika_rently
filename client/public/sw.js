// ── Service worker — offline app shell + static assets ───────────────────────
//
// What it caches, and what it deliberately does not:
//
//   * navigations    → network-first, falling back to a cached `/index.html`
//                      shell. This is what makes the app OPEN with no internet.
//   * /assets/*      → cache-first (Vite's content-hashed build output; immutable).
//   * /src/*, /@*    → network-first with a cache fallback, so the dev server's
//                      unbundled modules are available offline too.
//   * icons/manifest → cache-first.
//   * /trpc and /app-storage → NEVER intercepted. API replies are cached in
//                      IndexedDB by the app's own tRPC links — which can also
//                      replay a queued write, and know whether a reply is still
//                      valid. A service worker can do neither, and caching a
//                      POST would be actively wrong.
//
// Bumping VERSION is what retires the previous caches: `activate` deletes every
// cache whose name is not in the current set.
// v6 — the worker no longer serves its own file from cache (see the fetch
// handler), which is the bug that could pin a client to an old build forever.
const VERSION = "v6";
const STATIC_CACHE = `erm-static-${VERSION}`;
const SHELL_CACHE = `erm-shell-${VERSION}`;
const MODULE_CACHE = `erm-modules-${VERSION}`;
const ASSET_CACHE = `erm-assets-${VERSION}`;
const CURRENT = [STATIC_CACHE, SHELL_CACHE, MODULE_CACHE, ASSET_CACHE];

const PRECACHE = ["/index.html", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

// Shown only when the app has never been opened online and there is no cached
// shell to fall back to. Every other offline open serves the real app.
const FALLBACK_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Equipment Rental</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#0f172a;color:#e2e8f0;
display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center}
div{max-width:22rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:.25rem 0;color:#94a3b8}</style>
</head><body><div><h1>You are offline</h1>
<p>This app has not finished installing yet.</p>
<p>Open it once with an internet connection, then it will work offline.</p></div></body></html>`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      // Individually, so a single 404 cannot abort the whole install.
      .then((cache) => Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => undefined))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !CURRENT.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

/** Only a same-origin 200 is worth storing. */
function storable(res) {
  return !!res && res.status === 200 && res.type !== "opaque";
}

async function put(cacheName, request, response) {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response);
  } catch {
    /* quota / unsupported — caching is best-effort */
  }
}

async function networkFirst(request, cacheName) {
  try {
    const res = await fetch(request);
    if (storable(res)) put(cacheName, request, res.clone());
    return res;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (storable(res)) put(cacheName, request, res.clone());
  return res;
}

/** Navigations: fresh shell when online, the cached shell when not. */
async function handleNavigation(request) {
  try {
    const res = await fetch(request);
    if (storable(res)) put(SHELL_CACHE, "/index.html", res.clone());
    return res;
  } catch {
    const cached = (await caches.match("/index.html")) || (await caches.match("/"));
    if (cached) return cached;
    return new Response(FALLBACK_HTML, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/trpc") || url.pathname.startsWith("/app-storage")) return;

  // NEVER serve the worker itself (or the manifest) from a cache.
  //
  // The catch-all below is `cacheFirst`, so a previously cached /sw.js would be
  // handed back forever and the browser would never see a new build — the app
  // would sit on an old bundle with no way to find out. There is no VERSION bump
  // that can fix this either: the version lives INSIDE the file that is stuck in
  // the cache. These two paths must always come from the network.
  if (url.pathname === "/sw.js" || url.pathname === "/manifest.webmanifest") {
    event.respondWith(fetch(request, { cache: "no-store" }));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  // Unbundled dev modules + Vite's own client: fresh when possible.
  if (url.pathname.startsWith("/src/") || url.pathname.startsWith("/@")) {
    event.respondWith(networkFirst(request, MODULE_CACHE));
    return;
  }

  // Content-hashed production build output is immutable.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  event.respondWith(cacheFirst(request, STATIC_CACHE));
});
