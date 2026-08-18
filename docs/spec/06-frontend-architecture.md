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
worker: precache app shell, stale-while-revalidate for GET API/Storage,
network-only for mutations, IndexedDB GPS outbox with background flush +
`beforeunload` guard.

## Env
`app/.env.local`: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_MAPBOX_TOKEN` (optional → SVG fallback). Access via typed `lib/env.ts`; build fails on missing required keys.
