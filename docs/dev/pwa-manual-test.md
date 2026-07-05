# Notifications & PWA — manual walkthrough (phase 08)

Prereqs: production build (`npm --prefix app run build` with env set) served
via `npm --prefix app run preview`, plus the running stack. An automated
verification of the installability fundamentals lives in
docs/dev/pwa-check.md and can be re-run headlessly at any time.

## 1. Install
1. Chrome (desktop or Android) on the preview URL → the address-bar install
   affordance appears (manifest: standalone, 192/512 any+maskable icons,
   theme #0E2A23).
2. Visit the Dashboard twice (visit counter) → the pine install banner
   appears; Install triggers the native prompt; ✕ dismisses permanently.
3. iOS Safari: Share → Add to Home Screen → black-translucent status bar,
   PawTrail title (apple meta tags).

## 2. Offline drill — airplane mode mid-walk
1. Start a walk (Walk Mode), let a few GPS points record with the network
   on (sensor simulation: move ≥10 m every ≥5 s).
2. Enable airplane mode / DevTools offline. The pulse-live dot turns GREY
   with "offline — points queued"; keep moving 20+ points.
3. `walk_gps_points` receives nothing while offline; IndexedDB
   (`pawtrail-outbox` → gps-batches) accumulates batches.
4. Reconnect → batches flush automatically (online listener + backoff
   loop); the rows appear in `walk_gps_points`; IndexedDB drains to empty.
5. Reload mid-walk while offline → the shell loads from the versioned
   cache; on reconnect the leftover outbox batches backfill (drain on
   mount). End the walk → the report card route is complete.

## 3. Notification matrix — each type fires exactly once from its trigger
| Type | Trigger | Check |
|---|---|---|
| walk_complete | complete-walk edge fn | client row + report link |
| low_credit | debit leaving balance ≤ threshold | client + operator rows; a SECOND debit while the first is unread adds NOTHING (dedupe) — read it, debit again → fires again |
| renewal_upcoming | stripe `invoice.upcoming` | client row |
| payment_failed | `invoice.payment_failed` / overage decline | client + operator rows |
| walk_scheduled | portal booking (→ operator) or calendar one-off (→ client); nightly materializer stays silent | one row per booking |
| walk_cancelled | either side cancels (→ the other party) | one row per cancel |

Bell inboxes (Dashboard + PortalHome): unread badge count, mark-read on ✓
or tap, deep links to the walk / billing surface.

## 4. Email delivery (env-gated)
1. Without RESEND_API_KEY: POST send-notification with a notification id →
   `{ skipped: true }`; nothing else happens (silent skip).
2. With the key set: client-facing types deliver the pine-styled email;
   operator-facing rows (client_id null) are skipped.
3. Hosted wiring: add a Database Webhook on INSERT into `notifications` →
   send-notification with the service key (see 0009 migration note).

## 5. Credit expiry cron
`materialize-walks` responses include `expired_clients` — run it manually
and confirm `fn_expire_credits` swept an artificially expired lot
(supabase/tests/smoke.sql exercises the SQL path).

## 6. Cache busting
Build twice; each `dist/sw.js` carries a fresh `VERSION`; after deploying
a new build and reloading twice, old `pawtrail-*` caches are deleted
(activate handler).
