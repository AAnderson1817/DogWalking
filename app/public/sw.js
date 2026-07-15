// PawTrail service worker (phase 08; hardened in the QC + re-review passes).
// Strategy: precache the app shell and initial hashed assets (stamped in at
// build time) while excluding lazy feature chunks such as Mapbox; cache-first
// for same-origin static assets; NETWORK-ONLY for Supabase REST/Storage, auth, realtime,
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

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting()),
  );
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
