# 06 — Frontend architecture

Single Vite React-TS PWA in `app/`, serving both personas behind role-gated routes. No state library: typed fetch layer + React context + local state. (React Query is a v1.1 option; do not add now.)

## Routes (react-router-dom 6)
```
/signin            SignIn (email+password, magic-link option)
/onboard           Onboard (first-run operator setup: business, defaults)
/claim/:token      ClaimInvite (client signup → fn_claim_invite)
-- operator (requires role=operator) --
/                  Dashboard
/calendar          Calendar (phase 06)
/roster            Roster
/clients/:id       ClientDetail (tabs: pets · plan&credits · walks · access)
/walks/:id/live    WalkMode  (.walkmode theme)
/vault             AccessVault
/billing           BillingConsole (phase 07: renewals, failed payments, plan changes)
-- portal (requires role=client) --
/portal            PortalHome
/portal/book       Booking (phase 07)
/portal/walks/:id  WalkDetail (live map while in_progress, report card after)
/portal/billing    PortalBilling (phase 07)
/portal/pets       PetProfiles (self-manage care fields)
```
`RequireRole` wrapper redirects to `/signin`, then to the persona home.

### Operator navigation

The authoritative primary navigation is:

1. Today → `/`
2. Calendar → `/calendar`
3. Clients → `/roster`
4. Money → `/billing`

Inbox is a secondary utility surfaced through `NotificationBell`; it is not a
fifth bottom-navigation destination. Access Vault remains available at
`/vault` through the Clients surface. Route paths remain stable while the
visible product labels use the approved Sanpo language.

## lib/
- `supabase.ts` — browser client (anon key, `persistSession`).
- `types.ts` — `supabase gen types typescript --local > app/src/lib/types.ts` after every migration phase; domain aliases exported.
- `api.ts` — typed wrappers for all reads/writes and edge invocations (`supabase.functions.invoke`). All data access flows through here; screens never call `supabase.from` directly.
- `credits.ts` — client-side helpers: effective walk cost, low-credit predicate, ledger formatting.
- `format.ts` — `money(cents)`, `walkTime(date, window)`, `dateLocal(ts)`, `timeLocal(ts)`, `time12(t)`, `distanceKm(m)`, `elapsed(start)`. All display times America/Chicago (US Central), 12-hour.
- `auth-context.tsx` — session + resolved persona: `{ session, role: 'operator'|'client'|null, operatorId, clientId, reauth() }`. Role resolution on session: `operators` row by uid, else `clients` by `auth_user_id`.

## hooks/
- `useGeolocation(active: boolean)` — `watchPosition` (`enableHighAccuracy`, `maximumAge:0`); emits points throttled to ≥5 s AND ≥10 m deltas; exposes `{ points, current, error, permission }`.
- `useWalkChannel(walkId, mode: 'broadcast'|'subscribe')` — Realtime channel `walk:{id}`; operator broadcasts `gps` events `{lat,lng,t,acc}` per emitted point and flushes batched inserts to `walk_gps_points` every 10 points or 60 s (whichever first, plus on end); portal subscribes and yields the live point stream. Phase 08 adds the offline IndexedDB queue in front of the flush.

## Walk Mode flow (phase 05)
start → `walks.status='in_progress', started_at` → useGeolocation+broadcast → photo capture `<input capture="environment">` → compress client-side (≤1600px, ~0.8 q) → Storage `walk-photos/{operator}/{walk}/…` → **insert the `walk_photos` row immediately** → potty/fed toggles → end → distance from point polyline (haversine sum) → `complete-walk` edge fn → render returned billing outcome → ReportCard preview.

### Nothing the operator does may depend on this screen staying mounted

A walk is thirty minutes of an operator's hands being busy. The screen will be
reloaded, back-swiped, and reclaimed by the OS, and none of that may cost them
work already done (review H8). Three rules:

1. **A photo is durable the moment it uploads.** `insertWalkPhoto` writes the
   `walk_photos` row at upload time — `ignoreDuplicates` on
   `uq_walk_photos_path`, the same conflict target complete-walk uses, so
   sending the path again at completion is a no-op. Waiting until completion
   meant the only pointer to an uploaded photo was React state, and any
   remount stranded every photo in the bucket with nothing referencing it.
2. **Toggles and notes live in the local snapshot** (`lib/walk-snapshot.ts`),
   because they have no column until completion. Written on every change, read
   back on resume. `shouldPersistProgress` gates the writer on `hydrated`:
   the screen mounts empty and restores asynchronously, so a writer that runs
   first persists the empty state over the record it is about to read.
