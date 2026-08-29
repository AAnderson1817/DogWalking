# 03 — Security model

Two authenticated personas share the `authenticated` Postgres role, distinguished by data: **operator** (`operators.id = auth.uid()`) and **client** (`clients.auth_user_id = auth.uid()`). Helper predicates (STABLE, `SECURITY DEFINER` to avoid RLS recursion): `is_operator()`, `my_client_id()`.

## RLS matrix (RLS enabled + FORCED on every table)

**"Every table" is asserted from the catalogue, not from a list.** `0004`
enabled RLS by iterating a literal array of the 18 tables that existed in
`0002`, and `smoke.sql` re-hardcoded the same array — so three tables added
later were invisible to both: `plan_change_intents` and
`vault_rate_limit_attempts` had no RLS at all, and `job_runs` was enabled but
never FORCED (review M31). No live exposure, because the grants held and
PostgREST could reach none of them — which is the point: the only thing
standing there was a single `revoke`, and one future blanket `grant` would have
failed open with nothing to catch it.

`0032` enables and forces all three, and both the migration and `smoke.sql`
now derive the set from `pg_class`. The smoke check lives outside the migration
deliberately: a migration asserts once, when it applies, so a table added in a
later migration would never be looked at again. Assertion 6 runs after every
migration on every CI database job, and its exemption list is empty — adding a
name there requires writing a reason next to it.

Note the anon sweep (assertion 5) tests **grants**, not RLS: a table with no
grant to `anon` raises `insufficient_privilege` and the loop swallows it, so an
unprotected table passes it. Verified by adding a grantless table — the sweep
stayed green and assertion 6 caught it. They are two controls and they need two
assertions.

| Table | Operator (`operator_id = auth.uid()`) | Client (own rows via `client_id = my_client_id()`) | anon |
|---|---|---|---|
| operators | select/update own row | select `display_name,business_name` of own operator only (view `v_my_operator`) | — |
| clients | full CRUD | select own row; update own contact fields only (column grants) | — |
| properties | full CRUD | select own; update `access_notes_public` only | — |
| access_credentials | insert/update/delete metadata; **no select on `ciphertext`** | select own property's METADATA only (0030); **never `ciphertext`** | — |
| credential_access_log | select own; **no insert/update/delete at all** (0030) | select own property's trail (0030) | — |
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

## Storage matrix (`storage.objects`)

Nine policies govern photographs of customers' homes and pets, and this
document did not mention them until review H20 — which also found the tests
did not either: `smoke.sql` contained zero occurrences of "storage".

Path convention: **`{operator_id}/{entity_id}/{uuid}.jpg`**. Segment 1 is the
tenant; segment 2 is the walk (in `walk-photos`) or the pet (in `pet-photos`).

| Bucket | Operator | Client |
|---|---|---|
| `walk-photos` | insert/select/update/delete where segment 1 = `auth.uid()` | select where segment 2 is a walk of `my_client_id()` **and** segment 1 is that walk's operator |
| `pet-photos` | insert/select/update/delete where segment 1 = `auth.uid()` | select **and** insert where segment 2 is a pet of `my_client_id()` **and** segment 1 is that pet's operator |

Two rules, both learned the hard way:

- **Every client policy checks segment 1 as well as segment 2**, read and
  write alike. Checking only the entity let a client write into another
  tenant's folder (closed in 0012) and — the read direction, closed in 0033 —
  let operator B upload `{B}/{walk_of_A}/x.jpg` into their own folder, which
  `storage_operator_insert` permits because segment 1 is B's own uid, and have
  operator A's client read it as part of their walk report. Nothing of A's
  leaks out; B injects images INTO the proof of service A's client receives,
  which is why it reads as a trust failure rather than a breach and why it sat
  unnoticed while two of the three sibling policies were fixed.
- **Every reference to the object's path is qualified `storage.objects.name`.**
  A bare `name` inside `exists (select 1 from pets p …)` binds to `pets.name`,
  because that table has a `name` column — so the predicate asked whether the
  second path segment of the string "Luna" was a pet id, and both client
  pet-photo policies were dead from 0008 until 0031. The sibling walk-photo
  policy is identical in form and correct only because `walks` has no `name`
  column to capture it. Confirmed by reading `pg_policies`, which renders the
  two as `foldername(p.name)` and `foldername(objects.name)` respectively.

