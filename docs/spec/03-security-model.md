# 03 — Security model

Two authenticated personas share the `authenticated` Postgres role, distinguished by data: **operator** (`operators.id = auth.uid()`) and **client** (`clients.auth_user_id = auth.uid()`). Helper predicates (STABLE, `SECURITY DEFINER` to avoid RLS recursion): `is_operator()`, `my_client_id()`.

## RLS matrix (RLS enabled + FORCED on every table)
| Table | Operator (`operator_id = auth.uid()`) | Client (own rows via `client_id = my_client_id()`) | anon |
|---|---|---|---|
| operators | select/update own row | select `display_name,business_name` of own operator only (view `v_my_operator`) | — |
| clients | full CRUD | select own row; update own contact fields only (column grants) | — |
| properties | full CRUD | select own; update `access_notes_public` only | — |
| access_credentials | insert/update/delete metadata; **no select on `ciphertext`** | **no access at all** | — |
| credential_access_log | select own | — | — |
| pets | full CRUD | select own; update care fields (temperament, feeding, medical, vet, photo) | — |
| service_types | full CRUD | select (for booking UI) | — |
| plans | full CRUD | select own plan | — |
| recurring_schedules / schedule_pets | full CRUD | select own | — |
| walks / walk_pets | full CRUD | select own | — |
| walk_gps_points | insert (own walks) / select | select own (live tracking + report route) | — |
| walk_photos | insert/select/delete | select own | — |
| credit_ledger | select | select own | — |
| payments | select | select own | — |
| notifications | select/update `read_at` (operator rows) | select/update `read_at` (own rows) | — |
| stripe_events | — (service role only) | — | — |

`anon` gets nothing except `EXECUTE` on `fn_claim_invite(token uuid)` (looks up client by invite_token, binds `auth_user_id`, flips status → active; called post-signup so effectively authenticated) — implement as authenticated-only; anon truly gets zero.

## Column privileges (beyond RLS)
- `REVOKE UPDATE (credit_balance, plan_id, subscription_status, stripe_customer_id, stripe_subscription_id, invite_token) ON clients FROM authenticated;` — balance unforgeable even by the operator's own JWT (invariant 1); plan/subscription fields move only via definer fns/webhook.
- `REVOKE INSERT, UPDATE, DELETE ON credit_ledger FROM authenticated;` grant SELECT only. Sole write path = definer functions.
- `REVOKE SELECT (ciphertext) ON access_credentials FROM authenticated, anon;` — metadata visible to operator, secret bytes never (invariant 2).
- `REVOKE UPDATE, DELETE ON credential_access_log FROM authenticated;` append via definer fn only.
- `REVOKE ALL ON stripe_events, payments FROM authenticated` except `GRANT SELECT ON payments`.
- `walks.credits_debited`, `walks.is_overage`: no UPDATE grant to authenticated — set only inside `fn_debit_walk`.

## Definer function catalog + grant pattern
Every definer fn: `SECURITY DEFINER SET search_path = public`, then
```
REVOKE ALL ON FUNCTION fn_x(…) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_x(…) TO <role list>;
```
| Function | EXECUTE granted to |
|---|---|
| fn_grant_credits, fn_apply_rollover, fn_change_plan, fn_expire_credits | service_role only (webhook/cron) |
| fn_debit_walk | service_role only (complete-walk fn) |
| fn_adjust_credits | authenticated (body re-verifies caller is the operator of p_client) |
| fn_walk_cost | authenticated |
| fn_read_credential(p_credential, p_purpose) | service_role only |
| fn_claim_invite(p_token) | authenticated |
| is_operator, my_client_id | authenticated |

Body-level tenancy check is mandatory in every definer fn (RLS does not apply inside definer context): assert the target row's `operator_id`/`client_id` matches the caller or that the caller is service role.

## Vault design (invariant 2)
- App-layer AES-256-GCM in the credential-vault edge function; key = `VAULT_MASTER_KEY` (32-byte base64, edge secret, never in DB). Stored blob = `iv(12) ‖ tag(16) ‖ ciphertext` in `access_credentials.ciphertext bytea`.
- Write path: operator submits plaintext over TLS to credential-vault (action `put`) → encrypt → insert/update row. Plaintext never persisted, never logged.
- Read path: credential-vault (action `get`) → verifies fresh re-auth (operator supplies password; function verifies via Auth admin sign-in check; reject if fail; rate-limit 5/min/user) → calls `fn_read_credential` which (a) asserts operator owns the credential, (b) INSERTs `credential_access_log` row with purpose, (c) returns ciphertext to service role → decrypt → return plaintext fields in response body only.
- Client persona: zero read/write on `access_credentials`. Clients communicate new codes out-of-band or via `properties.access_notes_public` for non-secrets; secrets are operator-entered (documented product boundary).

## Smoke-test security assertions (phase 00 suite must prove)
1. As client A JWT: select on client B's rows across clients/pets/walks/ledger → 0 rows.
2. As operator JWT: `UPDATE clients SET credit_balance = 999` → permission denied.
3. As operator JWT: `SELECT ciphertext FROM access_credentials` → permission denied; `SELECT id, label` succeeds.
4. As operator JWT: direct `INSERT INTO credit_ledger …` → permission denied.
5. As anon: every table select → denied/0 rows; `EXECUTE fn_grant_credits` → denied.
6. Ledger chain integrity query returns 0 violations after the full grant/debit/rollover scenario run.
