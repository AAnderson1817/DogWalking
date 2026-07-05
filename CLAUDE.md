# PawTrail — solo-first dog-walking operations SaaS

React PWA (Vite 5, React 18, TS strict, react-router-dom 6) + Supabase (Postgres 16, Auth, RLS, Realtime, Storage) + Deno edge functions + Stripe Billing + Mapbox (SVG fallback). Currency GBP (pence integers). Timezone Europe/London (UTC in DB).

Authoritative specs live in `docs/spec/`. Build plan in `docs/phases/00–08`. Specs win over improvisation; if a spec is ambiguous, ask before deviating.

## Layout
- `app/` — frontend (Vite)
- `supabase/` — `migrations/`, `functions/`, `tests/`, `seed.sql`
- `docs/spec/` — specs (source of truth)
- `docs/phases/` — phase files, one per session

## Commands
- Frontend typecheck: `npx tsc --noEmit -p app`
- Frontend build: `npm --prefix app run build`
- DB reset + migrate + seed: `supabase db reset`
- Smoke tests: `psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/smoke.sql`
- Edge typecheck: `deno check supabase/functions/**/index.ts`
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
- Money = integer pence. Dates stored UTC (`timestamptz`), rendered Europe/London via `lib/format.ts`.
- Styling: CSS custom properties from `docs/spec/05-design-system.md` (Trailhead theme). No Tailwind.
- Commit format: `phase(NN): summary`.

## Workflow
One phase per session: `/clear` → plan mode against `docs/phases/NN-*.md` → approve → execute → `/validate` → commit → tick the phase below and append one status line.

## Phase status
- [x] 00 foundations-and-database
- [x] 01 edge-functions
- [x] 02 frontend-foundation
- [x] 03 component-kit-and-hooks
- [x] 04 auth-screens
- [ ] 05 operator-core
- [ ] 06 scheduling
- [ ] 07 client-portal
- [ ] 08 notifications-and-pwa

## Status log
- phase(00): schema + credit engine + RLS + seed + smoke all green on the no-Docker local stack (scripts/db-reset.sh; docs/dev/local-stack.md). Ledger chain ordered by seq (documented in 0002); pre-commit adversarial review caught and fixed a TOCTOU in fn_expire_credits.
- phase(01): five edge functions + _lib with dep-injected handlers; 38 deno tests green (crypto roundtrip/tamper, locally-signed webhook signatures, idempotency for webhook/complete-walk/overage, vault rate limit); functions-serve boot check deferred to a Docker environment (docs/dev/local-stack.md).
- phase(02): Trailhead tokens + shell, self-hosted variable fonts, full lib layer (env/supabase/types/api/credits/format/auth-context), 15 routed placeholder screens behind RequireRole, manifest + generated icons; types.ts via scripts/gen-types.py (no-Docker typegen); 17 vitest green; headless-browser check confirms / → /signin with tokens applied.
- phase(03): 9 primitives + 6 composites + useGeolocation/useWalkChannel with throttle/batch logic extracted pure (geo.ts, gps-batcher.ts, map-fit.ts); 36 vitest green incl. 4s/8m-vs-6s/12m throttle matrix, 10-point/60s/end() flush, SVG polyline fit; /dev/kit gallery browser-checked with zero console errors and verified absent from the prod bundle.
- phase(04): SignIn (password + magic link), Onboard with role refresh, ClaimInvite (signup → fn_preview_invite via new 0006 migration → fn_claim_invite → dead-ends), working reauth() password sheet; 40 vitest green incl. role-resolution matrix; smoke extended with invite-preview assertions; docs/dev/auth-manual-test.md.