`smoke.sql` now asserts the matrix from both personas, in both directions:
each denial is paired with the corresponding grant, because a policy that
denies everything satisfies every negative test on its own.

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

## Re-auth assurance (review H2)

Every vault action re-verifies the operator's password. That alone was
defeatable by a **session-only** attacker: with `secure_password_change` off
(the Supabase default, and never deployed — see below),
`supabase.auth.updateUser({ password })` succeeds from a live session with no
knowledge of the current password, and the vault check is then satisfied by the
password the attacker just set. The re-auth was ceremony.

The vault now reads the request token's `aal` claim and resolves three cases:

| Outcome | Condition | Result |
| --- | --- | --- |
| `aal2` | a second factor was presented in this session | allowed |
| `aal1_no_factor` | the account has no verified factor | allowed, at reduced assurance |
| `insufficient` | a verified factor exists but this session did not use it | **refused** |

Graduated deliberately: requiring `aal2` unconditionally would lock out every
operator who has not yet enrolled a factor. So **enrolling a factor is what
closes the exploit**, with no further code change — and an attacker cannot
manufacture `aal2`, since it needs the factor itself. A *missing* claim counts as
`aal1`, never as strong; reading strength from an absent claim would be the gate
failing open.

`aal2` is not merely the strongest available control here, it is the **only**
one that closes this path. Turning on `secure_password_change` — the obvious
remedy, and what an earlier version of this section prescribed — does not:
GoTrue requires reauthentication for a password change only once a session is
older than 24h, so a freshly stolen session changes the password unchallenged.
A session timebox under 24h removes even that residue, because no session can
then reach the threshold. `docs/dev/auth-posture.md` carries the full argument
and the read-back that prompted it.

The claim read is unverified, and safe for the same reason `isServiceAuth`'s is:
every function using it deploys with `verify_jwt` on, so the gateway has already
rejected forged tokens. Never pair either with `verify_jwt = false`.

**`config.toml` is not the deployed auth config.** Neither workflow runs
`supabase config push`, so the file governs `supabase start` only, and the real
settings live in a dashboard. `staging-smoke.yml`'s `auth-posture` job now reads
them back through the Management API and fails on the two that decide whether
the re-auth means anything. `docs/dev/auth-posture.md` records the intended
values, why `config push` is deliberately not wired up yet, and the open
billing decision.

## Column privileges (beyond RLS)
- `REVOKE UPDATE (credit_balance, plan_id, subscription_status, stripe_customer_id, stripe_subscription_id, invite_token) ON clients FROM authenticated;` — balance unforgeable even by the operator's own JWT (invariant 1); plan/subscription fields move only via definer fns/webhook.
- `REVOKE INSERT, UPDATE, DELETE ON credit_ledger FROM authenticated;` grant SELECT only. Sole write path = definer functions.
- `REVOKE SELECT (ciphertext) ON access_credentials FROM authenticated, anon;` — metadata visible to operator, secret bytes never (invariant 2).
- `REVOKE INSERT, UPDATE, DELETE ON credential_access_log FROM authenticated;` plus a
  `BEFORE UPDATE OR DELETE` block trigger (0030). Append via definer fn only — and INSERT is
  revoked too, because an operator forging a `read` row would attribute an entry to a time,
  which is worse than a missing trail.
- `REVOKE ALL ON stripe_events, payments FROM authenticated` except `GRANT SELECT ON payments`.
- `walks.credits_debited`, `walks.is_overage`: no UPDATE grant to authenticated — set only inside `fn_debit_walk`.

## Definer function catalog + grant pattern
Every definer fn: `SECURITY DEFINER SET search_path = public`, then
```
REVOKE ALL ON FUNCTION fn_x(…) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_x(…) TO <role list>;
```
This catalogue used to be hand-written and listed **11** functions. There are
**48**. It was presented as the complete grant-audit checklist, so an engineer
adding a definer function and checking their grants against it had no idea 37
peers existed (review H21) — the opposite of what a checklist is for. It is
generated now, and CI fails when it and the migrations disagree.