3. **Resume is server-first, snapshot-second.** Photos come from
   `listWalkPhotos` (survives a different device) unioned with the snapshot
   (catches a photo uploaded offline whose row insert had nowhere to go);
   notes prefer the snapshot, since `walks.notes` is not written until
   completion.

### GPS stops when the phone does, and the product has to say so

`watchPosition` stops delivering fixes when the page is backgrounded or the
screen locks, on both iOS Safari and Android Chrome. It stops **silently** — a
suspended watch fires no error, so `geo.error` stayed null, nothing on screen
changed, and the next fix was appended to the trail as though it were the next
step of the walk (review H7). The route drew a straight line across the
suspended interval and `distance_m` — the client-facing proof of service on the
report card — measured it. A walk where the operator pocketed the phone could
report a *longer* distance than one where they held it.

Three parts, none of which is a cure:

1. **A screen wake lock** (`useWakeLock`) while a walk is active, re-requested
   on `visibilitychange`. The OS releases the sentinel whenever the page is
   hidden, so acquiring it once means it survives exactly one app switch and
   then never returns. Feature-detected: Safari < 16.4 and Firefox have no
   `navigator.wakeLock`, and the footer copy says which case the operator is in
   rather than implying the recording is fine.
2. **A visible "Recording paused" state** when the last raw fix is older than
   `GPS_GAP_MS`. Without it the screen is identical whether or not the route is
   being recorded, which is the single thing the operator most needs to know.
   `geo.error` takes precedence — a denied permission is a different problem
   with a different fix.
3. **The gap is marked, not drawn through.** `gapBefore` on the point after a
   silence; `pathDistanceM` skips the segment into it, `toSvgPath` starts a new
   subpath, Mapbox renders a `MultiLineString`, and `walk_gps_points.gap_before`
   (0027) carries it so a resumed or completed walk still shows the break.
   Under-reporting is deliberate: leaving out a stretch nobody recorded is
   honest, inventing a straight line across it is not.

**Detected on raw fixes, never on emitted points.** Raw fixes arrive about once
a second whether or not the device is moving; emitted points are throttled to
≥5 s **and** ≥10 m, so an operator waiting at a crossing legitimately produces
none for minutes. A time-gap rule applied to emitted points — or to stored rows
— would call that a suspension and delete real walking. That is also why 0027
adds a column rather than deriving the flag from `recorded_at`, and why nothing
is backfilled: a guessed gap is indistinguishable from an observed one.

`shouldEmitPoint` lets a `gapBefore` fix through regardless of both thresholds.
The device can wake within 10 m of where it slept, and if the throttle
suppresses that fix the mark lands somewhere further along the trail or never
lands at all.

**Exit guards, both of them.** `beforeunload` covers reload / tab close / app
switch. It does *not* cover the back button or an edge-swipe back gesture —
that is a same-document history navigation, no unload fires, and Walk Mode
simply unmounted with recording stopped and no confirmation. That path is
guarded by a history sentinel: an entry pushed on the same URL, so popping it
re-renders the route instead of unmounting it and the confirm happens while
the walk is still on screen. Deliberately not react-router's `useBlocker`,
which requires a data router (`createBrowserRouter`); this app mounts
`<BrowserRouter>` and migrating the router for one prompt is a much larger
change than the bug warrants. The sentinel entry is left behind on a normal
exit — it points at the same URL, so the only effect is one extra Back from
the report card, and calling `history.back()` from a cleanup would race
whatever navigation triggered it.

## PWA (phase 08)
`manifest.webmanifest` (name Sanpo, theme `#FEF6EA`, display standalone,
byte-approved Sanpo icons at 192/512 including maskable entries), service
worker: precache the built app shell (the hashed `.js`/`.css`/`.woff2`/`.webp`/
`.svg` assets, stamped into `__BUILD_ASSETS__` by `vite.config.ts`), IndexedDB
GPS outbox with background flush + `beforeunload` guard.

### Supabase traffic is network-only. This is a security boundary.

Nothing under `/rest/`, `/auth/`, `/realtime/`, `/functions/` or `/storage/` is
ever cached or served from cache, for GET as well as for mutations.
`public/sw.js` returns early for those paths before any cache logic runs.

**This spec used to say "stale-while-revalidate for GET API/Storage", and that
sentence describes the design that caused a real cross-account data leak.** The
Cache API is keyed by URL and knows nothing about the `Authorization` header,
so on a shared device — a household tablet, an operator's phone handed to a
colleague, a library machine — a PostgREST response cached for account A was
served to account B. Same URL, different person, no revalidation required to
render. It was found in the qc(1–4) pass and fixed in the service worker; the
spec was not updated, so for four hardening waves the authoritative document
still prescribed the bug.

