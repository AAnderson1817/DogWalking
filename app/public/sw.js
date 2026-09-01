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
// Replaced at build time with {stem, fallback} for the Today plate, or null on
// a `public`-only build. Review M17: the plate ships as four responsive
// candidates and only the master is precached, so the worker has to be able to
// answer for the other three.
//
// The stem is stamped rather than written here on purpose. Matching by stem —
// not by an exact URL list — is what keeps this working across a deploy: a
// page still running the previous build asks for the PREVIOUS hashed variant,
// which no current list would contain, and that request is exactly the one
// most likely to 404.
const PLATE_FAMILY = "__PLATE_FAMILY__";

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
  if (!event.data) return;
  if (event.data.type === "SKIP_WAITING") self.skipWaiting();

  // "Can you show a push?" — asked by lib/push.ts before it lets anyone
  // subscribe (Codex review on PR #85).
  //
  // The page cannot answer this from the registration object. It used to try,
  // by treating `registration.waiting != null` as "the active worker is old",
  // and that misses the case it was written for: during an upgrade FROM the
  // pre-M27 worker the new one spends its install in `installing`, where
  // `waiting` is still null, and the active worker — the one that would
  // receive a push — has no `push` handler at all. Subscribing there produces
  // a registration whose deliveries are silently dropped.
  //
  // A worker that predates M27 falls through its own handler without
  // replying, so the page's timeout is what answers for it. That is the whole
  // design: the ONLY way to hear "yes" is from a worker running this file.
  if (event.data.type === "PUSH_CAPABLE?") {
    const reply = { type: "PUSH_CAPABLE", push: true };
    const port = event.ports && event.ports[0];
    if (port) port.postMessage(reply);
    else if (event.source) event.source.postMessage(reply);
  }
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

// ── Push (review M27) ────────────────────────────────────────────────────
//
// A push event MUST end in a visible notification. Chrome permits a small
// number of silent pushes and then shows "This site has been updated in the
// background" on the user's behalf, and repeated offenders lose the
// permission outright — so every path out of here, including a malformed or
// absent payload, shows something. A generic notification is a worse product
// than a specific one; NO notification is a broken one.
self.addEventListener("push", (event) => {
  event.waitUntil(showPush(event.data));
});

/**
 * A payload-supplied path is never trusted as a destination.
 *
 * This mirrors `app/src/lib/internal-path.ts` (review M41): a target starting
 * `//host` or `\host` is another ORIGIN once it becomes an href, so
 * `clients.openWindow` on it navigates the user off-site. The payload is
 * written by our own server today, which is exactly the kind of property that
 * quietly stops being true — and the sink here is a real navigation, unlike
 * the app-side call sites where every target is a literal.
 *
 * Duplicated rather than imported because a service worker has no module
 * graph into `src/`. `service-worker.test.ts` pins both forms.
 */
function safePath(candidate) {
  if (typeof candidate !== "string" || candidate === "") return "/";
  for (let i = 0; i < candidate.length; i++) {
    const code = candidate.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return "/";
  }
  if (candidate[0] !== "/") return "/";
  if (candidate[1] === "/" || candidate[1] === "\\") return "/";
  return candidate;
}

async function showPush(data) {
  let payload = {};
  try {
    const parsed = data ? data.json() : null;
    // `json()` SUCCEEDS for the literal `null`, and every field read below
    // then throws — rejecting the waitUntil promise and showing nothing,
    // which is the silent push this handler exists to prevent (Codex review
    // on PR #85). A string or a number is harmless (property reads give
    // undefined) but is normalised here too, so the guarantee does not rest
    // on which primitive arrived.
    if (parsed && typeof parsed === "object") payload = parsed;
  } catch {
    // A body we cannot parse is still a push we must answer for.
    payload = {};
  }
  const title = typeof payload.title === "string" && payload.title ? payload.title : "Sanpo";
  await self.registration.showNotification(title, {
    body: typeof payload.body === "string" ? payload.body : "",
    // Collapses a redelivery of the SAME notification rather than stacking a
    // lock screen full of copies. The server sends the notification ROW id
    // (`send-notification/push.ts`), never the type: two distinct walk-complete
    // events must both show, and tagging by type made the second silently
    // replace the first.
    tag: typeof payload.tag === "string" && payload.tag ? payload.tag : "sanpo",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: safePath(payload.url) },
  });
}

// Focus a tab that is already open rather than stacking another one, which is
// what a person tapping a notification almost always means.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = safePath(event.notification.data && event.notification.data.url);
  event.waitUntil(openApp(url));
});

async function openApp(url) {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of all) {
    if (new URL(client.url).origin !== self.location.origin) continue;
    await client.focus();
    // `navigate` is not implemented everywhere, and a focused tab on the wrong
    // screen is still better than a second tab — so a failure here is not
    // allowed to lose the focus we just gained.
    if (typeof client.navigate === "function") {
      try {
        await client.navigate(url);
      } catch {
        /* focused, but could not route */
      }
    }
    return;
  }
  await self.clients.openWindow(url);
}

function isMutation(request) {
  return request.method !== "GET";
}

/**
 * Is this one of the Today plate's responsive candidates?
 *
 * Scoped to `/assets/` and to the stamped stem, so it can never claim an
 * unrelated image: substituting the plate for something else would be a
 * silently wrong picture, which is worse than a missing one.
 */
function isPlateRequest(url) {
  if (!PLATE_FAMILY || typeof PLATE_FAMILY.stem !== "string") return false;
  if (!url.pathname.startsWith("/assets/")) return false;
  const name = url.pathname.slice("/assets/".length);
  return name.startsWith(PLATE_FAMILY.stem) && name.endsWith(".webp");
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
    event.respondWith(
      cacheFirst(request, SHELL_CACHE, isPlateRequest(url) ? PLATE_FAMILY.fallback : null),
    );
  }
});

// Cache-first with background refresh. Hashed build assets are
// content-addressed so a cached copy is always correct; the refresh keeps
// non-hashed shell files (index.html, manifest) current for the next load.
async function cacheFirst(request, cacheName, fallbackUrl) {
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
    if (response.ok) {
      cache.put(request, response.clone());
      return response;
    }
    // A non-ok answer is a real outcome for a hashed asset — the file rolled
    // off after a fast redeploy — and for the plate it means a blank screen,
    // because <img srcset> does NOT try another candidate when the picked one
    // fails: it renders nothing. So a 404 falls back too, not just an offline
    // fetch. Everything else keeps getting the server's own answer.
    return (await plateFallback(cache, fallbackUrl)) ?? response;
  } catch {
    return (await plateFallback(cache, fallbackUrl)) ?? Response.error();
  }
}

/**
 * The precached plate, standing in for a candidate this worker cannot produce.
 *
 * Seamless because every candidate is the same composition at the same ratio
 * and the layout is CSS-driven: the substituted master renders at the field's
 * width exactly as the intended candidate would, just from more pixels.
 */
async function plateFallback(cache, fallbackUrl) {
  if (!fallbackUrl) return null;
  const cached = await cache.match(fallbackUrl);
  return cached ?? null;
}
