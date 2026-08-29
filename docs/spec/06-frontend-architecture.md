# 06 — Frontend architecture

Single Vite React-TS PWA in `app/`, serving both personas behind role-gated routes. No state library: typed fetch layer + React context + local state. (React Query is a v1.1 option; do not add now.)

## Routes (react-router-dom 7)

The app mounts `<BrowserRouter>`, not a data router — `createBrowserRouter`
and everything that needs it (loaders, actions, `useBlocker`) is deliberately
unused; see the Walk Mode exit guard below.

**Version 7 is a security floor, not a preference (review M41).** 6.x carries
an open redirect (CVE-2025-68470) and its backslash bypass
(GHSA-wrjc-x8rr-h8h6), plus an SSR-hydration constructor injection. The review
prescribed "upgrade to 7.x" and that was already wrong when it was written:
the advisory range is `6.0.0 - 7.17.0`, so most of 7 is equally affected and
the patched line is **>= 7.18.0**. Do not treat "we are on 7" as remediation
without checking the minor.

### Navigation targets

Every `navigate()` and `<Link to>` target in this app is a string literal, or a
template whose first segment is a literal (`/walks/${id}/live`). That is what
made the open redirect unreachable here: a value beginning `//host` or
`\\host` is another origin, and none of these can begin that way whatever is
interpolated.

That was true by accident. `lib/internal-path.ts` makes it checkable: anything
handed to a navigation that did NOT come from a literal in this codebase goes
through `internalPath()`, which returns `null` for a protocol-relative target,
a backslash target, a scheme, a relative path, or one carrying control
characters (browsers strip those before resolving, so the value navigated to is
not the value inspected). The one current caller is `deepLink` in
`NotificationInbox`, which builds from a stored `walk_id`.

It is deliberately not paired with a CI grep over `navigate(` arguments: the
one legitimate non-literal call site would have to be allow-listed by name, and
a stale exception that excuses a real check is a failure mode this repository
has already paid for. The helper exists to be the obvious thing to reach for.

