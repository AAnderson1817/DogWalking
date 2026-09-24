# Backlog

Work that is known, scoped and not yet done. One item per PR, roughly in
order. Tick an item when it lands and say where; delete it once the status
log in `CLAUDE.md` carries the entry.

This list lived in a session handoff document until the client-editing PR
moved it here, where it can be maintained by the sessions that consume it.

`docs/dev/owner-actions.md` is the companion list of things no file in this
repository can do. Nothing here needs the owner; everything there does.

`docs/dev/session-notes.md` is the other companion: how to bring a container
up, which gates pass without checking anything, and the traps worth knowing
before you hit them.

## Reserved — do NOT start without the owner

- **CSV import (M23)** and **intake/agreements (M25)**: product-shaping,
  blocked on a scope decision that does not exist yet. Until an entry in the
  status log or `docs/dev/` records those decisions, treat both as undecided.
- **Operator data egress**, and anything in `supabase/migrations/` touching
  the money invariants, the credential vault, RLS semantics, or the deploy
  workflows: reserved for a review-first session.

## Open

### 1. TEMP, and the `search_path` that lets a temp table shadow `public`
`PUBLIC` holds TEMP on the database (PostgreSQL's default), and a definer
function whose `search_path` is `public` alone searches `pg_temp` FIRST for
relations. So a SQL session holding a role with EXECUTE on a definer function
can create a temp table named like one the function reads and have the
function read that instead, as its owner (measured on `my_client_id()` with a
temp `clients`, PR B review). The same TEMP privilege is what let an API role
attach a definer TRIGGER function to a temp table of its own, which `0053`
closed for the four that were open and smoke now refuses for all.

Not reachable through the product: `anon` and `authenticated` are NOLOGIN,
PostgREST issues no DDL, and no function an API role can execute runs dynamic
SQL. Two independent hardenings, each a migration on every definer function,
so each wants the money-path argument:

- move every definer function to `set search_path = public, pg_temp`, the form
  PostgreSQL's documentation recommends. It puts temp tables last whatever
  TEMP is granted, so it does not depend on the platform; smoke already
  accepts it, and a single-quoted `'public, pg_temp'` (one schema of that
  name) still fails;
- `revoke temporary on database … from public`, once it is measured on a real
  project that nothing the platform runs as an API role needs a temp table.

### 2. The claim replay's fixtures cannot be deleted, and its warning says they can
Every staging smoke run creates an operator, a client and two auth users for
the invite-claim replay, and the cleanup fails on every run: the client
DELETE answers 409, then the operator 409, then both auth users 500. Each
failure is a `::warning` ending "Rows accumulate in staging until this is
fixed." Read off smoke runs 103 and 104, on either side of PR A (#97), so it
predates the shared fixture library.

The warning promises a fix the schema forbids. A claim, successful or not,
writes an `invite_claim_attempts` row. That table is append-only by trigger
(`0039`, the H4 trail), and its `client_id` is `ON DELETE RESTRICT`. So a
claimed client can never be deleted, by design. `clients.operator_id` then
keeps the operator, and `operators.id` and `clients.auth_user_id` (both
RESTRICT to `auth.users`) keep both auth users. Three ways out:

- **Clean up the way the product erases a client.** Call `fn_purge_client`
  as the fixture operator (the replay holds its password). The purge redacts
  the client and nulls `auth_user_id`, so the client's auth user can then be
  deleted. The tombstone, the operator and the operator's auth user remain:
  three rows per run instead of four.
- **Keep one long-lived fixture operator**, got or created and never deleted,
  so only each run's client tombstone accumulates. That brings back the
  stable identity `ops(smoke-identity)` removed. Get-or-create is no
  precondition, but a fixture whose state drifts would taint every run.
- **Accept it and say so.** Replace the warning with a notice naming the
  design, not a fix that cannot exist.

Whichever lands, the warning must stop promising what the schema forbids:
four yellow annotations on every green run teach a reader to skip warnings.
The growth itself is slow and fails loudly. `user_id_for` pages through
staging's auth users under a 50-page bound, so each run's two permanent users
add a page every fifty runs, and a lookup that reaches the bound exits 9
rather than reporting a user absent.

### 3. The client export leaves out much of what Sanpo holds about a client
`fn_export_client_data` (`0040`), the export the operator runs, returns six
named fields of the client row (name, email, phone, status, credit balance,
created), the properties' address fields and public access notes, pets, walks
(date, status, times, distance, notes), credential labels, the ledger and
payments. It leaves out route traces (`walk_gps_points`), photos
(`walk_photos`, `pets.photo_path`), `clients.notes`, `properties.lat`/`lng`,
`pets.is_reactive`/`is_escape_risk`, `recurring_schedules`, the walks' care
flags, notifications, `push_subscriptions`, the credential access log, the
consent record (`notice_accepted_at`, `notice_version`), invite claim
attempts, the address's suppression and `email_suppression_lifts` (`0054`).

Until `0054` the privacy notice promised "a copy of everything held about
you". Its review caught the new notice version repeating that sentence while
this item recorded it as false, so version `2026-09-24` says instead what the
file holds and names route traces, photos and the entry-code log as left out
(the client can see all three in their own account). The notice is now true.
What remains is whether the export grows, and that is not free: route traces
and the access log are the operator's evidence as well as the client's data,
and suppression history is the one thing `0052` deliberately tells an operator
almost nothing about, so it belongs in a copy the client receives rather than
one the operator can read. A written argument before code, and growing the
export lets the notice's promise grow with it (`legal-version.test.ts` keeps
"everything" out until then).

