# Phase 00 — Foundations & database

## Objective
Repo scaffold + the complete database layer: schema, credit engine, security model, seeds, smoke suite. Specs: 01, 02, 03.

## Prerequisites
`supabase start` running; `LOCAL_DB_URL` exported.

## Deliverables
1. `app/` — bare Vite react-ts scaffold (`npm create vite`), untouched beyond init + `.gitignore`; real frontend work starts phase 02.
2. `supabase/migrations/0001_extensions_enums.sql` — `pgcrypto`; all enums (spec 01).
3. `0002_schema.sql` — all tables, FKs, indexes, `updated_at` triggers, operator-insert trigger seeding default service types, `access_credentials.revoked_at` (spec 04 soft-delete rule).
4. `0003_credit_engine.sql` — every function in spec 02 + ledger insert trigger maintaining `clients.credit_balance` and computing `balance_after` under the row lock.
5. `0004_security.sql` — helper predicates, RLS enable+force, full policy set, column-privilege REVOKEs, function REVOKE/GRANT catalog, storage bucket policies — exactly the spec 03 matrix.
6. `0005_seed_defaults.sql` — anything schema-level remaining (bucket creation via `storage.buckets` insert).
7. `supabase/seed.sql` — dev-only demo data: one operator, two clients (one with plan), properties, pets, one credential row (dummy ciphertext), service types, a completed walk with GPS points.
8. `supabase/tests/smoke.sql` — single psql script, `ON_ERROR_STOP`, using `set_config('request.jwt.claims', …)` + `set role` to simulate personas. Scenario: grant 10 → debit walk (cost 1) → balance 9 → debit with insufficient balance → outcome overage, balance unchanged → adjust +2 → rollover under each of the three policies (fresh fixture clients) → expiry sweep on an expired lot → ledger chain-integrity query returns 0 violations → all six security assertions from spec 03 §smoke. Ends `RAISE NOTICE 'SMOKE PASS'`.
9. `.env.example` mirroring the HANDOFF key table.

## Acceptance criteria (all must pass)
- `supabase db reset` completes cleanly (applies 0001–0005 + seed).
- `psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/smoke.sql` exits 0 with `SMOKE PASS`.
- `grep -R "UPDATE clients SET credit_balance" supabase/migrations | grep -v fn_` → only occurrences inside definer function bodies.

## Out of scope
Edge functions, any frontend beyond the bare scaffold, Stripe.
