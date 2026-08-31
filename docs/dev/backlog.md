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

### 1. `walk_photos` integrity checksum
No checksum or byte size, so a restore cannot verify photo evidence (flagged
in `disaster-recovery.md`). New migration: nullable `sha256` + `byte_size`;
compute in the browser at upload (`crypto.subtle.digest`) alongside the
existing upload-time row insert (`fix(walk-durability)` has that path). No
backfill — a guessed checksum is indistinguishable from a real one. Verifying
on the read path is a follow-up, not that PR.

### 2. `claim-signup` rate limit
Public (`verify_jwt=false`) and its success path calls
`auth.admin.createUser`; no rate limit (a stated residual in spec 04). Follow
the `0016` `vault_rate_limit_attempts` shape, keyed for an unauthenticated
caller. Two properties must survive: the endpoint stays a non-oracle
(identical answers wherever it gives them today), and a legitimate claimant
retrying after a failed `createUser` is not locked out. Red-first on both.

### 3. Push notifications (M27) — the largest item
No push handler in `app/public/sw.js`, no VAPID keys, no subscriptions table.
Scope: subscriptions table (tenant table ⇒ `operator_id` + RLS, invariant 7),
SW `push`/`notificationclick` handlers (mind the network-only rules from
`qc(1–4)`; `app/scripts/service-worker.test.ts` drives the real fetch
handler), opt-in UI, and a send path piggybacking the existing `notifications`
insert. Honest delivery states: copy H17's email machinery. VAPID key
generation is an **owner action** — add it to `owner-actions.md` in the same
commit and degrade gracefully without it.

### 4. Small batch (one PR)
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

### 5. Tell the operator when an edited address is already suppressed
Also recorded in spec 04. Editing a client's address to one already in
`email_suppressions` makes every future client-facing email skip
permanently and terminally, with no signal in the UI. Whether to surface it
— and how, without exposing one operator's suppression list to another — is
a product question.

## Done

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