The upgrade was done in two commits on purpose. `v7_startTransition` and
`v7_relativeSplatPath` are the only two behavioural changes 7 makes to this
app and both are opt-in flags on 6, so they were switched on and the whole
suite run green *under 6* before the version moved. A major upgrade that
carries a behaviour change inside it gives a regression two places to have
come from.
```
/signin            SignIn (email+password, magic-link option)
/onboard           Onboard (first-run operator setup: business, defaults)
/claim/:token      ClaimInvite (client signup → fn_claim_invite)
/legal/:slug       Legal — privacy notice + terms (H6). PUBLIC: the people who
                   most need the notice are the ones not signed in.
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
- `format.ts` — `money(cents)`, `walkTime(date, window)`, `dateLocal(ts)`, `timeLocal(ts)`, `time12(t)`, `distanceMi(m)`, `elapsed(start)`. All display times America/Chicago (US Central), 12-hour; distance is **miles**, through this formatter and never an inline conversion — Today used to do its own and disagreed with the client's report (review M36).
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
`<BrowserRouter>` and adopting a data router for one prompt is a much larger
change than the bug warrants. (Still true after the move to router 7 — that
upgrade changed the version, not the router style.) The sentinel entry is left behind on a normal
exit — it points at the same URL, so the only effect is one extra Back from
the report card, and calling `history.back()` from a cleanup would race
whatever navigation triggered it.

### A walk is bounded in time, and neither bound bills it

A walk had no maximum duration of any kind, and `complete-walk` is the only
exit from `in_progress` — so a forgotten END WALK kept recording for as long as
the app stayed open, and the route grew while the operator drove home. That
distance is what the client sees as proof of service (review M28).

`walkSessionBound` (`lib/walk-session.ts`) is the rule, in two stages:

1. **`prompting`** at `duration_minutes + 30 min` — the operator is *asked*
   ("Still walking?"). This stage stops nothing. A genuinely long walk is a
   normal thing, and taking the GPS away from someone still on it would be a
   new defect wearing the old one's clothes.
2. **`capped`** a further 30 minutes later, with the question unanswered —
   GPS emission stops. The walk stays `in_progress`, every point already
   recorded is kept, and the trail ends where the evidence for it ended.
   Under-reporting, the same direction the gap rule above commits to.

Answering restarts the clock **from the answer**, not from `started_at`; a
walk already past its bound would otherwise re-prompt on the next tick and the
button would visibly do nothing. `duration_minutes` is unavailable on the
offline resume path, which restores from a local snapshot, so an unknown or
non-positive duration falls back to 60 minutes — the only wrong answer that
costs anything here is the one that prompts too early.

**Neither stage completes the walk**, and neither does the nightly sweep.
Completing means billing, and a duration invented by a timer is not something
to charge a client for.

The cap is also the first thing that ever deactivates a *live* watch and can
reactivate it — `active` in Walk Mode used to be one-way, since a walk with a
`result` is over. So `useGeolocation` now remembers that a run ended and marks
the first fix of the next one `gapBefore`. Without it the resumed trail joins
straight onto the fix before the stop and `pathDistanceM` measures the whole
un-recorded stretch: H7's defect, rebuilt by the fix for M28. The mark is set
only if the ended run had produced a fix (otherwise the trail opens with a
break) and is cleared as soon as it is used (otherwise every later point is a
new subpath and the rest of the walk's distance disappears).

### Every list query is bounded, and filtering is the server's job (review M9)

`api.ts` is a direct PostgREST client and had 61 exported functions with two
`.limit()` calls between them. PostgREST caps an unbounded select at
`max_rows` — 1000 — and returns the first page **without saying so**, so an
unbounded query does not fail, it quietly answers a different question:

- `listPayments()` fed Today's "Needs attention" strip and Money's three
  headline totals. Ordered newest-first, so past the cap the *newest* failures
  were the ones dropped — from the strip whose only job is to surface them.
- `listWalksDetailed({})` in PortalHome ordered **ascending**, so a client past
  the cap kept their first year of walks and lost every recent one, including
  the "next walk" the screen exists to show.

Three bounds, because one number is wrong somewhere: `LIST_PAGE` (200),
`LIST_PAGE_LARGE` (500) and `WALK_DETAIL_PAGE` (5000) — a route bounded at 200
points is a truncated route. `scripts/bounded-queries.test.ts` asserts every
list query carries one, with exemptions declared by name and a reason.

Filtering moved to Postgres where a screen was fetching a haystack to show a
needle: `listLowCreditClients` and `listAttentionPayments` replace Today's
`listClients()` + `listPayments()`, and PortalHome asks two bounded, correctly
ordered questions instead of one unbounded one. `newestFirst` is load-bearing
next to `limit` — "the last three reports" asked with a limit alone returns the
oldest three.

Where a predicate exists on both sides, it is declared **once**:
`LOW_CREDIT_SUBSCRIPTION_STATUSES` is shared between the selector and the
query, because two copies of a predicate is the drift this repository has
already paid for in the payment-status sets.

### A failed Realtime join is not silent (review M10)

`channel.subscribe()` took no status callback. That mattered more once 0020
made the walk topic private and authorization real: a rejected join looks
exactly like a walk where nothing has happened yet. The operator's screen said
it was broadcasting and the client's portal showed a map that would never move.

`channelState` maps supabase-js's `SUBSCRIBED` / `CHANNEL_ERROR` / `TIMED_OUT`
/ `CLOSED`, and reads **anything it does not recognise as still joining, never
as live** — claiming a connection on no evidence is what makes this defect come
back. Walk Mode says the client cannot watch (recording is unaffected, and the
copy says so); the portal says the walk is under way but not viewable live.

### Drag-to-reschedule is offered only where dragging works (review M11)

Calendar's week view uses HTML5 drag-and-drop, which fires **no events at all**
on touch. The walk chip nevertheless rendered `draggable` with a grab cursor on
a phone, so the phase-06 headline interaction advertised itself and did nothing
on the primary device.

The affordance is gated on `usePointerFine()` — `(pointer: fine)`, live rather
than read once, because a tablet gains a pointer when a keyboard case is
attached, and defaulting to **false** where the query cannot run, since a
device wrongly treated as touch keeps a working tap flow while one wrongly
treated as mouse gets the affordance that does nothing.

Removing it is only correct because the tap path exists and always did: the
chip is a button that opens an action sheet wired to the same `reschedule()`.
That is asserted, not assumed. Playwright declares only Desktop Chrome, and
Calendar needs a backend so it cannot join the backend-free e2e suite — the
DOM project is the layer that can see this.

### The outbox never destroys route data for being offline

`attempts` used to increment on ANY failed send while `navigator.onLine` was
true. `onLine` is true on a captive portal, on one bar with no throughput, and
on hotel wifi that resolves DNS and nothing else — so twelve attempts of
exponential backoff, about nine minutes, silently deleted a batch of route
points with no log, no counter and no flag, while the screen said the walk was
recording (review M7). Because `drainOnce` stops after the first failure,
batches shed one at a time and the route stayed plausibly continuous rather
than obviously broken.

Three rules now:

1. **A transport failure does not count.** `isTransientSendError` separates "the
   request never reached a server" from "a server answered and refused". Only
   the second counts toward `maxAttempts`, whose purpose is to identify a batch
   the server will never take. Backoff still grows on both — the delay should
   respond to a bad network; the give-up counter must not.
2. **A batch given up on is marked, not deleted.** `dead: true` plus a
   `deadReason`. These are real observations that never reached the database,
   and destroying them removes the only remaining evidence that the route has a
   hole in it. Walk Mode surfaces the count: the route and the distance leave
   that stretch out rather than guessing across it, and say so.
3. **Order comes from the fixes, not from the store.** `makeIdbOutboxStore`
   keys on a random uuid, so `getAll()` returns rows in arbitrary order —
   which a `Map`-backed test fake hides completely. Batches drain, and
   `pendingFor` returns points, ordered by the fix timestamps themselves.
   Otherwise a mid-walk resume with several queued batches draws a scrambled
   polyline and inflates `distance_m`.

The live indicator asks "is anything still waiting?", not "does the OS think we
have a network?" — `CURRENT` only when online with an empty queue, `SAVING`
when batches are pending, `OFFLINE` otherwise.

### Sign-out clears this device

`signOut` used to clear the session and three pieces of React state. The outbox
database and every `pawtrail:walk:*` snapshot survived it, so a shared device
kept the previous operator's raw GPS coordinates, walk notes, care toggles and
photo paths indefinitely (review M8). Worse: the outbox is constructed only
inside Walk Mode, so no drain loop existed to clear them — they sat there until
the *next* operator opened Walk Mode, at which point they were POSTed under the
new session.

`signOut` now deletes both, after the session is gone and without throwing:
leaving someone signed in because a cleanup failed is worse than the leak. The
second half is `owner` on the outbox — a batch belonging to a different
operator is marked dead rather than sent, because RLS refusing it is a *server
answer*, so under rule 1 above it would otherwise count as an attempt and the
previous operator's route would be destroyed by the next operator merely
opening the app. An unresolved operator id disables the check; treating "not
yet known" as "not yours" would destroy the operator's own data on every cold
start.

### Device storage keys keep the retired brand name, deliberately

`pawtrail:walk:{id}` (localStorage), `pawtrail-outbox` (IndexedDB),
`pawtrail-shell-{version}` (Cache Storage) and the two `pawtrail-*` install
keys are the four places the retired brand name survives in shipping code, and
they stay (review L23 renamed the Stripe metadata keys, the seed data and the
docs; not these).

These are not labels, they are addresses. Every one names data that already
exists on an installed device, and renaming a key does not move what it points
at — it orphans it. Concretely: a renamed snapshot prefix discards an
in-progress walk's photos, notes and care toggles at the exact moment Walk Mode
resumes (which is the whole point of review H8); a renamed outbox database
abandons undelivered GPS points (M7); and the cache prefix is swept by
`startsWith("pawtrail-")` in the worker's `activate`, so renaming it without
renaming the sweep leaves every stale shell cached forever.

Doing it properly means a migration that reads both names, and a migration is
the wrong shape here: the keys are invisible to users, invisible to operators
and invisible in Stripe. Same treatment as the `*_pence` columns, which hold
cents. If they are ever renamed, the rename and the dual-read land together.

### Today shows unfinished walks regardless of their date

The sweep is only half the fix. Today loads `{ date: today }`, so a walk
started yesterday and never ended appeared on no screen in the product.
`listAbandonedWalks()` is deliberately unfiltered by date and feeds an
"Unfinished walks" section at the top of the follow-ups list — first, because
it is the only entry actively costing money. The rows link to **Walk Mode**,
not the client record: finishing the walk is what bills it and sends the
report, and END WALK is the one action that does that.

## PWA (phase 08)
`manifest.webmanifest` (name Sanpo, theme `#FEF6EA`, display standalone,
byte-approved Sanpo icons at 192/512 including maskable entries), service
worker: precache the built app shell (the hashed `.js`/`.css`/`.woff2`/`.webp`/
`.svg` assets, stamped into `__BUILD_ASSETS__` by `vite.config.ts`), IndexedDB
GPS outbox with background flush + `beforeunload` guard.

