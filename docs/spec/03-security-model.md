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
| operators | select own row; insert/update by **column list** (0045 — the INSERT list excludes the platform billing columns `trial_ends_at`/`platform_*` AND the Connect `stripe_*` columns, closing the self-grant hole a table-level grant left open) | select `display_name,business_name` of own operator only (view `v_my_operator`) | — |
| clients | select/insert/update by COLUMN LIST, delete | select own row; update own contact fields only (column grants) | — |
| properties | select/insert/delete; update all but `operator_id`/timestamps | select own; update `access_notes_public` only | — |
| access_credentials | insert/update/delete metadata; **no select on `ciphertext`** | select own property's METADATA only (0030); **never `ciphertext`** | — |
| credential_access_log | select own by **column list**, never `ip`/`user_agent` (0056); **no insert/update/delete at all** (0030) | select own property's trail (0030) by the same column list: never `ip`/`user_agent`, which describe the walker's device (0056) | — |
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

`clients` is not "full CRUD" for the operator either, and the asymmetry is
load-bearing in both directions:

* **SELECT is a column list**, not the table (`0038` §1, narrowed again by
  `0043` §2). `unsubscribe_token`, `notes`, `stripe_customer_id` and
  `stripe_subscription_id` are withheld. A wildcard read is therefore a
  42501 on the WHOLE table, not a row with fields missing — PostgREST emits
  `SELECT clients.*` and Postgres refuses the statement. Every read of
  `clients` names its columns (`CLIENT_COLUMNS` in `app/src/lib/api.ts`),
  and `app/scripts/column-grants.test.ts` derives the allowed set from the
  migrations and fails the build on a wildcard or on drift in either
  direction.
* **`notes` is UPDATE-granted and NOT SELECT-granted.** A notes field is
  therefore unbuildable as things stand: the operator could write one and
  never read it back. The edit surface deliberately omits it, and omits
  `status` too — `status` is written by three invite-lifecycle functions,
  so an operator setting it by hand can desynchronise the row from its
  invite state.

`properties.client_id` IS inside the operator's UPDATE grant, so re-parenting
a property to another client is something the database permits (the `0014`
tenant-consistency trigger constrains it to the same operator, and
`walks.property_id` is RESTRICT). No surface offers it, and the edit form's
patch is asserted to be incapable of carrying it.

`anon` gets nothing except `EXECUTE` on `fn_claim_invite(token uuid)` (looks up client by invite_token, binds `auth_user_id`, flips status → active; called post-signup so effectively authenticated) — implement as authenticated-only; anon truly gets zero.

### Notice and consent (review H6)

`clients.notice_version` / `notice_accepted_at` and `operators.terms_version` /
`terms_accepted_at` record what somebody was shown and when.

**A timestamp alone is not a consent record.** On its own it says a person
agreed to something and nothing about what, because the document can change
underneath it. So the acceptance stores the document VERSION, and
`app/scripts/legal-version.test.ts` hashes the text in `app/src/lib/legal.ts`
and fails if it changed without the version changing. That guard is the whole
mechanism by which the stored version is evidence; without it these columns are
a more elaborate way of storing nothing.

The client's acceptance is written **inside `fn_claim_invite`**, so the
acceptance and the account binding are one transaction and a claimed account
with no consent record is not a reachable state. A claim that supplies no
version records no acceptance at all — stamping `now()` beside a null version
would assert agreement to a document nobody can look up. Neither column carries
an UPDATE grant for any API role: an operator able to stamp "this client
accepted" would make the record worthless in the one direction that matters.

### Erasure and retention (review H5)

A client's personal data can be exported (`fn_export_client_data`) and destroyed
(`fn_purge_client` + `fn_purge_client_photos`). Both are operator-scoped definer
functions; a foreign caller gets `no such client`, not a different error.

**The rule: the credentials and the GPS traces MUST be destroyable; the
financial ledger must NOT be.** What the referential graph permits follows from
two facts read off `pg_constraint`, not from the schema file:

- `credit_ledger.walk_id` and `payments.walk_id` reference `walks` `ON DELETE
  RESTRICT`, and the ledger must survive — so **walks cannot be deleted**.
- `walks.property_id` references `properties` `ON DELETE RESTRICT` and is `NOT
  NULL` — so a property under a surviving walk can be neither deleted nor
  detached, and **properties cannot be deleted** either.

A third constraint comes from the vault rather than the ledger:
`credential_access_log.credential_id` is RESTRICT and 0030 made that table
immutable with an unconditional trigger, while `fn_write_credential` writes a
`create` row for every credential — so **an access credential can never be
deleted** once it has been created through the product. That is deliberate, not
an obstacle to route around: H3 built the trail so a real intrusion is visible,
and letting a purge erase it would hand the audited party a way to erase their
own reads by purging the client they read from. **The destroyable thing is the
secret, not the row** — the ciphertext is overwritten with a 37-byte sentinel
that is not a v2 blob, so the `key_id` generated column resolves to NULL.

