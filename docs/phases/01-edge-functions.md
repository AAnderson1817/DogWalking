# Phase 01 — Edge functions

## Objective
The five core Deno functions + shared `_lib`, exactly per spec 04 contracts.

## Prerequisites
Phase 00 committed; local stack running.

## Deliverables
1. `supabase/functions/_lib/{admin,http,crypto,stripe}.ts` (spec 04 header).
2. `supabase/functions/complete-walk/index.ts`
3. `supabase/functions/create-checkout/index.ts`
4. `supabase/functions/stripe-webhook/index.ts` (`verify_jwt=false` in `supabase/config.toml`)
5. `supabase/functions/charge-overage/index.ts`
6. `supabase/functions/credential-vault/index.ts` (put/get/delete-as-soft-revoke, password re-verify, 5/min rate limit)
7. `supabase/functions/_tests/` — `deno test` suite: crypto encrypt→decrypt roundtrip + tamper detection (auth tag failure); webhook signature verify against a locally-generated signed payload; stripe_events idempotency guard (second insert short-circuits); complete-walk idempotency (mock).
8. `docs/dev/stripe-local.md` — Stripe CLI fixture commands (`stripe listen --forward-to`, `stripe trigger invoice.paid` etc.) for manual verification.

## Acceptance criteria
- `deno check supabase/functions/**/index.ts` clean.
- `deno test supabase/functions/_tests/` all pass.
- `supabase functions serve` boots all five without error.
- Grep proof: no `console.log` of `secret`, `password`, `ciphertext`, or decrypted values anywhere under `functions/`.

## Out of scope
change-plan (phase 07), materialize-walks (phase 06), any UI.