## Done

- **The address owner can turn email back on** — migration `0054`. A client
  whose contact address unsubscribed can lift the suppression from the portal,
  only when that address is the one they sign in with and their session began
  with a link sent to it and opened after the unsubscribe: the trust argument
  the item asked for is in the migration's header and spec 03, and it depends
  on no dashboard setting. Only the one-click row goes, and only when it is
  all that keeps email off; each lift is recorded in `email_suppression_lifts`,
  and an erased client's records go with the rest of the record. See the
  `feat(email-owner-lift)` status-log entry.

- **The Supabase CLI, 2.109.1 → 2.117.0, and production's function deploy
  onto `--use-api`.** Read against the 420 commits in the range, and both
  releases pushed this tree's 52 migrations before moving. The pg-delta
  catalog warning is gone: 2.109.1 printed it, 2.117.0 did not. The
  API-deploy abort that left stale metadata (INC-699) is fixed in the range,
  so it no longer threatens staging's retry loop, and dashboard-issued
  `sbp_v0_` tokens are accepted. One loss, recorded rather than papered over:
  `db push` no longer prints a migration's NOTICE, WARNING or INFO. And one
  hole the bump did not open but vetting it found: `functions deploy` ignores
  an unknown key in `[functions.<name>]` on both releases, so a `verify_jwt`
  typo deploys a public function behind the JWT check with no warning. Gate
  10h now refuses it.
  `scripts/verify-workflows.py` rule 5 now holds both deploy workflows to one
  CLI release and one function-deploy invocation. See the `ops(cli-2.117)`
  status-log entry.

- **Spec-drift PR B — invariant 5's REVOKE half.** Migration `0053` revokes
  EXECUTE on the four definer trigger functions that had kept the platform
  default (PUBLIC, anon, authenticated) since `0012`–`0015`; smoke asserts both
  halves of invariant 5 for every definer function, and that the three
  triggers an API role can reach still fire for `authenticated` with EXECUTE
  revoked. `scripts/gen-definer-catalog.py` models each function's ACL
  instead of collecting GRANTs, so an unrevoked function renders `PUBLIC` and
  fails the build, and gate 8e (`scripts/check-definer-catalog-live.py`) holds
  that model to a reset database. Its review found the four reachable from any
  SQL session holding an API role (never through the product), a grant pattern
  that leaves `authenticated` on the platform default (refused now), and
  healthy SQL the model misread (the TEMP and `search_path` item is what it
  left). See the
  `security(0053)+ci(definer-acl)` status-log entry.

- **Spec-drift PR A — the gates that passed for the wrong reason.** Eight
  checks, each proven red-first against the defect the audit named:
  service-worker fixtures on the app's own origin, so `isNeverCache` is
  exercised at all; the FormError and walk-channel greps replaced by AST scans
  in vitest (they run locally now, too); invariant 1 moved into `smoke.sql`
  with a self-test of its own pattern; `scripts/check-gate-lockstep.py` (gate
  10g) holding `ci.yml`, `SKILL.md` §13 and `validate.sh` to one another; the
  definer catalogue on the enum generator's SQL reader, with probes;
  `verify-deployment`'s read-only argument derived from the source; and one
  fixture library for both staging replays, driven by a test. See the
  `ci(gates-that-fail)` status-log entry.

