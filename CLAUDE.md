# Sanpo — solo-first pet-care operations SaaS

The repository and some legacy implementation comments still use the working
name PawTrail. Sanpo is the production brand and a vertical SaaS platform for
independent pet-care professionals, not a centralized dog-walking agency.

React PWA (Vite 8, React 19, TS strict, react-router-dom 6) + Supabase (Postgres 17, Auth, RLS, Realtime, Storage) + Deno edge functions + Stripe Billing + Mapbox (SVG fallback). Currency USD (integer cents — the *_pence column names are historical and hold cents). Timezone US Central — America/Chicago (UTC in DB).

Authoritative specs live in `docs/spec/`. `docs/phases/00–08` is the v1 build plan and is complete; work after v1 (reskin, QC/hardening, ops, brand) is not phase-file-driven and is tracked in the status log below. Specs win over improvisation; if a spec is ambiguous, ask before deviating.

## Layout
- `app/` — frontend (Vite)
- `supabase/` — `migrations/`, `functions/`, `tests/`, `seed.sql`
- `docs/spec/` — specs (source of truth)
- `docs/phases/` — phase files, one per session

## Commands
- Frontend typecheck: `npx tsc --noEmit -p app`
- Frontend build: `npm --prefix app run build` (runs `verify:brand-assets` via `prebuild`)
- Frontend unit tests: `npm --prefix app test -- --run` (vitest)
- Frontend lint: `npm --prefix app run lint` (oxlint, `--deny-warnings`)
- E2E: `npm --prefix app run test:e2e` (Playwright; `test:e2e:install` first)
- Brand asset integrity: `npm --prefix app run verify:brand-assets`
- DB reset + migrate + seed: `supabase db reset`
- Smoke tests: `psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/smoke.sql`
- Edge typecheck: `deno check supabase/functions/**/index.ts`
- Edge tests: `deno test -A supabase/functions/_tests/`
- Full validation: `/validate`

## Non-negotiable invariants
1. Credit balance mutations happen ONLY inside `SECURITY DEFINER` functions that take a per-client row lock (`SELECT … FOR UPDATE`). No code path ever `UPDATE`s `clients.credit_balance` or `INSERT`s into `credit_ledger` directly from an API role.
2. `access_credentials` ciphertext columns are unreadable by `anon` and `authenticated` (column-privilege REVOKE). Every read goes through the audited RPC + `credential-vault` edge function. Plaintext secrets are never logged.
3. Overage semantics: a walk is EITHER fully credit-funded OR fully charged at `plans.overage_rate_pence`. Never partial credit consumption.
4. Rollover is single-lot carryover (v1 simplification, documented in `docs/spec/02-credit-engine.md`). Do not implement per-grant FIFO.
5. Every function touching credits or crossing tenants: `SECURITY DEFINER`, `SET search_path = public`, `REVOKE ALL … FROM PUBLIC, anon`, explicit `GRANT EXECUTE` only where required.
6. Migrations are append-only once applied. Never edit an existing file in `supabase/migrations/` — create a new migration.
7. Every tenant table carries `operator_id`; every RLS policy scopes on it.

## Conventions
- TS strict; named exports for lib/components; default export only for route screens.
- Money = integer minor units (cents; *_pence columns kept their names). Dates stored UTC (`timestamptz`), rendered US Central (America/Chicago) via `lib/format.ts`.
- Styling: CSS custom properties from `docs/spec/05-design-system.md`. No Tailwind, no UI framework. Two token layers currently coexist, both pulled in by `styles/global.css`:
  1. `styles/vendor/sanpo-product-color-tokens-r1.css` — Sanpo CT-1 brand roles (`--sanpo-color-*`: Indigo, Kaki, Asagi, Matcha, Fuji, Yamabuki, Cream). Authoritative for brand, adopted so far by navigation.
  2. `styles/tokens.css` — legacy v2 "Biscuit" (cream/orange neo-brutalist) plus v1 "Trailhead" aliases. Still what most components consume.
  Migrating the remaining Biscuit surfaces onto CT-1 is in-flight — prefer `--sanpo-color-*` for new work.