That is why this section is written as a prohibition rather than a preference.
An engineer told the specs win, asked to make the service worker match spec 06,
would have reintroduced the leak *with a written authority for doing so*. If
offline reads of account data are ever wanted, they need a cache partitioned by
authenticated user identity and cleared on sign-out — a different design, not a
relaxation of this one.

`scripts/service-worker.test.ts` enforces it, and it drives the real `fetch`
handler rather than grepping for the prefix list — a grep passes against a
handler that computes the list correctly and then ignores it, and this
repository has already shipped one check a *comment* could satisfy. It asserts
`respondWith` is never called for the five path families or for any mutation,
and — in the other direction, so that deleting the handler outright cannot
satisfy it — that the app shell and navigations still are. Confirmed red by
reinstating exactly what this section used to prescribe.

## Testing

Two vitest projects, split by what they can express:

| Project | Environment | Covers |
| --- | --- | --- |
| `node` | `node` | `src/lib/`, `scripts/` — pure functions, CSS/SQL text analysis, the service worker's fetch handler |
| `dom` | `happy-dom` + Testing Library | `src/components/`, `src/screens/`, `src/hooks/` |

The split is deliberate in both directions. `node` stays DOM-free so a
`lib/` module cannot quietly grow a dependency on `window` that the edge
functions and the service worker do not have. `dom` is where **behaviour**
lives: effects, cleanups, subscriptions, event handlers, focus, timers.

Before review H18 there was no `dom` project. The whole suite ran in `node`
and every `.test.tsx` rendered through `renderToStaticMarkup`, so no effect
body, cleanup, subscription, handler or state transition executed anywhere in
the suite. That is not "under-covered": tests for Walk Mode's lifecycle, the
vault's reveal-and-expire, a route guard's redirect or a load-error retry were
**unwritable**, and every defect of that kind in the status log was found by
hand.

Rules that follow from it:

- **A route guard is tested through a router.** `<Navigate>` returned from a
  component is markup until something routes on it.
- **A timer is tested with fake timers AND an unmount.** The reveal panel's
  30-second auto-clear is a security property; an interval that outlives its
  component keeps a decrypted secret in a live closure.
- **Skip-on-missing-config is banned outside `e2e/manual/`.** A skip reads as
  a pass. The manual suite throws instead, and CI fails a `test.skip(!…)`
  anywhere else.
- **Coverage that never runs is not coverage.** CI asserts the `dom` project
  actually matched files, because an include glob that stops matching looks
  exactly like a suite with nothing to say.

## Env
`app/.env.local`: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_MAPBOX_TOKEN`
(optional → SVG fallback). Access via typed `lib/env.ts`.

**A production build without the two required keys fails, and now actually
does.** This section has claimed that since phase 02 and it was not true
(review H22): `env.ts` threw at first *access*, not at build time, and because
it read `import.meta.env[name]` through a variable key Vite could not
statically replace it, so there was no build-time warning either. Reproduced
end to end — build with no env vars, serve `dist/`, and `#root.innerHTML.length`
is **0** with one uncaught page error. CI's frontend job built exactly that way
and was green on `main`.

Two mechanisms now, and the order matters:

1. **`scripts/verify-env.mjs`**, run from `prebuild` beside
   `verify:brand-assets`, refuses a production build with either key unset. It
   reads `process.env` *and* Vite's own `.env*` files, because a key set in
   `.env.production` is genuinely present at build time and failing that build
   would be the false-positive direction — which is how a gate gets disabled.
   An empty value (`FOO=`) counts as unset; that is the shape a half-finished
   deployment leaves behind. CI sets placeholders so the gate is exercised, and
   asserts separately that it *refuses* when they are absent.
2. **`ConfigError`**, the safety net for a bundle the gate never saw — a host
   building outside `npm run build`, or a variable present but wrong. Nothing
   in `env.ts` throws any more, so `main.tsx` can branch: missing configuration
   is data (`missingEnvKeys()`), and the panel renders instead of the app. It
   carries its own inline styles and imports nothing beyond React, because it
   has to render when the app's own module graph may be what is broken.

The panel replaces the app rather than sitting inside `ErrorBoundary`: a client
pointed at the unroutable placeholder would otherwise spend the whole session
failing one request at a time instead of saying what is wrong once.
