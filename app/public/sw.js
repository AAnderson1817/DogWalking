// PawTrail service worker (phase 08; hardened in QC pass).
// Strategy: precache the app shell; cache-first for immutable static assets
// and Storage objects (per-request signed URLs, safe to key by URL);
// NETWORK-ONLY for Supabase REST, auth, realtime, edge functions and every
// mutation. REST responses are per-user and must never be cached — a shared
// DATA cache keyed by URL served one signed-in account's rows to the next
// account on the same device and made writes look like they did not take.
// Cache names carry the build version (stamped at build time) so deploys
// bust cleanly.
const VERSION = "__BUILD_VERSION__";
const SHELL_CACHE = `pawtrail-shell-${VERSION}`;
const ASSET_CACHE = `pawtrail-asset-${VERSION}`;

const SHELL_URLS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/fonts/nunito-var.woff2",
  "/fonts/baloo-2-var.woff2",
];

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

// Supabase REST + auth + realtime + edge functions: always live, never cached.
function isNeverCache(url) {
  return (
    url.pathname.startsWith("/rest/") ||
    url.pathname.startsWith("/auth/") ||
    url.pathname.startsWith("/realtime/") ||
    url.pathname.startsWith("/functions/")
  );
}

// Storage objects are fetched via short-lived signed URLs (token in the query
// string), so the full URL is effectively a capability — caching by URL is
// safe and lets report-card photos render offline.
function isStorage(url) {
  return url.pathname.startsWith("/storage/");
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (isMutation(request) || isNeverCache(url)) return; // straight to network

  if (isStorage(url)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

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

// Cache-first with background refresh. For hashed build assets the URL is
// content-addressed so the cached copy is always correct; the network refresh
// keeps non-hashed shell files (index.html, manifest) current for next load.
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached ?? network;
}
