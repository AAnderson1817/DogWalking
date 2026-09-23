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

### 1. The pinned Supabase CLI is behind, and `db push` warns every deploy
Read off the `24c74bd` staging deploy (run 33537033230, `Apply migrations`),
not recalled:

```
Warning: failed to cache migrations catalog: error exporting pg-delta catalog:
edge-runtime script produced no output:
runtime has escaped from the event loop unexpectedly: event loop error:
Error: Failed to read certificate file
'/workspace/supabase/.temp/pgdelta/pgdelta-target-ca.crt': ENOENT
...
Finished supabase db push.
A new version of Supabase CLI is available: v2.116.0 (currently installed v2.109.1)
```

What it is **not**: a failed migration. The line is prefixed `Warning`, the
failing step is an optional *catalog cache*, `db push` reports `Finished`, and
the job is green — `0051` applied on this exact run. What it is: recurring
noise in the log a reader consults when a deploy genuinely breaks, which is
the `ops(gate-noise)` failure mode — a red (or a scary stack trace) that
means nothing spends the credibility of one that does.

The pin is six places across the two deploy workflows and is deliberate: it
was raised to 2.109.1 because 2.99.0 predated the `local_smtp` config key and
broke `supabase link`. So this is a **deploy-workflow change** — a raise-the-bar
path — and wants its own argument, not a drive-by bump. Before moving it, read
2.109.1 → current release notes for `db push` and `functions deploy` changes;
`supabase.com` is blocked by the egress proxy from this container, so that
reading has to come from somewhere reachable. The version to move to must be
read at the time, not taken from this file.

Not urgent: nothing is broken, and the cost of being wrong here is a deploy
that fails at `link` or `push`, which is exactly the failure 2.109.1 was
pinned to avoid.

**Unblocked 2026-09-23.** The only real test of a CLI bump is a staging
deploy, and staging was down from run 101 (2026-09-15) on the expired
`SUPABASE_ACCESS_TOKEN` until the owner renewed it; run 105 on `4c45ab1` was
green end to end (owner-actions §2a). That commit also moved the STAGING
function deploy to `supabase functions deploy --use-api`, bundling server-side
because GHCR rate limits blocked the Docker bundler image on two fresh runners
(`docs/dev/staging-recovery-2026-09-23.md`). `deploy-production.yml` still
bundles with Docker, deliberately, until staging has demonstrated the new path;
run 105 is one demonstration. Moving production to `--use-api` belongs with this
item: same workflows, same raise-the-bar argument, same staging-first test.

### 2. Spec-drift audit follow-up: the next migration
Found by the audit recorded as `docs(spec-drift)` and verified against HEAD;
PR A (the gates that passed for the wrong reason) is done — see below.

**Invariant 5's REVOKE half** (money/trust path:
written safety argument, adversarial self-review, red-first smoke):
`fn_assert_plan_change_intent_tenant`, `fn_assert_tenant_consistency`,
`fn_cancel_paused_walks` and `fn_refund_cancelled_debit` carry `=X` (PUBLIC)
and `anon=X` in `proacl`; the other 13 definer trigger functions were
revoked. Not exploitable (Postgres refuses to call a trigger function
directly; no API role holds CREATE or TRIGGER), and a trigger still fires
for `authenticated` with EXECUTE revoked (measured). Revoke the four; add a
smoke block asserting no `prosecdef` function in `public` grants EXECUTE to
`public` or `anon` (red against HEAD first); make
`scripts/gen-definer-catalog.py` read `revoke` too and render an unrevoked
function as `PUBLIC` rather than **none**. The generator now reads migrations
with the enum generator's SQL reader and has a proof set
(`scripts/gen-definer-catalog-proofs.py`); add the revoke cases there.

### 3. Let the address owner turn email back on
`0052` tells the operator when a client's address has unsubscribed, and the
notice deliberately promises no way back, because none exists: a suppression
is permanent, an operator must never be able to lift one (0038), and the
address owner has no path either. So a client who unsubscribed from one
walker's mail and later hires another gets no email from anyone, forever.

The one honest proof of ownership available is a claimed client whose login
email — confirmed by GoTrue — equals the suppressed address. A definer
function callable only by that client, deleting only the platform-wide rows
for `lower(auth.users.email)` and only when `email_confirmed_at` is set, would
let them opt back in from the portal without anything ever emailing a
suppressed address. Product surface rather than a fix, which is why it is its
own item; the trust questions (what a shared login proves, whether to log
lifts) want a written argument before code.

## Done

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
