# PWA installability check — automated result (phase 08)

Headless Chromium against the production preview build (Lighthouse 12+
retired its PWA category; these are the equivalent fundamentals, verified
programmatically — script: a Playwright run capturing the values below).

| Check | Result |
|---|---|
| Service worker registered | ✅ scope `/`, active, controlling the page |
| Versioned precache created | ✅ `pawtrail-shell-<build>` (stamped per build) |
| Offline reload serves the shell | ✅ `document` renders from cache with network cut |
| Manifest reachable + valid | ✅ name PawTrail, `display: standalone`, `theme_color #0E2A23` |
| Icons | ✅ 192/512 `any` + 192/512 `maskable` |
| iOS meta | ✅ apple-mobile-web-app-* + apple-touch-icon |
| Mutations bypass cache | ✅ non-GET and `/auth|/realtime|/functions` never cached (sw.js) |

Re-run: build with env, `npm --prefix app run preview`, then drive any
headless browser through: register → check `navigator.serviceWorker`,
`caches.keys()`, manifest fetch, `context.setOffline(true)` + reload.
