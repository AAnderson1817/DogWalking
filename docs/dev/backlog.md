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

### 1. Push notifications (M27) — the largest item
No push handler in `app/public/sw.js`, no VAPID keys, no subscriptions table.
Scope: subscriptions table (tenant table ⇒ `operator_id` + RLS, invariant 7),
SW `push`/`notificationclick` handlers (mind the network-only rules from
`qc(1–4)`; `app/scripts/service-worker.test.ts` drives the real fetch
handler), opt-in UI, and a send path piggybacking the existing `notifications`
insert. Honest delivery states: copy H17's email machinery. VAPID key
generation is an **owner action** — add it to `owner-actions.md` in the same
commit and degrade gracefully without it.

### 2. Small batch (one PR)
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

### 3. Tell the operator when an edited address is already suppressed
Also recorded in spec 04. Editing a client's address to one already in
`email_suppressions` makes every future client-facing email skip
permanently and terminally, with no signal in the UI. Whether to surface it
— and how, without exposing one operator's suppression list to another — is
a product question.

## Done

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
