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

## Realtime authorization matrix (`realtime.messages`, migration 0020)

The RLS matrix above governs durable rows. It does **not** govern the live
Realtime stream, and that omission is why the live-GPS topic shipped public:
readable *and writable* by any holder of the anon key, which is compiled into
the shipped bundle (review H1). A stream that mirrors a table needs the
table's tenancy rules restated for it, in the place Realtime actually reads.

Supabase applies authorization only to **private** channels, and only through
RLS policies on `realtime.messages`. A `SELECT` policy grants permission to
*receive* on a topic; an `INSERT` policy grants permission to *send*. Realtime
evaluates them at connect time with the joining user's JWT.

| Topic | Operator (walk's `operator_id`) | Client (walk's `client_id`) | Other tenants | anon |
|---|---|---|---|---|
| `walk:{walk_id}` | receive + send | receive only | — | — |

Mirrors `walk_gps_points` exactly, with one deliberate asymmetry: the client
may **never** send. They are the audience for the proof of service, and a
client who can write to the stream can fabricate or terminate their own
evidence of a visit.

Rules:

- **Exactly one channel exists in this application.** `realtime.messages` is
  deny-by-default, and `walk:{uuid}` is the only topic any policy authorizes.
  A new channel needs a new policy in a new migration, and CI fails a
  `supabase.channel()` call outside `useWalkChannel.ts`.
- **Both sides declare `private: true`** — the client channel config and the
  server's `_lib/broadcast` publish. `private` defaults to *false* in
  `realtime-js`, so omitting the option is the same defect as writing
  `private: false`, and is invisible in review. CI checks both.
- **Topic parsing never raises.** `fn_walk_channel_access` regex-guards before
  the uuid cast: an error inside a policy on a shared platform table would
  affect every channel on the project, not just this one.
- **The service role bypasses RLS**, which is how the edge function publishes
  the `ended` event without a policy granting it anything.

**This is not complete without one dashboard setting.** Policies govern
private channels; they do not stop a third party opening the same topic as a
*public* channel. That is the project-level "Allow public access" toggle in
Realtime settings, which no migration and no file in this repository can set —
there is no such key in `config.toml`, and neither deploy workflow runs
`supabase config push` (review H2). Until it is off for a project, this
hardens our own client and leaves the old door open for everyone else.
`docs/dev/realtime-authorization.md` has the steps and how to verify them.

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
| fn_vault_census, fn_vault_rewrap_batch, fn_vault_rewrap_apply, fn_vault_set_canary | service_role only (0021; rotation is an operational act, and the census spans every tenant) |
| fn_claim_invite(p_token) | authenticated |
| is_operator, my_client_id | authenticated |

Body-level tenancy check is mandatory in every definer fn (RLS does not apply inside definer context): assert the target row's `operator_id`/`client_id` matches the caller or that the caller is service role.

## Vault design (invariant 2)
- App-layer AES-256-GCM in the credential-vault edge function; key = `VAULT_MASTER_KEY` (32-byte base64, edge secret, **never in the DB — and never generated in the SQL editor either**, which puts it there by another route).
- Stored blob (v2, migration 0021) = `version(1) ‖ key_id(8) ‖ iv(12) ‖ ct‖tag` in `access_credentials.ciphertext bytea`. WebCrypto's output is stored verbatim; there is no tag/ciphertext transposition, so no code outside `_lib/crypto.ts` knows an offset.
- **Key identity.** `key_id` is HKDF-SHA-256-derived from the master key under `sanpo/vault/v2/key-id`, with the encryption key derived under the disjoint label `sanpo/vault/v2/aes-256-gcm`. Derived, not declared: a declared id is a second thing to keep in sync and its failure mode — right key, wrong id — is the class of failure this design exists to remove. HKDF rather than hashing or HMAC-ing the key directly because those use one key for two primitives with no standard reduction.
- **Two keys coexist.** `VAULT_MASTER_KEY` encrypts and decrypts; `VAULT_MASTER_KEY_PREVIOUS` decrypts only, and the literal `none` is its tombstone. Decryption routes strictly by the id in the blob — never trial decryption, which would reintroduce the ambiguity the id removes. A mixed fleet on mixed keys is the normal state during a rotation.
- **Row binding.** A 56-byte fixed-length AAD of `"sanpo/vault/aad" ‖ version ‖ key_id ‖ credential_id ‖ operator_id`, uuids as raw bytes. Fixed-length because a delimited encoding is injective only by a property of the values; raw bytes because it makes uuid casing structurally irrelevant. A ciphertext moved to another row or another tenant no longer decrypts. `property_id` is deliberately excluded: `credential_id` already pins the row, and including it would forbid ever moving a credential between an operator's own properties without a rewrap.
- **Distinguishable failures.** `key_unknown` (recoverable — supply the key), `decrypt_failed` (tampering or a relocated row), `blob_unsupported_version`, `blob_malformed`. The old format collapsed all of these into one `decrypt_failed`, so the vault could not tell a custody problem from an attack.
- **`access_credentials.key_id`** is a GENERATED column derived from the ciphertext. It cannot drift, cannot be forged and cannot be left stale — Postgres refuses to update it for every role. Not granted to `authenticated`.
- **The canary** (`vault_canary`) is the per-environment key pin: a known plaintext under the current key, decrypted through the live function by the deploy. A wrong key therefore fails at deploy time rather than at a client's front door. It is per-environment by construction, so staging and production pin different keys with nothing to keep in sync.
- **Rotation** is `fn_vault_rewrap_batch` → decrypt/re-encrypt in the edge function → `fn_vault_rewrap_apply`, a compare-and-swap on the exact ciphertext read. The work queue is the data (`key_id <> current`), so a rewrap is idempotent, resumable and needs no journal. Retirement is gated on `fn_vault_census`, which returns four numbers rather than one: `on_other = 0` alone is also true when nothing is visible, so the parts must add up to the whole. Runbook: `docs/dev/vault-key-rotation.md`.
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
7. Vault key identity (0021): `key_id` is derived from the ciphertext and cannot be written by any role; a pre-v2 blob reports NULL rather than a plausible id; the census's parts sum to its total; the rewrap queue selects only rows off the current key; the compare-and-swap accepts a correct expectation, refuses a stale one without clobbering, and refuses a replacement that is not a v2 blob under the promised key; the canary refuses a non-v2 pin; and an operator JWT can execute none of it and cannot read `key_id` or `vault_canary`.
8. Realtime walk channel (0020): the walk's operator receives **and** sends; its client receives but is refused on send; a foreign operator and another operator's client are refused on both, while that client is still allowed on their own walk; anon is refused; and malformed, foreign-namespace, unknown-walk and null topics all return false rather than raising. Asserted on `fn_walk_channel_access` for the matrix and through `realtime.messages` itself for the two policies, so a correct function behind unwired policies still fails.