So four things are redacted in place (`clients` to a tombstone, `walks.notes`,
the property address and access notes, the credential ciphertext) and
everything else is destroyed: `walk_gps_points`, `walk_photos`, `walk_pets`,
`schedule_pets`, `recurring_schedules`, `plan_change_intents`, `notifications`,
`invite_claim_attempts`, and `pets`. Notifications go by SUBJECT as well as
by `client_id` (0057). `client_id` says who may read a row, so a row the walker
reads carries NULL there. Until 0057 such a row named its client only in its
title, and the purge, deleting by `client_id`, left "<name> is low on credits"
and "<name> booked a walk" in the walker's inbox after the erasure. Each row
now records `subject_client_id`, and the purge deletes by it. A notice about
an erased client is not written at all: a writer can read the client before
the erasure and insert after it (the Stripe webhook looks the client up, then
inserts), and the purge keeps the client row, so the same trigger takes that
row `FOR KEY SHARE`, which waits for an erasure in flight, and skips the
insert when `purged_at` is set (Codex on PR #105). Skipped rather than
refused, because the writers are money paths and a failed insert would fail
them; the price is that the walker gets no bell for what happens to an erased
client's account afterwards, which the Money screen still shows. A refund or
dispute alert records no subject: it names no one, and a dispute has a
deadline the walker answers in Stripe, so an erasure neither deletes it nor
stops the next one. Rows written before 0057 got a subject where they recorded one (a
`client_id` or a walk), and those about a client already erased were deleted,
as the purge now would; a walker notice that named its client only in text
could not be linked without guessing from a name, and stays. So does one the
previous Stripe webhook writes during the deploy that applies 0057: both
workflows migrate before they deploy functions, and for those minutes (longer
if the function deploy fails) the webhook still in place writes its walker
notices with no subject (Codex on PR #105). The database cannot tell whom such
a row is about, so it could only drop or refuse it, and either loses the
refund or dispute alert above: `fn_reverse_payment` commits before the alert,
and Stripe's retry takes its no-op branch and never writes it. Production has
never run, and its first deploy applies 0057 to a database with no clients, so
neither kind exists outside staging's fixtures. `invite_signup_attempts` (0048) is
destroyed too, and not by `fn_purge_client` naming it: the purge rotates
`invite_token`, and `trg_clients_reset_invite_signup_budget` clears the
client's rows whenever that column changes. Those rows carry an `ip`, so
without it they were personal data surviving an erasure request indefinitely —
a purged client receives no further signup attempts, and the limiter's prune
only ever runs for the key being attempted. `push_subscriptions` (0049) goes
the same way: the purge redacts the client row rather than deleting it, so the
FK cascade never fires, and `trg_clients_forget_push_subscriptions` deletes
the device rows when `purged_at` is set — an endpoint identifies a browser, and
one surviving an erasure request would keep putting that person's
notifications on a lock screen (spec 01). `email_suppression_lifts` (0054)
goes by the same trigger shape and the same key: `trg_clients_forget_email_lifts`
deletes the erased client's lift records by `client_id`. The first version
keyed them on the account the purge unbinds, which missed a lift made before
the operator released the account (`fn_unbind_invite` nulls `auth_user_id`, so
the erasure found nobody) and deleted another client's record when the same
account had since been bound elsewhere.
`email_suppressions` is the one thing about an address this leaves, on
purpose: it is keyed on the address rather than the client, it is the address
owner's instruction to stop, and deleting it would make an erasure start email
to that address again. Redaction here is not a weaker
deletion; it is the only form the graph allows without dismantling the tax
record or the audit trail. What remains carries no readable secret, and no
personal data beyond an unsubscribed address, kept so that it stays
unsubscribed, with four exceptions. Two are text the walker typed into
records kept whole on purpose: the reason given for revealing an entry code
(`credential_access_log.purpose`) and a note on a credit adjustment
(`credit_ledger.note`). Both are immutable, so the purge cannot redact them,
and a walker who wrote a client's name into either has written it into a
record that outlives the client. The other two are outside what the purge
reaches, and are open (backlog): the Stripe webhook stores every event whole
in `stripe_events.payload`, which is never pruned, and a checkout session, an
invoice or a charge carries the customer's name, email and billing address as
Stripe sent them; and the client's own sign-in account in `auth.users` keeps
its email, because the purge only unbinds it (`auth_user_id = null`). This
sentence was false for notifications until 0057, and named neither of the
last two until the 0057 review.

**Nothing in the database stops a purged record being re-personalised.** The
`0004` UPDATE grant still covers `full_name`, `email` and `phone` after
`fn_purge_client` has redacted them, and the rows this function REDACTS rather
than destroys are kept precisely because retained walks reference them — so
every surface that writes personal data back is a way to undo, by hand, an
erasure carried out on request:

| surface | what the purge did |
|---|---|
| Edit details (client) | tombstoned `full_name`, nulled `email`/`phone`/`notes` |
| Edit property | nulled every address field, `label` → `'Removed'` — **row kept** |
| Add property | (a new row re-attaches an address to the erased client) |
| Add secret | ciphertext overwritten with a 37-byte sentinel — **row kept** |
| Add pet | `pets` DELETEd outright |
| Send a new invite | the token is reissued and `email` is NULL — see below |

The operator UI withholds all five from any client carrying `purged_at`, from
one decision (`isEditable` in `app/src/lib/client-edit.ts`, read once in
`ClientDetail`). Guarding only the client header — the first version of the
edit surface — left this paragraph false two tabs over; the Codex review on
PR #79 caught it, and the test now asserts each surface separately so fixing
one and not its siblings fails.

The invite panel is withheld too, and that one is not cosmetic:
`fn_rotate_invite` mints a live 14-day token, and a tombstone's `email` is
NULL — which is exactly the ladder rung that admits ANY address, with the
signup pre-flight then reserving the first that arrives. One click on an
erased record would make it claimable again.

**`0046` closed the database half of that one.** `fn_rotate_invite` now carries
the same `purged_at` predicate `fn_unbind_invite` always had, so a tombstone
cannot be handed a live bearer token by any caller. Measured before the fix, as
the owning operator: the purge left `invite_revoked_at` set, one rotate cleared
it, and `fn_invite_signup_check(<new token>, 'stranger@example.test')` then
answered `claimed` — which would have reserved the stranger's address onto the
tombstone, undoing the erasure by a second route. `0046` also re-revokes any
purged client that already carried a live invite, and reports the count rather
than repairing silently.

`fn_revoke_invite` is deliberately NOT given the predicate, and the asymmetry is
the point: rotate MINTS a token, revoke KILLS one. On a tombstone revoke is a
no-op in effect and moves toward safety, and it is the only in-product remedy
for a row that already carried a live invite — refusing it would strand exactly
the rows the repair exists for. A guard that blocks the safe direction is worse
than no guard.

What remains UI-only is the rest of the rule: the edit forms above. A
database-enforced version needs a trigger refusing writes to a purged row,
which is a larger change than the one hole that was actually reachable.

**Storage is two-phase, and the order is load-bearing.** SQL cannot delete a
bucket object — dropping the `storage.objects` row removes the metadata and
leaves the file. So `fn_purge_client` returns the paths and KEEPS the rows
naming them; the operator's browser removes the objects (it already holds a
folder-scoped delete policy from 0004); `fn_purge_client_photos` then drops the
rows. The rows are the work queue, so the sequence is idempotent and resumable,
and a photo orphaned in a bucket with nothing naming it is impossible by
construction. A path storage refuses is reported, and the rows stay.

`fn_sweep_gps_retention` runs on the nightly job and drops traces for
**completed** walks past `operators.gps_retention_days` (default 365; 0
disables). Completed only: a walk still in progress, or abandoned and awaiting
an operator (0036), keeps its points however old, because deleting the trace of
a walk nobody finished destroys the only record of what happened on it.

### The invite lifecycle (review H4)

An invite is a bearer credential for one person's home, so it is bounded on
four axes, all added in `0039`:

| Control | Mechanism |
| --- | --- |
| Expiry | `clients.invite_expires_at`, defaulting to 14 days, checked in `fn_claim_invite` **and** `fn_preview_invite` — and pre-account in `fn_invite_signup_check` (0045) |
| Revocation | `clients.invite_revoked_at`, set by `fn_revoke_invite` |
| Reissue | `fn_rotate_invite` mints a new token, resets the window, clears revocation — refused on a purged client (0046) |
| Attribution | every attempt against a matching token writes `invite_claim_attempts` — including pre-account refusals from the signup pre-flight, with a null `attempted_by` (0045) |
| Rate | `fn_invite_signup_allow_attempt` (0048) gives each client 10 anonymous signup attempts per hour, charged before the ladder runs |

Since review H31 the ACCOUNT is created server-side: the public `claim-signup`
edge function asks `fn_invite_signup_check` (service-role-only; mirrors the
claim ladder exactly, smoke-pinned for parity) BEFORE `auth.admin.createUser`,
so a dead invite refuses with no account created and public GoTrue signup is
no longer load-bearing for invites. The claim itself stays authenticated
`fn_claim_invite`, so binding, consent and attribution are unchanged.

That move also took away a control nobody noticed leaving: the flow it
replaced ran on public `signUp`, which GoTrue rate-limits per IP, and an
edge function calling `auth.admin.createUser` with the service role is
outside that limiter — or, if it is not, is inside it under the function's
own egress address, which is one shared bucket for every claimant in the
world. `0048` restores a bound, keyed on **the client the invite belongs
to**, never on the caller: the attacker controls their address and the
victim does not, and 0016 — the precedent — keys on the subject being
protected rather than the caller. It is charged BEFORE the ladder runs, so
an exhausted budget computes no outcome, writes no `invite_claim_attempts`
row, and cannot be read as an answer. A token matching no client is allowed
and records nothing, because refusing it would make the limiter the
token-existence oracle the ordering avoids, and recording it would give an
attacker unbounded growth from a caller-supplied key. `invite_signup_attempts`
is infrastructure rather than a tenant table — no `operator_id`, invariant 7
does not apply, exactly as `job_runs` — with RLS enabled and forced, no
policies and no API-role grants; and it needs no retention sweep, because the
function prunes the key's expired rows before counting and inserts only under
the limit, so at most 10 rows per client can exist at any instant. A reissued
invite starts a fresh budget — `trg_clients_reset_invite_signup_budget` fires
on any change to `invite_token`, so rotation, unbind and purge all clear the
client's attempts, and the reissue the operator is told to reach for is not
refused by the budget the attacker burned (Codex review on PR #84). The
limiter re-reads the client under its advisory lock and holds the row until it
inserts, so a request that resolved the old token cannot land after a rotation
or a purge and undo either — `concurrency.sh` cases 6 and 6b.

A claim that lands on the wrong person is undone with `fn_unbind_invite`,
which severs the account and reissues in ONE statement — two statements leave a
window where the client is unclaimed and the old token is still live, so
whoever holds it simply claims again. It also clears the consent record, which
belonged to whoever claimed and is not evidence about the real client. Without
it there was no in-product recovery at all: revoke and rotate both require an
UNCLAIMED invite, and the row cannot be deleted because every child FK
restricts.

`fn_unbind_invite` deliberately does NOT clear `clients.email`, and that makes
the recovery only half a recovery on its own: the reissued token is still bound
to the address of whoever wrongly claimed, so the real client cannot use it
until somebody edits the row. Which is the other thing worth stating plainly —

**on an UNCLAIMED client, `clients.email` is not contact detail. It is the last
rung of the claim ladder**, in `fn_claim_invite` and `fn_invite_signup_check`
alike: NULL admits any address (and the pre-flight then reserves the first one
it admits), non-NULL admits only that address, compared `lower(trim(...))` on
both sides. It is also the only ladder input an operator can change with a
plain UPDATE rather than a definer function, because it sits in the `0004`
column grant while `invite_token`, `invite_expires_at` and `invite_revoked_at`
do not. So the edit surface treats it as an access-control decision and says
which one is being made — adding an address narrows the invite to it, changing
one transfers it, and CLEARING it re-opens the invite to anyone holding the
link. Once `auth_user_id` is set the ladder stops at `already_claimed` and
never reaches this rung; the login is `auth.users.email`, which nothing in this
repository updates after signup, so an edit then changes only where mail goes.

`invite_claim_attempts` is append-only, with exactly one exception: a row may
be DELETEd once its client carries `purged_at`. Erasing attempts is therefore
only reachable by erasing the client. Without that exception `fn_purge_client`
raised for every client who had ever claimed — the shipped 0040/0041 behaviour,
which passed because the fixture's client never claimed. UPDATE stays blocked
unconditionally.

Claiming also binds to the invited address when `clients.email` is set. Without
it, email confirmation proves nothing: the claimant types their own address at
signup, so confirmation verifies the address *they* chose rather than the one
the operator invited.

**`fn_claim_invite` returns an outcome; it does not raise on refusal.** This is
structural, not stylistic. A PL/pgSQL `raise` rolls the transaction back to the
caller's savepoint, which discards the audit row written alongside the refusal —
so a log-then-raise implementation records only the attempts that SUCCEEDED,
which is exactly inverted from what the log is for. The refusal itself was never
the exception: it is the absence of the binding `UPDATE`, which runs only on
`claimed`. `invite_token`, `invite_expires_at` and `invite_revoked_at` therefore
carry no UPDATE grant for any API role — every transition goes through a definer
function, which is what keeps "who may reissue an invite" a single answer.

## Storage matrix (`storage.objects`)

Seven policies govern photographs of customers' homes and pets, and this
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

The client surfaces for that enrolment (`app/src/lib/mfa.ts`) mirror the
table above exactly. Settings → *Two-factor authentication* runs
enroll → scan → `challengeAndVerify`, which upgrades the current session to
`aal2` in place; the vault's re-auth sheet asks for a code precisely when the
server would refuse — a verified factor exists and the session is still
`aal1` — and upgrades the session *before* the vault call, so the refused
request is never made (the M2 shape, one rung up). Three rules are pinned by
tests: only **verified** TOTP factors gate anything (an abandoned enrolment
must not lock anyone out — the server's own rule, mirrored); the client
check fails **open** to password-only when the factor LIST is unreadable
(the server still refuses an insufficient session — failing closed here
would wall the vault off on a flaky connection), while an unreadable
*assurance level* still prompts: the fresh factor list is the load-bearing
input, and the cached session's `nextLevel` is never consulted — it lags
enrolment on another device by up to a token lifetime, and gating on it
re-created the doomed request for exactly the newest factors (adversarial
review). Turning the factor off requires a current code, because a
session-only attacker must not be able to delete the control that exists to
contain stolen sessions — scoped honestly: that code requirement is
**client-side**. GoTrue itself unenrolls a verified factor for any aal2
*session*, so a token stolen while already at aal2 can remove the factor by
direct API; it is also already past the factor, which is why the session
timebox, not this control, is what bounds that window. A lost authenticator
is therefore recoverable only via the dashboard (`docs/dev/owner-actions.md`
§9).

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
- `GRANT SELECT (id, operator_id, credential_id, accessed_by, action, purpose, accessed_at,
  walk_id, created_at) ON credential_access_log TO authenticated;` in place of 0004's
  table-level SELECT (0056). `ip` and `user_agent` describe the walker's device, and the
  table grant handed both to every client whose door a row names; a column REVOKE would have
  been a no-op against it. A column added to the table later is withheld until a migration
  grants it by name.
- `REVOKE ALL ON stripe_events, payments FROM authenticated` except `GRANT SELECT ON payments`.
- `walks.credits_debited`, `walks.is_overage`: no UPDATE grant to authenticated — set only inside `fn_debit_walk`.

## Service-role grants are explicit, never inherited (0050)

0004's header states the rule the whole matrix rests on: explicit grants,
**no reliance on platform default privileges**. Its loop does both halves for
each of the original 18 tables — `REVOKE ALL … FROM public, anon,
authenticated` *and* `GRANT ALL ON TABLE … TO service_role`.

The trap is that only the first half is load-bearing on a live project. Supabase's
bootstrap sets `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES /
FUNCTIONS TO … service_role`, so anything `postgres` creates in `public` reaches
service_role whether or not a migration says so. A migration that revokes and
forgets to grant therefore works, and nothing on the project can tell the two
apart: an inherited grant and an explicit one both read as
`service_role=arwdDxt/postgres` in `relacl`. Smoke cannot see it either.

Four objects had done exactly that, each read or called by the sender through
`adminClient()`:

| object | migration | reached by |
| --- | --- | --- |
| `push_subscriptions` (SELECT, DELETE) | 0049 | `send-notification` |
| `fn_note_push_failure(uuid, text)` | 0049 | `send-notification` |
| `vault_canary` (SELECT) | 0021 → 0050 | `vault-rekey` |
| `fn_unsubscribe_by_token(uuid)` | 0038 → 0050 | `unsubscribe` |

`scripts/db-push-check.sh` is the gate, because it is the only place that can
ask the question: it replays every migration as `sb_deploy`, which holds no
default privileges, so an object is reachable there only if a migration said
so out loud. It measured all four unreachable while still exiting 0. It now
derives the object set from the `.from(…)` / `.rpc(…)` calls in
`supabase/functions/` and asserts each one — derived rather than enumerated, so
a table added to a handler is covered without anyone remembering, and it
refuses outright if the derivation returns nothing rather than passing by
looking at nothing.

Its blind spots, stated rather than left to be discovered:

- a `.from()` or `.rpc()` built from a variable is invisible to that grep, so
  the rule remains a review concern as well as a gate;
- RPC argument keys are checked only for *existence* — every key a handler
  supplies must be an IN parameter of some overload, because PostgREST
  resolves overloads by argument name and a misspelled key names a function
  that does not exist. It deliberately does NOT check that required arguments
  are present, or their types. That is a typechecker's job, and this gate is a
  privilege-and-existence gate; extending it into signature validation would
  make it two gates in one script and a heuristic nobody can reason about.

The key check asks whether each supplied key is an IN parameter of *some*
overload, which is exact only while our functions are not overloaded: given
`fn_x(p_a)` and `fn_x(p_b)`, a call passing both keys would satisfy each from a
different row while PostgREST could resolve neither. Measured rather than
assumed — **no `fn_` function in this schema is overloaded**, and no RPC is
called from more than one site, so neither half of that is reachable today.
Closing it properly needs per-call key sets and overload grouping, which is
machinery for a state that cannot occur, so the **precondition is pinned
instead**: `db-push-check.sh` fails the day an `fn_` name gains a second
signature, and whoever adds it decides what the check should become. pgcrypto's
`digest`/`hmac`/`pgp_*` are overloaded and deliberately out of scope, since no
handler `.rpc()`s them.

## Definer function catalog + grant pattern
Every definer fn: `SECURITY DEFINER SET search_path = public, pg_temp`, then
```
REVOKE ALL ON FUNCTION fn_x(…) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_x(…) TO <role list>;
```
The REVOKE is not a formality. A new function is executable by `PUBLIC`
(PostgreSQL's default) and by `anon`, `authenticated` and `service_role` (the
platform's default privileges), so a definer function created without it is
callable by anyone holding the anon key. `authenticated` belongs in it too:
this block used to say `FROM PUBLIC, anon`, which leaves every signed-in user
holding EXECUTE through the default privileges with no GRANT anyone wrote —
a function meant for the service role, callable by any client, with every
other check green (PR B review). None exists today, and the generator now
refuses one by name; granting `authenticated` back explicitly, where it is the
caller, is what the GRANT line is for.

Four definer TRIGGER functions kept the whole default from `0012`–`0015` until
`0053`. PostgreSQL refuses to call a trigger function directly, and an earlier
version of this section called that "not exploitable" because no API role can
create a trigger. It can: `PUBLIC` holds TEMP on the database, a role owns
every temp table it creates, and an owner may put a trigger on its own table.
So a SQL session holding an API role with EXECUTE on one of them could attach
it to a temp table shaped like the one it guards and run its body, as the
owner, on rows it chose — measured on `fn_refund_cancelled_debit` with the
pre-`0053` ACL, a client's balance went from 4 to 1004, refunding a debit that
never happened. It was never reachable through the product, because `anon` and
`authenticated` are NOLOGIN (PostgREST connects as `authenticator`, switches
role and issues no DDL) and no function an API role can execute runs dynamic
SQL; invariant 5 holds without depending on that argument. `0053` revokes the
four from every API role, which cannot break them — EXECUTE on a trigger
function is checked when a trigger is created, not when it fires (smoke.sql
pins that for the three an API role can reach) — and smoke now refuses a
definer trigger function that ANY API role can execute, `authenticated`
included. The `search_path` that let a temp table shadow `public` inside a
definer body is closed by `0055` (below); TEMP itself is left to its own item
in `docs/dev/backlog.md`.

**`search_path` is `public, pg_temp` (0055).** PostgreSQL searches the
session's temporary schema FIRST for tables and types unless `pg_temp` is
listed, and `PUBLIC` holds TEMP, so a definer function pinned to `public` alone
reads a caller's temp table of the same name as a table it uses, as its owner
(measured on `my_client_id()`, PR B review). Listing `pg_temp` last, the form
PostgreSQL's documentation recommends, puts temp tables after everything else
whatever TEMP is granted; functions are never looked up there. `0055` moved all
73 definer functions still on `public`, and the four invoker functions that pin
a path of their own (a definer that calls one runs it as its owner, with that
path), with one `ALTER FUNCTION … SET search_path` each. That rewrites
`proconfig` and nothing else: before and after, across all 88 functions, the
bodies, signatures, owners, ACLs, security and volatility were compared equal.
An invoker function that pins no path inherits its caller's, which inside a
definer is now this one.

Smoke asserts both halves of invariant 5 against the live catalogue: every
definer function pins exactly `public, pg_temp` (`public` alone, `pg_temp`
first, and a quoted `'public, pg_temp'`, which is one schema of that name, all
fail); no function pins any other path; and no definer function is executable
by `PUBLIC` or `anon`.
This catalogue used to be hand-written and listed **11** functions when there
were **48** (the generated block below carries the live count). It was presented as the complete grant-audit checklist, so an engineer
adding a definer function and checking their grants against it had no idea 37
peers existed (review H21) — the opposite of what a checklist is for. It is
generated now, and CI fails when it and the migrations disagree. It reads the
migrations with `gen-enum-catalog.py`'s SQL reader and scans its skeleton, so a
`--` or `/*` inside a string literal, a nested block comment, and a `COMMENT ON`
string that says "security definer" are all read as PostgreSQL reads them;
`scripts/gen-definer-catalog-proofs.py` holds a probe for each.

**It models each function's ACL; it used to collect GRANTs.** Reading grants
alone, a function nobody granted was rendered **none** — "no API role can call
it" — and that is how the four trigger functions above were catalogued while
every API role could execute them (spec-drift audit). So each function starts
at the platform default, and every `CREATE`, `CREATE OR REPLACE`, `DROP`,
`GRANT` and `REVOKE` is applied in migration order, keyed by name AND
argument types: `0026` created a new overload of `fn_apply_invoice_paid` and
dropped the old one, and a new overload starts at the default, not at the old
one's revokes. Argument types are compared as `format_type` prints them, so
`float`, `dec`, `int[3]`, `interval day` and `pg_catalog.char` are the types
PostgreSQL resolves them to, and an argument needs no name. A definer
function `PUBLIC` or `anon` can execute fails the generator by name, and so
does one `authenticated` holds only through the platform's default
privileges. A statement it cannot read (a routine grant in another shape,
`ALTER FUNCTION`, `ALTER DEFAULT PRIVILEGES`, a procedure) is refused rather
than guessed at, and so is one that changes functions without naming them: a
`DROP … CASCADE` on a type, table, schema or anything else a function can
depend on, a range type (whose constructors no statement names), and a
`drop function if exists` of a signature it does not know while the name
exists with another — a no-op, or a type it spells differently from
PostgreSQL, and it cannot tell which.

So the table below is the model's reading, not the database's word. The
reader it shares with the enum catalogue blanks every DO and function body, so
it refuses a body that creates, alters or drops a routine, or grants or
revokes on one, by name; what no reading of the migrations can see is SQL
assembled inside a body past that refusal, and what a reading can get wrong is
a type or a statement it misreads. Gate 8e
(`scripts/check-definer-catalog-live.py`) is the backstop for both. It
holds the whole model — every function the migrations create, its argument
types, its `SECURITY DEFINER` flag and the API roles holding EXECUTE — to a
reset database, and fails by name where they disagree.

Each `create function` is read as one statement, bounded on the skeleton
where the reader has blanked its body, which matters: a fixed window reports
52, because four trigger and helper functions that are *not* definer
(`fn_is_service_session`, `fn_ledger_block_mutation`,
`fn_credential_log_block_mutation`, `fn_default_walk_origin`) sit next to ones
that are. `create or replace` of an existing signature keeps its ACL and takes
the new `SECURITY` setting, since that is what Postgres actually has.

<!-- BEGIN GENERATED DEFINER CATALOG -->

77 `SECURITY DEFINER` functions, in migration order. Generated by
`scripts/gen-definer-catalog.py`; CI fails if this table and the migrations
disagree, so adding a definer function without regenerating breaks the build.

*EXECUTE held by* is each function's ACL after every `CREATE`, `GRANT`,
`REVOKE` and `DROP` in the migrations, in order, starting from what a new
function gets on the platform: `PUBLIC` (PostgreSQL's default) plus `anon`,
`authenticated` and `service_role` (Supabase's default privileges). Only the
API roles are shown. **none** means no API role can call it — service-role
and other definer functions only, which is the correct default. `PUBLIC` or
`anon` would break invariant 5, and so would `authenticated` holding it only
through the default privileges; the generator refuses both. Gate 8e holds
this reading to a reset database.

| Function | EXECUTE held by |
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
| `fn_block_invite_log_mutation` | **none** |
| `fn_rotate_invite` | `authenticated` |
| `fn_revoke_invite` | `authenticated` |
| `fn_export_client_data` | `authenticated` |
| `fn_purge_client` | `authenticated` |
| `fn_purge_client_photos` | `authenticated` |
| `fn_sweep_gps_retention` | **none** |
| `fn_unbind_invite` | `authenticated` |
| `fn_snapshot_walk_price` | **none** |
| `fn_price_unpriced_scheduled_walks` | **none** |
| `fn_apply_topup` | **none** |
| `fn_invite_signup_check` | **none** |
| `fn_invite_signup_allow_attempt` | **none** |
| `fn_reset_invite_signup_budget` | **none** |
| `fn_register_push_subscription` | `authenticated` |
| `fn_note_push_failure` | **none** |
| `fn_remove_push_subscription` | `authenticated` |
| `fn_forget_purged_push_subscriptions` | **none** |
| `fn_claim_notification_send` | **none** |
| `fn_client_email_suppressed` | `authenticated` |
| `fn_my_email_status` | `authenticated` |
| `fn_lift_my_email_suppression` | `authenticated` |
| `fn_forget_purged_email_lifts` | **none** |
| `fn_notification_subject` | **none** |

<!-- END GENERATED DEFINER CATALOG -->

`fn_walk_cost` keeps its `authenticated` EXECUTE with ZERO browser callers,
and that is a recorded decision rather than an oversight. `api.ts`'s
`walkCost()` wrapper was deleted in `fix(walk-cost)` because the one screen
that prices a persisted walk before completion (Booking's committed sum)
already holds `walks.cost_credits` in the row it fetched, so a round trip per
walk for a column already returned was strictly worse than reading it. The
grant is not revoked to match: that is a migration on the money path (0004 and
0043 both grant it), `supabase/tests/smoke.sql` calls the function AS
`authenticated` to pin the snapshot-first rule and would have to be rewritten
to keep doing so, and a grant with no caller is inert where a revoke is a wall
the next caller walks into. `fn_debit_walk`, a definer, calls it as its owner
and would notice neither. It stays until a migration on that path has its own
reason to move it.

`fn_client_email_suppressed` (`0052`) is the one definer function through which
an operator reads anything derived from `email_suppressions`, a table no API
role can read (`0038`), and its tenancy check is what stops it being a lookup
over that list: it answers only for a client whose `operator_id` is the caller,
only about that client's current address, and only as one boolean labelled
with the address it checked — `clients.email`, which the operator's column
grant already lets them read, so the label discloses nothing. A
platform-wide suppression is the address owner's instruction to every operator
and nobody's list, so each operator it binds may learn that it binds them; an
operator-scoped one is consulted only for its own operator, here exactly as in
the sender, because this function asks the sender's `fn_email_suppressed` rather
than restating it, once for each type the sender emails. The limit, stated: an operator can save any address to one of
their own clients and then ask, so what bounds the disclosure is how little it
says — that someone at that address once unsubscribed from Sanpo email; no
business, no date, no reason — not the cost of asking. Spec 04 (`unsubscribe`)
has the product half.

`fn_lift_my_email_suppression` (`0054`) is the one write path into
`email_suppressions` besides one-click itself, and the trust argument is what
decides who may use it. A suppression is somebody asking us to stop, so an
operator can never lift one; the address owner can, and the proof of ownership
is control of the inbox NOW, shown by the session the request arrives on. The
caller must be the claimed client whose contact address is their own sign-in
address, and the access token's `amr` claim must record an emailed link or code
opened after the address last asked us to stop (`last_requested_at`, which
one-click moves on every request, a repeated one included): `otp` in the
implicit flow this app uses, or the PKCE names `magiclink`, `recovery`,
`email/signup`, `invite` and `email_change` (GoTrue `internal/api/verify.go`,
read on `master`). Refreshing a
token rebuilds the claim from the session's stored entries without restamping
them (`internal/tokens/service.go`), so the entry dates the link, not the last
refresh. Sanpo never emails a suppressed address itself; GoTrue's sign-in mail
does not pass through the sender, so the link arrives. The functions take no
argument, so the caller cannot name an address, a client or a session:
`auth.uid()` picks the one client row bound to the account, and `auth.jwt()`
supplies the claim.

The first version proved ownership with `email_confirmed_at`, and a review
showed why that is history rather than control: a mailbox that changed hands
keeps its confirmation, so whoever confirmed it long ago could lift the new
holder's unsubscribe, and lift each one after it. It also rested on a dashboard
setting: with email confirmations off, GoTrue confirms a public-signup account
at creation, and a magic-link request confirms any unconfirmed account the same
way. The session proof rests on neither, since an account confirmed without a
click still has to open a link sent to that inbox. `email_confirmed_at` is still
read, because an unconfirmed account's remedy is a reset link rather than a
magic link (spec 04), and a link session implies it anyway.

What the lift removes is narrow on purpose: the platform-wide, every-type row
one-click writes, matched by its reason as well as its shape, and only when it
is all that keeps this client's email off. A row that also applies (the client's
own operator's stop, or a stop for a type the sender emails) is a narrower
preference, so the answer is `not_liftable`, and a `lifted` answer is never
given while some email stays off. Each lift is recorded in
`email_suppression_lifts` (address, client, account, and the suppression it
replaced), a table no API role can read or write and the service role may only
read. An erased client's records go with the rest of the record, keyed on the
client (above). The lift takes the client row `for no key update` before it
decides, so a lift and an erasure of the same client serialize in either order
(`concurrency.sh` cases 11a and 11b). It checks the session against the latest
request twice, in the decision and again in the statement that deletes the row,
so a repeated request that lands between the two wins (case 11c). One-click
used to do nothing on a repeated request, which left the row at its first
request's time and let a session opened between two requests undo the second.
The suppression list itself survives erasure, as it always has: erasing a
record must never start email to an address again.

What a client can learn: `fn_my_email_status` answers about the client's own
contact address, and a client may edit that field (`clients_self_update`), so,
like the operator with `fn_client_email_suppressed`, a client can learn whether
any address it saves there is suppressed. What bounds that is how little comes
back: one state, with no business, no date and no reason.

The limits, stated: `otp` also records an SMS code, so an account that could add
and verify a phone number would get a fresh entry without opening the inbox (no
SMS provider is enabled in `config.toml`; the deployed projects' setting is not
measured from here); and a GoTrue admin email change (the dashboard, or the
service role) moves the sign-in address without a link and without touching an
existing session, whose entry then describes a different inbox. Nothing in this
repository changes a sign-in address that way, and the session timebox bounds
how long such a session lives. And the entry is dated when a link was opened,
not when it was read: someone who read a link in that inbox before the
unsubscribe and opens it after would pass, within the link's lifetime
(`otp_expiry`, one hour in `config.toml`; the deployed setting is not measured
from here).

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
- Client persona: **selects their own property's credential metadata and its audit trail** (0030), and never `ciphertext`, `ip` or `user_agent` (0056). Secrets remain operator-entered; new codes still travel out-of-band or via `properties.access_notes_public`.

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
- **Only the service role reads them** (0056). They describe the walker's
  device, not the client's door, and 0004's table-level SELECT had covered
  both, so a client session read their walker's IP address and device for
  every row on their property while the portal declined to show them. The grant
  to `authenticated` is a column list now, and column privileges are role-wide,
  so the operator's API reads lose the two columns as well. Nothing in the app
  read them for either persona; a screen showing an operator the devices that
  opened their vault would be a definer function scoped to the operator.
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