### What goes in the precache, and what does not (review M6)

The precache was every `.js` in `dist/assets`, which swept in the code-split
`mapbox-gl` chunk — 1.8 MB of a 3.0 MB precache, 59% of every install,
re-downloaded on every deploy, and executed only by the users who open a map.

The rule is **static reachability**, not size: start at the entry chunks and
follow `imports` transitively; anything reachable only through
`dynamicImports` is excluded and picked up by the worker's cache-first rule the
first time it is genuinely used. A size threshold was tried first and the build
refuted it immediately — at 512 KiB it also excluded the app entry, which is
the one chunk without which there is no offline shell at all. Size cannot tell
the shell from a lazy chunk; the module graph can, and it stays right as both
grow.

Two build-time failures rather than warnings, because both used to be silent:
a `sw.js` whose placeholders are missing (an unstamped worker has no cache
versioning **and** no precached chunks, from a green build), and a precache
containing no JavaScript at all. CI re-asserts both on the shipped `dist/sw.js`
plus the absence of any lazily-imported chunk.

### Install is per-URL, and taking over is the page's decision

`cache.addAll` is atomic: one failing asset — a CDN hiccup, a font 404, a chunk
that rolled off after a fast redeploy — voided the entire install, leaving the
user on whatever worker they had or none. Install is now per-URL under
`Promise.allSettled`, with `/index.html` **required**: best effort must not
mean installing a shell that cannot start.

