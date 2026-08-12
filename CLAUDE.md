# Sanpo — solo-first pet-care operations SaaS

Sanpo is the production brand and a vertical SaaS platform for independent
pet-care professionals, not a centralized dog-walking agency.

React PWA (Vite 8, React 19, TS strict, react-router-dom 6) + Supabase (Postgres 17, Auth, RLS, Realtime, Storage) + Deno edge functions + Stripe Billing + Mapbox (SVG fallback). Currency USD (integer cents — the *_pence column names are historical and hold cents). Timezone US Central — America/Chicago (UTC in DB).

Authoritative specs live in `docs/spec/`. `docs/phases/00–08` is the v1 build plan and is complete; everything after it (reskin, QC/hardening, ops, brand) is tracked in the status log below, not in phase files. Specs win over improvisation; if a spec is ambiguous, ask before deviating.

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
- Styling: the locked Indigo Emaki system in `docs/spec/05-design-system.md`
  and `docs/spec/07-indigo-emaki-visual-migration.md`. No Tailwind. Never
  restore PawTrail/Biscuit colors, Baloo, hard shadows, repeated card grids,
  decorative pet portraits, or a horizontal Sanpo logo.
- Color comes from CT-1 tokens (`--sanpo-color-*` in
  `styles/vendor/sanpo-product-color-tokens-r1.css`). Never write a raw hex in
  `components.css` — a literal bypasses the palette and its
  `prefers-contrast` overrides. Anything carrying state needs 3:1 against its
  background (WCAG 1.4.11); body text needs 4.5:1.
- Commit format: `area: summary` — e.g. `ops:`, `qc:`, `a11y:`, `docs:`,
  `brand:`, `prod:`. (`phase(NN):` applied to the v1 build plan only.)

## Workflow

The phase plan is complete, so work is no longer one-phase-per-session. For
any substantive change: read the relevant `docs/spec/` file first, make the
change, run `/validate`, commit, and append one line to the status log below.
Specs are updated in the same commit as the code they describe — a spec that
disagrees with shipped behavior is a bug in the spec.

## Ownership

Claude is the sole author of this repository. All file changes and all GitHub
interaction — branches, pull requests, reviews, merges — go through this
session. There is no external design handoff to import and no bundle to
restore; the repository is the source of truth. If a Git bundle or an
instruction to "restore" a branch arrives, check it against the current
remote before acting: replaying a stale snapshot can silently discard
reviewed work.

Design decisions that once went to an outside owner are made here now. The
Indigo Emaki system and the approved Today composition stay authoritative —
changing either is a deliberate act recorded in a commit, never a drive-by
edit. Preserve the full-screen Old Town Today composition, its vertical
responsive behavior, the schedule hierarchy, and the `END WALK` action.

`npm run verify:brand-assets` hash-guards `app/src/assets/brand`,
`app/src/assets/icons`, and the Today background. The guard catches
accidental churn; it does not freeze the files. When an asset changes on
purpose, update its hash in `app/scripts/verify-sanpo-assets.mjs` in the
same commit and say why in the message.

### How work reaches `main`

`main` is a deploy trigger, not just a branch: `deploy-staging.yml` fires on
CI completing for `branches: [main]`, which deploys staging Supabase and then
runs the staging smoke suite against it. A one-line docs commit pushed
straight to `main` does all of that.

So:

- **Never push to `main` directly.** Every change goes through a pull
  request, docs included.
- **Batch.** One PR per unit of work, not per commit — each merge is a
  staging deploy, so accumulate related commits on the working branch and
  merge once.
- **Self-review on the PR.** Post findings there rather than only in chat;
  it is the durable artifact and it survives a lost session. Reviewing your
  own work is weaker than an independent reviewer — say so, and look hardest
  at the things tests do not catch.
- **Merge on green for routine work** — docs, styling, fixes, assets, tests.
- **Ask the owner first** for anything touching the money and trust paths:
  `supabase/migrations/`, credit/ledger/billing/Stripe code, the credential
  vault, RLS or tenancy, and the deploy workflows themselves. These are where
  a mistake is expensive and hard to reverse.

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
- [x] 09 v2 "Biscuit" reskin (no phase file — since superseded by the Sanpo Indigo Emaki rebrand)

v1 is feature-complete. Everything below `phase(09)` in the log is post-v1:
hardening, ops, and brand. Migrations run through `0018`; there are 11 edge
functions.

