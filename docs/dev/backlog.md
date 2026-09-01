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

### 1. Small batch (one PR)
- `fn_walk_cost` is LOAD-BEARING (`fn_debit_walk` calls it, smoke pins it) —
  do NOT touch it. The dead code is `api.ts`'s `walkCost()` wrapper, itself
  with zero importers: delete it, or wire it where a persisted walk's display
  cost is shown. `credits.ts`'s client-side mirror is deliberate (Booking
  prices walks that do not exist yet). The residual worth a test: `0043` made
  server pricing snapshot-first while `effectiveWalkCost` computes live
  service arithmetic, and nothing ties the two together.
- Three edge functions are `index.ts`-only with no handler seam and no test:
  `billing-portal`, `connect-onboarding`, and `create-plan` (a money path — it
  mints Stripe Products and Prices). Extract and test per the house
  dependency-injection pattern, `create-plan` first. `materialize-walks` is
  the deliberate thin-wrapper exception (its logic is SQL-side);
  `charge-overage` is already covered through `_lib/overage*.ts`.

### 2. `getClient`/`getOperator` swallow the error, so a blip becomes terminal
Found by the adversarial review of the send-once PR, and **pre-existing** —
identical on `main` and untouched by that diff, which is why it is here rather
than folded into a money-path PR.

`send-notification`'s `getClient` destructures `const { data } = await
db.from("clients")…maybeSingle()` and never inspects `error`, unlike
`getNotification`, `backlogIds` and `isSuppressed` in the same object, which
all throw. supabase-js reports a PostgREST or transport failure in the
RESOLVED result, so a statement timeout or a reset connection yields
`client === null` and the arm records the TERMINAL skip "client has no email
address". `isSettled` treats `skipped` as final and `fn_notification_backlog`
excludes it, so a transient blip permanently cancels a `payment_failed`
email. `getOperator` has the same unchecked shape; its failure only degrades
the business name.

The fix is four lines in each, but the rule worth having with it is the one
`fix(edge-errors)` states: a supabase-js call whose `error` is discarded is
indistinguishable from one that succeeded and found nothing.

### 3. Tell the operator when an edited address is already suppressed
Also recorded in spec 04. Editing a client's address to one already in
`email_suppressions` makes every future client-facing email skip
permanently and terminally, with no signal in the UI. Whether to surface it
— and how, without exposing one operator's suppression list to another — is
a product question.

## Done

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