`skipWaiting()` no longer runs at install. It used to, so a deploy replaced the
controller under a running session and `activate` then deleted the cache
holding that session's chunks — the next lazy import fetched a hashed file the
new deploy no longer serves, a 404 in the middle of a walk. The new worker now
waits; `UpdatePrompt` offers a reload; only accepting it posts `SKIP_WAITING`.

The update is also *found*: registration had no `update()`, no `updatefound`
and no `controllerchange`, and a browser only checks on navigation — which an
installed PWA resumed from the app switcher does rarely or never. `watchForUpdate`
covers all three triggers (already-waiting at load, installed while open, and an
hourly poll), and `hasWaitingUpdate` requires a controller so a **first**
install does not announce a new version to someone opening the app for the
first time. The reload is gated on a flag, because another tab accepting an
update also fires `controllerchange` here and reloading a walk out from under
an operator would be worse than the stale bundle.

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

## Getting back into an account (review L16)

Before this there was no recovery path. A grep for `resetPasswordForEmail` and
"Forgot" returned nothing: the magic link was the only route back in, and it is
presented as an *alternative way to sign in* rather than as recovery, so
somebody who had forgotten their password had to work that out for themselves.
For an operator, that account holds every client's entry codes.

- **SignIn gains a third mode**, `reset`, rather than a separate route — the
  person is already on the screen with their email in the field, and bouncing
  them elsewhere to retype it is the friction that makes people give up and
  text the operator instead.
- **`/reset-password` is public and not behind `RequireRole`.** The recovery
  link creates a session, but a role lookup that is slow or fails must not
  stand between somebody and the password they came to set.
- **The screen watches for a late session.** `getSession()` can resolve before
  supabase-js has finished parsing the URL fragment, so the first answer is
  null for a link that is perfectly good; without the `onAuthStateChange`
  subscription the screen settles on "link expired" and the person gives up
  holding a working link. Tested by delivering the session after the first
  render.
- **The confirmation never depends on whether the address has an account.**
  `describeResetOutcome` returns the same conditional sentence — "if that
  address has an account…" — for success and for every unrecognised failure,
  and the neutral branch is the **default** rather than a list of known-safe
  codes: a status this code has never seen must not become a disclosure by
  omission. Only two things surface: a 429 (waiting is actionable) and a
  transport failure with no status (promising an email that was never
  requested costs somebody an hour).
- **`redirectTo` must be on Supabase's allow-list**, exactly. `site_url` alone
  permits `site_url` and nothing under it, so an unlisted
  `{site}/reset-password` fails in the way hardest to report: GoTrue accepts
  the request, sends a good email, and redirects to `site_url` — the person
  arrives *signed in on Today* with no password form and no error.
  `config.toml` carries the local entries; the deployed ones are in
  `owner-actions.md`.

`lib/password-policy.ts` states the rule client-side, and the **server remains
the authority** — every place that sets a password surfaces GoTrue's own error
rather than swallowing it. The constants duplicate `supabase/config.toml`,
which is why `scripts/password-policy.test.ts` parses the toml and fails when
they stop matching; the check is deliberately no *stricter* than the server,
because a client rule that refuses a valid password locks somebody out with no
way to tell it is the client's fault.