The generator bounds each function's text by the next `create … function`
rather than by a fixed window, which matters: a naive window reports 52,
because four trigger and helper functions that are *not* definer
(`fn_is_service_session`, `fn_ledger_block_mutation`,
`fn_credential_log_block_mutation`, `fn_default_walk_origin`) sit next to ones
that are. It also takes each function's LAST definition, since `create or
replace` in a later migration is what Postgres actually has.

<!-- BEGIN GENERATED DEFINER CATALOG -->

53 `SECURITY DEFINER` functions, in migration order. Generated by
`scripts/gen-definer-catalog.py`; CI fails if this table and the migrations
disagree, so adding a definer function without regenerating breaks the build.

*Granted to* is the union of every `GRANT EXECUTE` across all migrations for
that name. **none** means no API role can call it — service-role and other
definer functions only, which is the correct default.

| Function | EXECUTE granted to |
|---|---|
| `fn_seed_operator_defaults` | **none** |
| `fn_ledger_apply` | **none** |
| `fn_grant_credits` | **none** |
| `fn_walk_cost` | `authenticated` |
| `fn_debit_walk` | **none** |
| `fn_adjust_credits` | `authenticated` |
| `fn_apply_rollover` | **none** |
| `fn_expire_credits` | **none** |
| `fn_change_plan` | **none** |
| `fn_claim_invite` | `authenticated` |
| `fn_read_credential` | **none** |
| `fn_notify_low_credit` | **none** |
| `is_operator` | `authenticated` |
| `my_client_id` | `authenticated` |
| `fn_guard_clients_update` | **none** |
| `fn_guard_properties_update` | **none** |
| `fn_guard_pets_update` | **none** |
| `fn_preview_invite` | `authenticated` |
| `fn_materialize_walks` | **none** |
| `fn_guard_walks_client_update` | **none** |
| `fn_notify_walk_changes` | **none** |
| `fn_cancel_paused_walks` | **none** |
| `fn_apply_invoice_paid` | **none** |
| `fn_refund_cancelled_debit` | **none** |
| `fn_book_walk` | `authenticated` |
| `fn_assert_tenant_consistency` | **none** |
| `fn_apply_plan_change_intent` | **none** |
| `fn_assert_plan_change_intent_tenant` | **none** |
| `fn_vault_allow_attempt` | **none** |
| `fn_set_schedule_pets` | `authenticated` |
| `fn_deactivate_schedule` | `authenticated` |
| `fn_record_plan_change_intent` | **none** |
| `fn_walk_channel_access` | `authenticated` |
| `fn_vault_census` | **none** |
| `fn_vault_rewrap_batch` | **none** |
| `fn_vault_rewrap_apply` | **none** |
| `fn_vault_set_canary` | **none** |
| `fn_grant_cycle_credits` | **none** |
| `fn_reverse_payment` | **none** |
| `fn_operator_can_charge` | `authenticated` |
| `fn_run_nightly_jobs` | **none** |
| `fn_job_health` | **none** |
| `fn_notification_backlog` | **none** |
| `fn_expire_notification_backlog` | **none** |
| `fn_log_credential_action` | **none** |
| `fn_write_credential` | **none** |
| `fn_rotate_credential` | **none** |
| `fn_revoke_credential` | **none** |
| `fn_supersede_settled_failures` | **none** |
| `fn_account_has_password` | `authenticated` |
| `fn_sweep_abandoned_walks` | **none** |
| `fn_unsubscribe_by_token` | **none** |
| `fn_email_suppressed` | **none** |

<!-- END GENERATED DEFINER CATALOG -->

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
- Read path: credential-vault (action `get`) → verifies fresh re-auth (operator supplies password; function verifies via Auth admin sign-in check; reject if fail; rate-limit 5/min/user) → calls `fn_read_credential` which (a) asserts operator owns the credential, (b) validates any `walk_id` against operator AND property, (c) logs a `read` row with purpose, IP and user agent, (d) returns ciphertext to service role → decrypt → return plaintext fields in response body only.
- Client persona: **selects their own property's credential metadata and its audit trail** (0030), and never `ciphertext`. Secrets remain operator-entered; new codes still travel out-of-band or via `properties.access_notes_public`.

### The audit trail (revised — review H3)

This spec used to authorise a log written in **one** place, on a successful
reveal. That was the wrong decision for a product whose trust mechanism *is* the
audit trail, and it is what an insurance underwriter examines hardest.

- **Five actions**, all logged: `read`, `create`, `rotate`, `revoke`,
  `reauth_failed`. Before 0030 only the first wrote a row, so a rotation left
  nothing but a `rotated_at` that the next rotation overwrote, and a password
  attack against the vault left no trace at all.
- **Every row carries IP and user agent.** The only IP previously captured lived
  in `vault_rate_limit_attempts` and was deleted by the next attempt past the
  60-second window.
- **`walk_id` is optional and validated.** The purpose is typed by whoever is
  reading; the walk is the half the system can vouch for. A reference to a walk
  that was not this operator visiting this property is refused, because it would
  make the trail worse than empty.
- **Append-only, enforced twice**: `INSERT`/`UPDATE`/`DELETE` revoked from
  `authenticated`, and a `BEFORE UPDATE OR DELETE` trigger that raises — the
  same shape as `credit_ledger`. The log had neither before, so the operator
  whose reads it records could edit them.
- **The client reads their own.** They had no read path at all, which is what
  made the trail unable to answer the question it exists for.
- **There is no unencrypted `key_location_hint`.** See spec 04; the column is
  dropped, and key locations belong inside the encrypted secret.
- `accessed_by` equals `operator_id` by construction and carries no information
  today. Kept for the moment a second persona can read a credential at all.


### How long a revealed credential stays on screen (review M14)

**30 seconds, extendable three times, 120 seconds maximum.** The number lived
only in a code comment citing a spec that did not mention it, which is why it
is here now.

Thirty seconds with no way to extend is tight for the job this feature exists
to do — a door code read off a phone, in gloves, at a keypad, in the cold — and
considerably worse with a motor or cognitive disability, or with magnification,
where reading the screen and reaching the keypad are separate operations.

When it expired the operator had to run the whole cycle again: re-auth, type a
purpose, reveal. That is not merely friction. It writes **another**
`credential_access_log` row, so the trail this spec builds to make a real
intrusion visible fills with repeated reads of the same door minutes apart —
which is exactly the shape a real intrusion has.

So **extending writes no audit row**: same person, same purpose, same door,
still standing there. And it is **capped**, because an unlimited "keep showing"
is the timer removed with extra steps; 120 s total is long enough for a keypad
that needs two attempts and short enough that a phone put down mid-entry still
clears while the operator is on the doorstep rather than in the van.

The rule lives in `lib/vault-reveal.ts` and `extendReveal` refuses past the cap
even when the caller does not check, so a second entry point cannot grant an
unbounded reveal.


## Smoke-test security assertions (phase 00 suite must prove)
1. As client A JWT: select on client B's rows across clients/pets/walks/ledger → 0 rows.
2. As operator JWT: `UPDATE clients SET credit_balance = 999` → permission denied.
3. As operator JWT: `SELECT ciphertext FROM access_credentials` → permission denied; `SELECT id, label` succeeds.
4. As operator JWT: direct `INSERT INTO credit_ledger …` → permission denied.
5. As anon: every table select → denied/0 rows; `EXECUTE fn_grant_credits` → denied.
6. Ledger chain integrity query returns 0 violations after the full grant/debit/rollover scenario run.
7. Vault key identity (0021): `key_id` is derived from the ciphertext and cannot be written by any role; a pre-v2 blob reports NULL rather than a plausible id; the census's parts sum to its total; the rewrap queue selects only rows off the current key; the compare-and-swap accepts a correct expectation, refuses a stale one without clobbering, and refuses a replacement that is not a v2 blob under the promised key; the canary refuses a non-v2 pin; and an operator JWT can execute none of it and cannot read `key_id` or `vault_canary`.
8. Realtime walk channel (0020): the walk's operator receives **and** sends; its client receives but is refused on send; a foreign operator and another operator's client are refused on both, while that client is still allowed on their own walk; anon is refused; and malformed, foreign-namespace, unknown-walk and null topics all return false rather than raising. Asserted on `fn_walk_channel_access` for the matrix and through `realtime.messages` itself for the two policies, so a correct function behind unwired policies still fails.
