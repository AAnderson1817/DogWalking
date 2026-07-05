# Phase 08 — Notifications & PWA hardening

## Objective
Close the loop on notifications and ship the installable, offline-tolerant PWA. Specs: 02 (triggers), 06 (PWA section).

## Deliverables
1. Notification wiring audit — every spec-02 trigger emits: walk_complete, low_credit (deduped), renewal_upcoming, payment_failed, walk_scheduled/walk_cancelled (booking + cancel paths from 06/07). Backfill any misses.
2. In-app inboxes: notification bell + list (operator header, portal home), mark-read, deep links to walk/billing.
3. Email delivery (env-gated on `RESEND_API_KEY`): `send-notification` edge fn + DB webhook (or trigger→pg_net) on `notifications` insert for client-facing types; pine-styled minimal HTML templates; silently skipped when key absent.
4. `fn_expire_credits` wiring: daily invocation from the materialize-walks cron (spec 04).
5. Service worker: precache shell, stale-while-revalidate GETs (API/Storage), network-only mutations, versioned cache busting on deploy.
6. Offline GPS outbox: IndexedDB queue in front of `useWalkChannel` flush; retries with backoff; survives reload mid-walk; `beforeunload` guard; UI indicator (grey dot replaces pulse-live when offline, backfills on reconnect).
7. Install prompt (Dashboard, after 2nd visit), full icon set, iOS meta tags.
8. `docs/dev/pwa-manual-test.md` — install, airplane-mode mid-walk walkthrough (points queued → flushed), Lighthouse run.

## Acceptance criteria
- Lighthouse PWA category: installable, SW registered, manifest valid (attach report to `docs/dev/`).
- Offline drill: 20+ points captured offline appear in `walk_gps_points` after reconnect; report card route complete.
- Each notification type demonstrably fires once from its trigger (manual matrix in test doc); low_credit dedupe holds across two consecutive debits.
- tsc + build + deno check + smoke.sql all clean. Final `/validate` green = v1 feature-complete.

## Out of scope
Web push, SMS, native fork.