## Prototypes are not components (review L21)

`src/prototypes/` holds UI that is finished, tested and styled but wired to
nothing. `InboxField` — a complete correspondence surface, reachable only from
the DEV-gated `/dev/inbox` — is the only occupant; there is no `messages`
table, no `api.ts` function and no production route (review H33).

The rules, and the reason each exists:

- **Nothing in `src/prototypes/` may be imported from `components/`,
  `screens/`, `lib/` or `hooks/`.** The dependency runs one way, so a prototype
  can never become load-bearing by accident.
- **A prototype owns its stylesheet and imports it itself.** CSS is not
  tree-shaken: about 200 lines of correspondence layout rode along in every
  production stylesheet for a screen that does not exist, maintained by every
  token change. Moving them cut the built stylesheet from 65.0 KB to 58.5 KB.
- **`role-contrast.test.ts` reads every stylesheet, not just
  `components.css`.** A second sheet the checker cannot see is precisely the
  hole those tests exist to close, so the file list is an input rather than a
  constant.
- **Its tests are claimed by the `dom` vitest project.** A test file matching
  no project runs nowhere, silently — and a prototype whose test runs nowhere
  is a prototype that has quietly stopped compiling.

`LiveWalkBanner` was deleted rather than moved here. It was the pre-emaki
"current moment" banner, superseded by the current-visit row inside
`TodayIllustratedSchedule`, so it was not a prototype awaiting a backend but a
retired component the DEV gallery still presented as current.

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

## Security headers (review M30)

`app/vercel.json` carries them; there is no other deploy config in the tree,
and before this there were none at all — no CSP, HSTS, `X-Content-Type-Options`,
`Referrer-Policy` or `Permissions-Policy` anywhere. The session token lives in
`localStorage`, so one XSS in the dependency tree read it and then read every
client's address with no further obstacle. That is what made H3 compound.

`script-src 'self'` is the directive doing the work — it is what stops an
injected payload executing at all — and CI fails the build if it ever gains
`'unsafe-inline'` or `'unsafe-eval'`, which would make the whole header
decorative. `frame-ancestors 'none'`, `object-src 'none'` and `base-uri 'self'`
are depth. `Permissions-Policy` grants `geolocation=(self)` and denies the
rest, because an injected iframe would otherwise inherit geolocation on a page
whose entire purpose is precise location.

`style-src 'self'` carries no `'unsafe-inline'` either, and CI now checks both
directives. **This paragraph previously said the opposite** — that
`'unsafe-inline'` "is required by ~240 inline `style={{…}}` objects" and "cannot
be tightened without that refactor". That was wrong, and wrong in the expensive
direction: it recorded a permanent weakening of the header as the price of a
refactor nobody was going to do.

React does not write a style **attribute**. It assigns through CSSOM —
`node = node.style` then per property — and CSP governs attributes and
stylesheets, not CSSOM writes. Verified rather than reasoned: the real built
bundle was served under `style-src 'self'` with the rest of the header intact,
and produced **0 violations and 0 console errors** with every inline style
applied, including one resolving a `var()`. Independently, the bundle contains
no `setAttribute("style")` and no `cssText`, and `dist/index.html` contains no
`style=` and no `<style`.

The honest limit: only the signed-out route can be loaded without a backend, so
the authenticated screens were not rendered under the tightened header. The
mechanism is screen-independent and the bundle-level checks cover all of it, but
that is an inference and the render is not.

One deliberate loosening remains, stated rather than hidden:

- **`img-src … https:`** is broad because walk photos arrive as Supabase signed
  URLs on an origin unknown at build time. The residual is that an injected
  `<img>` could beacon to any host — verified: the foreign image was NOT
  blocked while the foreign `fetch` was. Acceptable only because `script-src`
  blocks the injection that would place it.

Verified in a browser against a server replaying these exact headers, not
reasoned about: the app renders with **zero** violations, `connect-src` permits
the Supabase origin, `font-src` serves the self-hosted variable fonts, and
`worker-src blob:` permits the worker mapbox-gl builds. In the other direction,
an injected `<script>` is refused (`script-src-elem`) and never executes, and a
fetch to a foreign origin is refused (`connect-src`). Detected through the
`securitypolicyviolation` event, because a CSP-blocked `fetch` rejects with a
generic `TypeError` that is indistinguishable from a DNS failure.

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