- **Tell the operator when an edited address is already suppressed** —
  migration `0052`'s `fn_client_email_suppressed`, answering for the calling
  operator's own client only, and a notice in ClientDetail's header. The
  product question the item left open — how, without exposing one operator's
  suppression list to another — is answered in spec 03: a platform-wide row is
  the address owner's instruction to everyone and nobody's list, an
  operator-scoped row is consulted only for its own operator, and one boolean
  leaves the function, labelled with the address it checked. It asks the sender's own `fn_email_suppressed` for each
  type the sender emails (a copy of `CLIENT_FACING`, pinned to it by a deno
  parity test), so the notice and the skip cannot disagree. See the
  `feat(email-suppressed)` status-log entry.

- **The walk-cost duplication and the last two `index.ts`-only functions** —
  `api.ts`'s `walkCost()` wrapper deleted (zero importers), the arithmetic
  moved to a zero-import leaf so a deno script can load it, and gate 8d
  (`scripts/check-walk-cost-parity.sh`) ties that leaf, `fn_walk_cost` and the
  `fn_snapshot_walk_price` trigger to one case list — the residual this item
  named as "nothing ties the two together". Booking now prices a persisted
  walk from its `cost_credits` snapshot rather than re-deriving it live.
  `billing-portal` and `connect-onboarding` got the house `handler.ts` +
  `deps.ts` seams and 37 tests; `{ action: "foo" }` is a 400 rather than a
  fall-through that mints a Stripe Connect account. Three adversarial passes
  ran before the PR opened and the third refuted the second's own sentence
  about the gate. See the `fix(walk-cost)+edge(seams)` status-log entry.

- **Push notifications (M27)** — RFC 8291 payload encryption and RFC 8292
  VAPID written against `crypto.subtle` and pinned byte-for-byte to
  `http_ece`, the reference implementation; migration `0049` for the
  subscriptions table and the `push_*` delivery quartet; a push arm alongside
  H17's email arm in `send-notification`; service-worker `push` /
  `notificationclick`; and a five-state opt-in for both personas. VAPID keys
  are owner action §17 and everything degrades to `skipped` without them.
  Found on the way: `send-notification` had been selecting a column that does
  not exist since `security(0032)`, so no email had ever been sent. See the
  `feat(push)` status-log entry.

- **`claim-signup` rate limit** — migration `0048`. Keyed on the CLIENT the
  invite belongs to, not on the caller: the backlog said "keyed for an
  unauthenticated caller" and an IP key would have bounded nothing the
  attacker cannot escape while locking out everyone behind one NAT. Two of
  spec 04's reasons for accepting the absence turned out to be false, and the
  honest justification is different from both: H31 *removed* a rate limit
  that used to cover this flow. See the `security(0048)` status-log entry.

- **`walk_photos` integrity checksum** — migration `0047`, nullable `sha256` +
  `byte_size` written by the browser at upload, with
  `scripts/verify-photo-integrity.sh` as the consumer so the columns are not
  written-and-never-read. Two of the item's own premises turned out to be
  wrong and are corrected in `disaster-recovery.md`: verification was never
  "impossible" (Storage already records a size and an `eTag`, one join away),
  and the digest is **not** chargeback evidence — the operator can delete and
  re-insert the row. See the `db(0047)` status-log entry.
- **Today illustration responsive variants (M17)** — the plate now ships as
  four candidates (438/640/750/875w) behind one `srcset`, with only the master
  precached and the service worker substituting it for the rest. The review's
  other half, a 2x master, turned out to be **impossible from inside this
  repository**: 875x1798 is every pixel that exists, so a DPR-3 phone still
  upscales. That is now owner action #13. See the `perf(today-plate)`
  status-log entry.
- **The two migration-gated security items** — `fn_rotate_invite` refusing a
  purged client (it used to clear the purge's own revocation and hand a
  tombstone a live 14-day token, which the NULL-email ladder rung then let a
  stranger claim), and `clients.unsubscribe_token` rotating whenever the
  address changes. Migration `0046`; see the `security(0046)` status-log entry.
- **Client & property editing** — the header's *Edit details* and per-property
  *Edit* on ClientDetail. Shipped with the `clients` wildcard-select fix it
  depended on; see the `fix(client-columns)` status-log entry.
- **Atomic send-once on both channels** — migration `0051`'s
  `fn_claim_notification_send`, a conditional UPDATE with a lease, called by
  both delivery arms before anything leaves. The claim is RELEASED when an
  outcome is recorded, which the pre-PR review caught as a P1: holding it hid
  the row from `fn_notification_backlog` for five minutes, and H17's only
  alarm drains and then re-reads that backlog seconds later — so a
  permanently failing provider would have reported green. See the
  `money(send-once)` status-log entry.
