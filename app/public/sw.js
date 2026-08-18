// Sanpo service worker (phase 08; hardened in the QC + re-review passes).
// Strategy: precache the complete app shell INCLUDING the build's hashed
// chunks (stamped in at build time — without them, the activate-time cache
// wipe broke offline reload after every deploy); cache-first for same-origin
// static assets; NETWORK-ONLY for Supabase REST/Storage, auth, realtime,
// edge functions and every mutation. Per-user API data is never cached — a
// shared cache keyed by URL served one account's rows to the next account
// on the same device. Storage photo caching was removed too: signed URLs
// change per view, so it never hit and only grew the cache.
const VERSION = "__BUILD_VERSION__";
const SHELL_CACHE = `pawtrail-shell-${VERSION}`;
// Replaced at build time with the hashed /assets file list.
const BUILD_ASSETS = "__BUILD_ASSETS__";

const SHELL_URLS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/fonts/nunito-var.woff2",
  "/fonts/baloo-2-var.woff2",
].concat(Array.isArray(BUILD_ASSETS) ? BUILD_ASSETS : []);

// The document is what makes an offline start possible at all. Everything
// else degrades; without this the worker has nothing to serve a navigation.
const REQUIRED_URLS = ["/index.html"];

// Review M6. `cache.addAll` is atomic: one asset failing — a CDN hiccup, a
// font 404, a chunk that has already rolled off after a fast redeploy — voids
// the ENTIRE install, so the user is left with whatever worker they had, or
// none. Per-URL under `allSettled` means a missing font costs a font.
//
// But "best effort" must not mean "install a shell that cannot start", so the
// document is required and the install still rejects without it. And there is
// deliberately NO `skipWaiting()` here any more: see the message handler.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async (cache) => {
      const results = await Promise.allSettled(SHELL_URLS.map((url) => cache.add(url)));
      const failed = SHELL_URLS.filter((_, i) => results[i].status === "rejected");
      if (failed.length > 0) console.warn("sw: precache incomplete", failed);
      const missing = REQUIRED_URLS.filter((url) => failed.includes(url));
      if (missing.length > 0) {
        throw new Error(`sw: install failed, no offline document (${missing.join(", ")})`);
      }
    }),
  );
});

// Taking over is the PAGE's decision, not the worker's.
//
// `skipWaiting()` used to run unconditionally at install, so a deploy replaced
// the controller under a running session and `activate` then deleted the cache
// holding that session's chunks. A page that lazily imported anything
// afterwards — the map, a route — fetched a hashed file the new deploy no
// longer serves, and got a 404 in the middle of a walk. Now the new worker
// waits, the app offers a reload, and this only fires when someone accepts.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("pawtrail-") && !k.endsWith(VERSION))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isMutation(request) {
  return request.method !== "GET";
}

// Supabase REST/Storage + auth + realtime + edge functions: always live.
function isNeverCache(url) {
  return (
    url.pathname.startsWith("/rest/") ||
    url.pathname.startsWith("/storage/") ||
    url.pathname.startsWith("/auth/") ||
    url.pathname.startsWith("/realtime/") ||
    url.pathname.startsWith("/functions/")
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (isMutation(request) || isNeverCache(url)) return; // straight to network

  // Same-origin navigation + hashed static assets.
  if (url.origin === self.location.origin) {
    if (request.mode === "navigate") {
      event.respondWith(
        fetch(request).catch(() => caches.match("/index.html", { cacheName: SHELL_CACHE })),
      );
      return;
    }
    event.respondWith(cacheFirst(request, SHELL_CACHE));
  }
});

// Cache-first with background refresh. Hashed build assets are
// content-addressed so a cached copy is always correct; the refresh keeps
// non-hashed shell files (index.html, manifest) current for the next load.
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    fetch(request)
      .then((response) => {
        if (response.ok) cache.put(request, response.clone());
      })
      .catch(() => {});
    return cached;
  }
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return Response.error();
  }
}
