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
start → `walks.status='in_progress', started_at` → useGeolocation+broadcast → photo capture `<input capture="environment">` → compress client-side (≤1600px, ~0.8 q) → Storage `walk-photos/{operator}/{walk}/…` → potty/fed toggles → end → distance from point polyline (haversine sum) → `complete-walk` edge fn → render returned billing outcome → ReportCard preview.

## PWA (phase 08)
`manifest.webmanifest` (name PawTrail, theme `#0E2A23`, display standalone, icons 192/512 maskable), service worker: precache app shell, stale-while-revalidate for GET API/Storage, network-only for mutations, IndexedDB GPS outbox with background flush + `beforeunload` guard, custom install prompt on Dashboard after 2nd visit.

## Env
`app/.env.local`: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_MAPBOX_TOKEN` (optional → SVG fallback). Access via typed `lib/env.ts`; build fails on missing required keys.
