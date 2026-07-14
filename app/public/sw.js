// PawTrail service worker (phase 08).
// Strategy: precache the app shell; stale-while-revalidate for same-origin
// static assets and GETs to Supabase REST/Storage; network-only for every
// mutation and auth/realtime/functions traffic. Cache names carry the build
// version (stamped at build time) so deploys bust cleanly.
const VERSION = "__BUILD_VERSION__";
const SHELL_CACHE = `pawtrail-shell-${VERSION}`;
const DATA_CACHE = `pawtrail-data-${VERSION}`;

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

function isAuthOrLive(url) {
  return (
    url.pathname.startsWith("/auth/") ||
    url.pathname.startsWith("/realtime/") ||
    url.pathname.startsWith("/functions/")
  );
}

function isDataGet(url) {
  return url.pathname.startsWith("/rest/") || url.pathname.startsWith("/storage/");
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Mutations, auth, realtime, edge functions: never cached.
  if (isMutation(request) || isAuthOrLive(url)) return;

  // Supabase REST/Storage GETs: stale-while-revalidate.
  if (isDataGet(url)) {
    event.respondWith(staleWhileRevalidate(request, DATA_CACHE));
    return;
  }

  // Same-origin navigation + static assets: shell-first.
  if (url.origin === self.location.origin) {
    if (request.mode === "navigate") {
      event.respondWith(
        fetch(request).catch(() => caches.match("/index.html", { cacheName: SHELL_CACHE })),
      );
      return;
    }
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
  }
});

async function staleWhileRevalidate(request, cacheName) {
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
