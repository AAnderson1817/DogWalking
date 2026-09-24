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

### 1. The client export leaves out much of what Sanpo holds about a client
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

### 2. `notifications.email_last_error` keeps the email provider's own words
`send-notification` records a failed send as `resend <status>: <up to 300
characters of Resend's response body>`, and `notifications` carries a
table-level SELECT for `authenticated`, so a client reads that text on their
own rows through the API. The push arm stopped doing this for the equally
readable `push_last_error` in PR #85 (the status is recorded and the body goes
to the server log). The email arm should do the same. What a provider body can
contain has not been measured here, so this is the same shape rather than a
known leak. Found by the independent review of 0056.

### 3. A failed read of the entry-code trail shows as no activity
Both readers swallow the error: `VaultFlows.tsx`'s audit sheet and
`PortalHome.tsx` call `listCredentialLog(...)` / `listMyCredentialLog(20)`
with `.catch(() => [])`, so a failed read renders as an empty trail. On the
one screen whose job is to answer "who opened my door", "nothing" and "could
not load" must not look the same (the M39 shape). PortalHome's comment is
right that a failure must not cost the client the whole portal; the section
should say it could not load, and offer a retry.

### 4. Revoke TEMP from PUBLIC
`PUBLIC` holds TEMP on the database (PostgreSQL's default). `0055` closed the
path by which that let a temp table shadow a table inside a definer function:
every function that pins a `search_path` now pins `public, pg_temp`, which
searches temp tables last, and smoke refuses anything else. The same TEMP
privilege is what let an API role attach a definer TRIGGER function to a temp
table of its own, which `0053` closed for the four that were open and smoke now
refuses for all.

What is left is the privilege itself: `revoke temporary on database … from
public`. It would close the same door again, independently of `0055`, and it
cannot be judged from here. It needs measuring on a real project first, to
show that nothing the
platform runs as an API role needs a temporary table: PostgREST, Realtime,
Storage and the auth hooks all connect under roles this repository does not
configure. Not reachable through the product either way: `anon` and
`authenticated` are NOLOGIN, PostgREST issues no DDL, and no function an API
role can execute runs dynamic SQL.

### 5. An erasure leaves the Stripe event payloads and the client's sign-in account
Found by the independent review of 0057; both predate it, and spec 03 now
names them rather than claiming otherwise.

`stripe-webhook` stores every event whole: `claimEvent(event.id, event.type,
event)` writes it to `stripe_events.payload`, and nothing prunes that table. A
checkout session carries `customer_details` (name, email, address, phone), an
invoice `customer_name` / `customer_email` / `customer_address`, and a charge
`billing_details`, so each client's contact details survive their erasure in
the idempotency ledger. Nothing in the tree reads `payload` (checked: every
`stripe_events` access is the claim, the read of its status, the takeover and
the mark-processed), so the likely fix is to stop storing it and null what is
there. It is still a change to the webhook's claim ledger, which is a money
path, so it gets its own argument rather than riding along here.

`fn_purge_client` unbinds the client's account (`auth_user_id = null`) and
leaves the `auth.users` row, with its email, in place. Deleting it needs the
admin API (the migrations cannot assume the deploy role may delete from
`auth.users`), so it is an edge-function step in the erasure flow, ordered
after the purge commits.

## Done

- **An erasure removes the walker's notices about the client** — migration
  `0057`. `notifications.client_id` says who a row is for, so a row the walker
  reads carried NULL there and named its client only in its title; the purge,
  deleting by `client_id`, left "<name> is low on credits" in the walker's
  inbox after the client's record was erased. Each row now records
  `subject_client_id` (filled from `client_id` or the walk by a trigger, set by
  the writers whose rows record neither) and the purge deletes by it. A
  notice about an erased client is not written, and one written while the
  erasure is in flight waits for it (Codex on PR #105). Found while designing
  the export. See the `privacy(0057)` status-log entry.

- **The claim replay deletes its fixtures.** Every staging smoke run left an
  operator, a claimed client and two auth users behind, with four warnings
  ending "Rows accumulate in staging until this is fixed". The item called
  that unfixable and said a purge would still leave three of the four.
  Measured on the local database, a purge leaves none: once `purged_at` is
  set, 0042 lets `fn_purge_client` delete the client's claim attempts, so
  nothing references the tombstone. The replay now erases its client as the
  product does and asserts it, which is the erasure's first run against a
  hosted project, and its teardown deletes all four. Smoke pins both halves
  (the claim trail holds the client until the purge, and nothing holds
  anything after it), and the warning now says a leftover is news. See the
  `ops(claim-fixtures)` status-log entry.

- **Every function that pins a `search_path` pins `public, pg_temp`** —
  migration `0055`. With `pg_temp` unlisted, PostgreSQL searches temp tables
  FIRST, so a definer function pinned to `public` alone read a caller's temp
  table of the same name as a table it uses, as its owner. 73 definer functions
  and four invoker functions moved with one `ALTER FUNCTION … SET search_path`
  each, which changes nothing else: bodies, owners, ACLs, security and
  volatility compared equal before and after. Smoke now refuses `public` alone
  for a definer, and any other pinned path for any function. The TEMP privilege
  itself is item 1. See the `security(0055)` status-log entry.

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