- Brand assets: approved SVG masters in `app/src/assets/icons` are hash-guarded by `scripts/verify-sanpo-assets.mjs`. Changing one means updating its recorded hash deliberately.
- Commit format: `phase(NN): summary`.

## Workflow
One phase per session: `/clear` → plan mode against `docs/phases/NN-*.md` → approve → execute → `/validate` → commit → tick the phase below and append one status line.

## Phase status
- [x] 00 foundations-and-database
- [x] 01 edge-functions
- [x] 02 frontend-foundation
- [x] 03 component-kit-and-hooks
- [x] 04 auth-screens
- [x] 05 operator-core
- [x] 06 scheduling
- [x] 07 client-portal
- [x] 08 notifications-and-pwa
- [x] 09 v2 "Biscuit" reskin (no phase file — superseded in part by the Sanpo CT-1 rebrand)

v1 is feature-complete. Everything below 09 is post-v1: hardening, ops, and brand.
Migrations now run through `0018`; edge functions number 11.

## Status log
- phase(00): schema + credit engine + RLS + seed + smoke all green on the no-Docker local stack (scripts/db-reset.sh; docs/dev/local-stack.md). Ledger chain ordered by seq (documented in 0002); pre-commit adversarial review caught and fixed a TOCTOU in fn_expire_credits.
- phase(01): five edge functions + _lib with dep-injected handlers; 38 deno tests green (crypto roundtrip/tamper, locally-signed webhook signatures, idempotency for webhook/complete-walk/overage, vault rate limit); functions-serve boot check deferred to a Docker environment (docs/dev/local-stack.md).
- phase(02): Trailhead tokens + shell, self-hosted variable fonts, full lib layer (env/supabase/types/api/credits/format/auth-context), 15 routed placeholder screens behind RequireRole, manifest + generated icons; types.ts via scripts/gen-types.py (no-Docker typegen); 17 vitest green; headless-browser check confirms / → /signin with tokens applied.
- phase(03): 9 primitives + 6 composites + useGeolocation/useWalkChannel with throttle/batch logic extracted pure (geo.ts, gps-batcher.ts, map-fit.ts); 36 vitest green incl. 4s/8m-vs-6s/12m throttle matrix, 10-point/60s/end() flush, SVG polyline fit; /dev/kit gallery browser-checked with zero console errors and verified absent from the prod bundle.
- phase(04): SignIn (password + magic link), Onboard with role refresh, ClaimInvite (signup → fn_preview_invite via new 0006 migration → fn_claim_invite → dead-ends), working reauth() password sheet; 40 vitest green incl. role-resolution matrix; smoke extended with invite-preview assertions; docs/dev/auth-manual-test.md.
- phase(05): Dashboard (today/live/low-credit/failed strips), Roster with invite handoff, 4-tab ClientDetail, AccessVault + shared vault flows (reauth → purpose → 30s reveal, rotate, soft-revoke, audit sheet), full WalkMode (start → GPS broadcast + batched inserts → photos → toggles → complete-walk → billing banner → report preview, exit guard); 47 vitest green incl. dashboard selectors; mapbox-gl split to a lazy chunk; docs/dev/operator-manual-test.md.
- phase(06): fn_materialize_walks in 0007 (set-based, 14-day horizon, pause/paused-client/date-bound skips, pet copying, ON CONFLICT idempotency) + thin materialize-walks edge fn with 03:00 UTC cron; tests/materializer.sql proves idempotency/no-resurrection through /validate; Schedule tab (days picker, pause-window editor, deactivate-cancels-future) + Calendar day/week with drag-reschedule, action sheet, one-off creation.
- phase(07): 0008 adds cancellation cutoff (12h default, guard-trigger enforced), cached current_period_end, client booking/cancel policies + photo-read storage policies; change-plan (Stripe proration + fraction fallback) and billing-portal edge fns; PortalHome/Booking (overage confirm)/PortalWalks/WalkDetail (live subscribe)/PortalBilling/PetProfiles + operator BillingConsole (renewals, past-due, overage re-charge, plan change); smoke extended with booking/cutoff guards; docs/dev/portal-manual-test.md.
- phase(08): 0009 walk_scheduled/walk_cancelled triggers close the notification audit; bell inboxes with deep links (both personas); env-gated send-notification email fn (pine template); fn_expire_credits on the daily cron; versioned SW (shell precache, SWR data GETs, network-only mutations — offline shell reload verified headlessly, docs/dev/pwa-check.md); IndexedDB GPS outbox with backoff + reconnect backfill (grey-dot indicator); install prompt + iOS meta. Final /validate fully green — v1 feature-complete.
- ops(ci): GitHub Actions CI + staging deploy (deploy gated on green CI via `workflow_run`, all checkouts pinned to the validated head_sha), staging smoke workflow that cron-invokes materialize-walks and replays the onboard/claim flows; browser-only setup guide (docs/dev/staging-setup.md). Onboard made idempotent.
- ops(locale): currency GBP → USD and display/business timezone → US Central (America/Chicago). DB stays UTC; `*_pence` columns keep their names but hold cents. `withinCancellationWindow` reads walk wall-clock in Central, not the device tz.
- phase(09): v2 "Biscuit" reskin from the Claude Design mock — cream/orange neo-brutalist tokens, Nunito/Baloo 2, pop shadows, PetFace avatars. Trailhead var names kept as aliases.
- qc(1–4): eliminated silent frontend failures (retryable LoadError instead of infinite spinners across portal/operator screens; role-resolution errors no longer strand signed-in users at onboarding) and a **SW data leak** — cached Supabase REST responses keyed by URL served account A's rows to account B on a shared device; REST/auth/realtime/functions are now network-only. Billing correctness: webhook releases its idempotency claim on failure, cycle grants restricted to subscription_create/cycle, complete-walk bills before marking complete, per-walk overage idempotency key. Migration 0012: `walks.origin_date` (stops the materializer resurrecting drag-rescheduled walks as duplicates → double-billing), pause windows cancel materialized future walks, vault ciphertext INSERT restriction, cross-tenant pet-photo folder fix. Plus walk resume after reload and a GPS outbox poison-batch cap.
- rereview(money): migration 0013 — `origin_date` NOT NULL (NULLs escaped 0012's unique index), per-operator-timezone materializer horizon, `fn_apply_invoice_paid` (payment + rollover + cycle grant in one transaction keyed on the Stripe invoice id), auto-refund trigger for cancelled debited walks, `fn_book_walk`. stripe_events became a stateful claim ledger (processing/processed, lease takeover, never deleted) closing the claim-release race; overage moved to per-ATTEMPT idempotency keys with live Stripe reconciliation so a post-confirm DB failure can't double-charge. 67 deno tests.
- rereview(frontend/ops): SW precaches the built hashed assets (vite stamps `__BUILD_ASSETS__`) so the offline shell actually renders; WalkMode offline resume merges DB points with the GPS outbox; booking goes through the atomic `fn_book_walk`.
- pr1: squash-imported the unmerged Codex PR #1 (tenant-consistency 0014, plan-change intents 0015, Postgres-backed vault rate limit 0016, atomic schedule RPCs 0017, async GPS flush/drain, oxlint, Playwright E2E) then fixed it — Sheet focus trap re-ran on every parent re-render and yanked focus mid-keystroke; `end()` now actually awaits GPS persistence; 0018 enforces at most one pending plan-change intent per client. Supabase CLI pinned 2.109.1 (2.99.0 predates `local_smtp` and broke `link`).
- prod: workflow_dispatch-only production deploy — typed confirmation phrase, refuses unless CI is green on the exact commit, environment-scoped secrets, built for a required-reviewer gate; docs/dev/production-cutover.md is the browser-only staging→live checklist.
- brand(#2): Sanpo production navigation — Today / Calendar / Clients / Money (`/`, `/calendar`, `/roster`, `/billing`), six approved 24×24 SVG icon masters under hash verification (`npm run verify:brand-assets`, wired to `prebuild`), and the CT-1 color-role token layer. Inbox and Access Vault stay secondary utilities. **This is the first slice of the PawTrail → Sanpo rebrand; the rest of the UI still renders Biscuit tokens.**
