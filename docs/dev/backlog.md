# Backlog

Work that is known, scoped and not yet done. One item per PR, roughly in
order. Tick an item when it lands and say where; delete it once the status
log in `CLAUDE.md` carries the entry.

This list lived in a session handoff document until the client-editing PR
moved it here, where it can be maintained by the sessions that consume it.

`docs/dev/owner-actions.md` is the companion list of things no file in this
repository can do. Nothing here needs the owner; everything there does.

## Reserved — do NOT start without the owner

- **CSV import (M23)** and **intake/agreements (M25)**: product-shaping,
  blocked on a scope decision that does not exist yet. Until an entry in the
  status log or `docs/dev/` records those decisions, treat both as undecided.
- **Operator data egress**, and anything in `supabase/migrations/` touching
  the money invariants, the credential vault, RLS semantics, or the deploy
  workflows: reserved for a review-first session.

## Open

### 1. Today illustration responsive variants (M17)
One 875×1798 WebP is served to every device (~34–47% upscale on common
phones). Add `srcset`/`sizes` variants.
- The composition is LOCKED (CLAUDE.md, Ownership) — resizing only, never
  recomposition. Update the hash list in
  `app/scripts/verify-sanpo-assets.mjs` in the same commit, with the reason.
- Check the service-worker asset stamping in `app/vite.config.ts`: the
  precache filter includes `.webp`, and Today's offline cold start must keep
  working (see the `perf(today-field)` entry for why).
- Both e2e suites must stay green: `today-contrast.spec.ts` reads rendered
  PIXELS, `indigo-emaki-today.spec.ts` asserts rendered GEOMETRY. A new spec
  file also needs its own named CI step.

### 2. `walk_photos` integrity checksum
No checksum or byte size, so a restore cannot verify photo evidence (flagged
in `disaster-recovery.md`). New migration: nullable `sha256` + `byte_size`;
compute in the browser at upload (`crypto.subtle.digest`) alongside the
existing upload-time row insert (`fix(walk-durability)` has that path). No
backfill — a guessed checksum is indistinguishable from a real one. Verifying
on the read path is a follow-up, not that PR.

### 3. `claim-signup` rate limit
Public (`verify_jwt=false`) and its success path calls
`auth.admin.createUser`; no rate limit (a stated residual in spec 04). Follow
the `0016` `vault_rate_limit_attempts` shape, keyed for an unauthenticated
caller. Two properties must survive: the endpoint stays a non-oracle
(identical answers wherever it gives them today), and a legitimate claimant
retrying after a failed `createUser` is not locked out. Red-first on both.

### 4. Push notifications (M27) — the largest item
No push handler in `app/public/sw.js`, no VAPID keys, no subscriptions table.
Scope: subscriptions table (tenant table ⇒ `operator_id` + RLS, invariant 7),
SW `push`/`notificationclick` handlers (mind the network-only rules from
`qc(1–4)`; `app/scripts/service-worker.test.ts` drives the real fetch
handler), opt-in UI, and a send path piggybacking the existing `notifications`
insert. Honest delivery states: copy H17's email machinery. VAPID key
generation is an **owner action** — add it to `owner-actions.md` in the same
commit and degrade gracefully without it.

### 5. Small batch (one PR)
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

### 6. Rotate `clients.unsubscribe_token` when the email changes
Found while building the edit surface, and recorded in spec 04. The token is
per-client and is not rotated by an email edit, so a stranger who received a
mistyped email holds a live one-click link that suppresses whatever address
the row holds at click time — the corrected one. Needs a definer function:
the column deliberately carries no UPDATE grant for any API role (`0038`).

### 7. `fn_rotate_invite` / `fn_revoke_invite` have no `purged_at` guard
`fn_unbind_invite` refuses on a purged client; its two siblings do not
(verified against the migrations). A purged client's `email` is NULL, which is
the ladder rung that admits ANY address, so rotating a tombstone's token mints
a bearer credential that makes an erased record claimable again. The operator
UI withholds the panel (`InvitePanel` returns null on `purged_at`), but that is
a frontend guard in front of a function that will still do it. Needs a
migration, so it was not done in the frontend-only PR that found it.

### 8. Tell the operator when an edited address is already suppressed
Also recorded in spec 04. Editing a client's address to one already in
`email_suppressions` makes every future client-facing email skip
permanently and terminally, with no signal in the UI. Whether to surface it
— and how, without exposing one operator's suppression list to another — is
a product question.

## Done

- **Client & property editing** — the header's *Edit details* and per-property
  *Edit* on ClientDetail. Shipped with the `clients` wildcard-select fix it
  depended on; see the `fix(client-columns)` status-log entry.
