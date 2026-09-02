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
- Two edge functions are `index.ts`-only with no handler seam and no test:
  `billing-portal` and `connect-onboarding`. Extract and test per the house
  dependency-injection pattern (`create-plan` got its seam in the
  `money(create-plan)` PR). `materialize-walks` is the deliberate
  thin-wrapper exception (its logic is SQL-side); `charge-overage` is already
  covered through `_lib/overage*.ts`.

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

### 4. The pinned Supabase CLI is behind, and `db push` warns every deploy
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

### 5. Spec-drift audit follow-ups (two PRs left, in this order)
Found by the audit recorded as `docs(spec-drift)`; each was verified against
HEAD and none is fixed by that PR, which corrected documents only.

**PR A — gates that pass for the wrong reason** (tests and CI only):
- `app/scripts/service-worker.test.ts`: every Supabase fixture is
  `https://abcdefgh.supabase.co` against a worker origin of `app.sanpo.test`,
  so `sw.js`'s same-origin gate alone satisfies all five never-cache
  assertions — replacing `isNeverCache`'s body with `return false` stays
  green. Add same-origin fixtures for the five families; prove red first.
- `ci.yml` "Errors go through FormError": greps one literal
  `className="field__error"`. A bare `<span className="signin__error"
  role="alert">` slips past. Fail any `role="alert"` outside `fields.tsx` /
  `StateField`, and any `__error` class outside `fields.tsx`.
- `ci.yml` invariant-1 catalogue regex: misses `update public.clients set …`
  and `update clients c set …` (probed; both silent). Allow an optional
  `public.` and an optional alias; prove with both probe functions.
- `ci.yml` "the only channel": a second `supabase.channel(` inside
  `useWalkChannel.ts` passes (`grep -q`), and the server half greps only the
  literal `private: false`. Count channel calls against `private: true` calls.
- `docs/dev/session-notes.md` says two gates exist only in CI; there are
  seven (service worker stamped, build refused without config, vitest
  orphan, security headers, behavioural tests execute, e2e spec has a step,
  no-secret-logging grep). Add `scripts/check-gate-lockstep.py` (every
  `ci.yml` step name appears in `SKILL.md` as a gate or in its §13), wire it
  as a gate, and point session-notes at §13. Relabel `ci.yml`'s "Secret-leak
  grep (validate gate 7)" — it is gate 11, and gate 7 is `db reset`.
- `scripts/gen-definer-catalog.py` still strips comments with the naive regex
  pair `gen-enum-catalog.py` had to replace (labels containing `--`, nested
  block comments). Share the state machine rather than copy it.
- `verify-deployment.test.ts`: assert every function calling `Deno.serve`
  directly (`stripe-webhook`, `platform-webhook` today) has a `contract_for`
  case, so the read-only argument is derived rather than enumerated.
- `staging-smoke.yml` `onboard-repro`: still the single-page `user_id_for`
  and `|| true` cleanup the claim-replay step was cured of; dead today only
  because its address is run-scoped.

**PR B — migration `0052`, invariant 5's REVOKE half** (money/trust path:
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
function as `PUBLIC` rather than **none**.

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
