# Phase 04 — Auth screens

## Objective
Working entry flows for both personas against the local stack.

## Deliverables
1. `SignIn` — email+password, magic-link option, error states, redirect to persona home via auth-context role resolution.
2. `Onboard` — first-run operator: creates `operators` row (business name, display name, phone; defaults GBP/Europe/London/threshold 2), lands on Dashboard. Guard: skips if row exists.
3. `ClaimInvite` (`/claim/:token`) — validates token via `api.previewInvite` (definer fn or filtered select on invite_token), signup form, then `fn_claim_invite(token)`; lands on `/portal`. Invalid/claimed token → styled dead-end.
4. `reauth()` in auth-context: password-confirm `Sheet` returning the password string for vault calls (never stored beyond the call).
5. `docs/dev/auth-manual-test.md` — scripted walkthrough: create operator → onboard → create client row + grab invite_token from Studio → claim in incognito → verify portal role + RLS isolation (client sees only own data).

## Acceptance criteria
- tsc + build clean.
- Manual script executes end-to-end against `supabase start` with zero console errors.
- Vitest: role-resolution logic in auth-context (operator row / client row / neither) with mocked queries.

## Out of scope
Operator/portal screen content beyond landing.