## Status log
- phase(00): schema + credit engine + RLS + seed + smoke all green on the no-Docker local stack (scripts/db-reset.sh; docs/dev/local-stack.md). Ledger chain ordered by seq (documented in 0002); pre-commit adversarial review caught and fixed a TOCTOU in fn_expire_credits.
- phase(01): five edge functions + _lib with dep-injected handlers; 38 deno tests green (crypto roundtrip/tamper, locally-signed webhook signatures, idempotency for webhook/complete-walk/overage, vault rate limit); functions-serve boot check deferred to a Docker environment (docs/dev/local-stack.md).
- phase(02): Trailhead tokens + shell, self-hosted variable fonts, full lib layer (env/supabase/types/api/credits/format/auth-context), 15 routed placeholder screens behind RequireRole, manifest + generated icons; types.ts via scripts/gen-types.py (no-Docker typegen); 17 vitest green; headless-browser check confirms / → /signin with tokens applied.
- phase(03): 9 primitives + 6 composites + useGeolocation/useWalkChannel with throttle/batch logic extracted pure (geo.ts, gps-batcher.ts, map-fit.ts); 36 vitest green incl. 4s/8m-vs-6s/12m throttle matrix, 10-point/60s/end() flush, SVG polyline fit; /dev/kit gallery browser-checked with zero console errors and verified absent from the prod bundle.
- phase(04): SignIn (password + magic link), Onboard with role refresh, ClaimInvite (signup → fn_preview_invite via new 0006 migration → fn_claim_invite → dead-ends), working reauth() password sheet; 40 vitest green incl. role-resolution matrix; smoke extended with invite-preview assertions; docs/dev/auth-manual-test.md.
- phase(05): Dashboard (today/live/low-credit/failed strips), Roster with invite handoff, 4-tab ClientDetail, AccessVault + shared vault flows (reauth → purpose → 30s reveal, rotate, soft-revoke, audit sheet), full WalkMode (start → GPS broadcast + batched inserts → photos → toggles → complete-walk → billing banner → report preview, exit guard); 47 vitest green incl. dashboard selectors; mapbox-gl split to a lazy chunk; docs/dev/operator-manual-test.md.
- phase(06): fn_materialize_walks in 0007 (set-based, 14-day horizon, pause/paused-client/date-bound skips, pet copying, ON CONFLICT idempotency) + thin materialize-walks edge fn with 03:00 UTC cron; tests/materializer.sql proves idempotency/no-resurrection through /validate; Schedule tab (days picker, pause-window editor, deactivate-cancels-future) + Calendar day/week with drag-reschedule, action sheet, one-off creation.
- phase(07): 0008 adds cancellation cutoff (12h default, guard-trigger enforced), cached current_period_end, client booking/cancel policies + photo-read storage policies; change-plan (Stripe proration + fraction fallback) and billing-portal edge fns; PortalHome/Booking (overage confirm)/PortalWalks/WalkDetail (live subscribe)/PortalBilling/PetProfiles + operator BillingConsole (renewals, past-due, overage re-charge, plan change); smoke extended with booking/cutoff guards; docs/dev/portal-manual-test.md.
- phase(08): 0009 walk_scheduled/walk_cancelled triggers close the notification audit; bell inboxes with deep links (both personas); env-gated send-notification email fn; fn_expire_credits on the daily cron; versioned SW (shell precache, SWR data GETs, network-only mutations — offline shell reload verified headlessly, docs/dev/pwa-check.md); IndexedDB GPS outbox with backoff + reconnect backfill (grey-dot indicator); install prompt + iOS meta. Final /validate fully green — v1 feature-complete.
- ops(ci): GitHub Actions CI + staging deploy (deploy gated on green CI via `workflow_run`, checkouts pinned to the validated head_sha), staging smoke workflow that cron-invokes materialize-walks and replays the onboard/claim flows; docs/dev/staging-setup.md. Onboard made idempotent.
- ops(locale): currency GBP → USD; display/business timezone → US Central (America/Chicago). DB stays UTC; `*_pence` columns keep their names but hold cents. `withinCancellationWindow` reads walk wall-clock in Central, not the device tz.
- phase(09): v2 "Biscuit" reskin from the Claude Design mock — cream/orange neo-brutalist tokens, Nunito/Baloo 2, pop shadows. Trailhead var names kept as aliases.
- qc(1–4): eliminated silent frontend failures (retryable LoadError instead of infinite spinners; role-resolution errors no longer strand signed-in users at onboarding) and a **service-worker data leak** — cached Supabase REST responses keyed by URL served account A's rows to account B on a shared device; REST/auth/realtime/functions are now network-only. Billing correctness: webhook releases its idempotency claim on failure, cycle grants restricted to subscription_create/cycle, complete-walk bills before marking complete. Migration 0012: `walks.origin_date` (stops the materializer resurrecting drag-rescheduled walks → double-billing), pause windows cancel materialized future walks, vault ciphertext INSERT restriction, cross-tenant pet-photo folder fix.
- rereview(money): migration 0013 — `origin_date` NOT NULL, per-operator-timezone materializer horizon, `fn_apply_invoice_paid` (payment + rollover + cycle grant in one transaction keyed on the Stripe invoice id), auto-refund trigger for cancelled debited walks, `fn_book_walk`. stripe_events became a stateful claim ledger closing the claim-release race; overage moved to per-ATTEMPT idempotency keys with live Stripe reconciliation so a post-confirm DB failure can't double-charge. 67 deno tests.
- rereview(frontend/ops): SW precaches the built hashed assets (vite stamps `__BUILD_ASSETS__`) so the offline shell renders; WalkMode offline resume merges DB points with the GPS outbox; booking goes through atomic `fn_book_walk`.
- pr1: squash-imported the unmerged Codex PR #1 (tenant-consistency 0014, plan-change intents 0015, Postgres-backed vault rate limit 0016, atomic schedule RPCs 0017, async GPS flush/drain, oxlint, Playwright E2E) then fixed it — the Sheet focus trap re-ran on every parent re-render and yanked focus mid-keystroke; `end()` now awaits GPS persistence; 0018 enforces one pending plan-change intent per client. Supabase CLI pinned 2.109.1.
- prod: workflow_dispatch-only production deploy — typed confirmation phrase, refuses unless CI is green on the exact commit, environment-scoped secrets; docs/dev/production-cutover.md is the browser-only staging→live checklist.
- brand(#2): Sanpo production navigation — Today / Calendar / Clients / Money (`/`, `/calendar`, `/roster`, `/billing`), six approved 24×24 SVG icon masters under hash verification wired to `prebuild`, and the CT-1 color-role token layer.
- brand(#3): Indigo Emaki visual migration — completes PawTrail → Sanpo. `docs/spec/07` added as the implementation-and-verification spec; `tokens.css`/`global.css`/`components.css` move the product surfaces onto CT-1 roles; new `TodayIllustratedSchedule` renders the locked Today composition bound to real walk data (fixtures live only in DEV-gated preview routes, verified absent from the prod bundle); brand masters + Today background added under hash guard; 93 vitest. Reviewed on PR #3 — SW network-only protections, migration append-only rule, and the prior RequireRole/WalkMode-resume/MapView-fallback fixes all verified intact.
- a11y(emaki): the Today progress path carried two raw hex strokes outside CT-1 and a current-segment at 1.92:1 — under the 3:1 floor for the stroke showing which visit is underway. All four strokes are now token-derived; current deepened toward Kaki-strong to 3.27:1, marker moved to Kaki (4.90:1, matching spec 07). The `color-mix` sits in `@supports` because the minifier collapses two `stroke` declarations in one rule and drops the fallback — without it, a browser lacking `color-mix` paints no stroke at all.
- perf(today-field): the Today background was a 2.25 MiB PNG, and `vite.config` stamped only `.js/.css/.woff2` into the shell precache — so the primary screen rendered without its artwork on a cold offline start. Re-encoded to WebP q95 (same 875×1798 pixels, PSNR 38.8 dB, 437 KiB) and added `.webp`/`.svg` to the precache filter, which fixes the offline gap and still cuts ~1.8 MiB from the bundle. Hash updated in `verify-sanpo-assets.mjs`; PNG master recoverable at `d313486`.
- docs: reconciled this file with the tree — the status log had stopped at `phase(08)` while ~18 commits of reskin, QC, money-layer re-review, imported PR-1 fixes, ops/CI, the production deploy gate, and both brand merges had landed. Added the missing commands (lint, vitest, Playwright, deno tests, `verify:brand-assets`), recorded migrations through `0018`, replaced the external-handoff section with the sole-ownership working agreement, and wrote down the no-raw-hex/contrast rule that the emaki defect came from.
