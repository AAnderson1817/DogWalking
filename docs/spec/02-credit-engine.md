# 02 — Credit & billing engine

Single source of truth = `credit_ledger`. `clients.credit_balance` is a denormalized running balance maintained exclusively by the functions below. Ledger inserts are privileged (spec 03); `balance_after` forms an auditable chain: for each client, ordered by `created_at, id`, every row satisfies `balance_after = previous.balance_after + amount`, first row `balance_after = amount`.

## Locking protocol
Every function below begins `SELECT credit_balance INTO … FROM clients WHERE id = p_client_id FOR UPDATE;` — serializing all balance mutations per client. Ledger insert and `clients.credit_balance` update happen in the same transaction.

### The canonical order is walks, then clients (0037)

A function needing both row locks takes the **walk first**. This is not a
preference between two workable orders — it is the only one available.
`fn_refund_cancelled_debit` is a BEFORE UPDATE trigger on `walks`, so its body
runs with the walk tuple already locked by the UPDATE that fired it and can
only reach `clients` afterwards. Anything taking them the other way round
completes a deadlock cycle with it (review M32).

Walks-first was chosen over the alternative — a cancel RPC that takes the
client lock before updating the walk — because the trigger fires for *every*
path that cancels a walk (portal cancel, pause-window sweep, schedule
deactivation, whatever is written next), and only walks-first is an order those
paths cannot violate even without knowing the rule exists.

`fn_debit_walk` was the one violator and is fixed in 0037; nothing else in the
tree takes both. Two tests hold the line: `smoke.sql` reads the lock sequence
out of `pg_get_functiondef` for every function that takes both and fails on
any that inverts it, and `concurrency.sh` case 5 reproduces the deadlock itself
against two real backends.

## Functions (all `SECURITY DEFINER`, `SET search_path = public`; grants per spec 03)

**fn_grant_credits(p_client uuid, p_amount int, p_note text) → int** — inserts `grant` (+p_amount), updates balance, returns new balance. Called by stripe-webhook on `invoice.paid`.

**fn_grant_cycle_credits(p_client uuid, p_amount int, p_note text, p_invoice_id text) → int** — as above, plus it stamps `credit_ledger.stripe_invoice_id`. This is the variant `fn_apply_invoice_paid` uses, and it exists because nothing previously linked a grant to the money that bought it — the only trace was free-text `note` reading `'cycle grant in_xxx'`, and parsing money out of a note is not a reconciliation strategy. A distinct name rather than an overload: a default parameter would make the three-argument calls ambiguous, and `gen-types.py` keys the generated `Functions` map by name, so an overload emits a duplicate identifier that fails `tsc`.

**fn_reverse_payment(p_payment uuid, p_kind text, p_amount_pence int, p_reason text) → table(outcome text, credits_reversed int, credits_unrecovered int, needs_review boolean)** — locks the client, then unwinds a refund or dispute (0023, review B4). `p_amount_pence` is the **CUMULATIVE** reversed total, mirroring Stripe's `charge.amount_refunded`; the function computes the delta against `payments.refunded_amount_pence`, so a replay (or an out-of-order delivery reporting a smaller total) is a `noop` by construction rather than a second clawback.
- Credits due are **proportional**: `round(granted × delta ÷ amount_pence)`, where `granted` is summed from ledger `grant` rows carrying the payment's invoice id.
- `type = 'overage'` reverses **no credits at all** — overage buys none (invariant 3), so an overage reversal moves money only and must leave the ledger untouched.
- The clawback is **floored at the current balance**: `clients.credit_balance` carries `check (credit_balance >= 0)` and `fn_ledger_apply` raises on a negative result, so a negative balance is not available without breaking invariant 1. Whatever cannot be taken is recorded in `payments.credits_unrecovered` and surfaced to the operator — it is real money they will not get back, and absorbing it silently is the worse failure.
- A grant with **no traceable invoice** (written before 0023, or a payment that never granted — indistinguishable from here) sets `reversal_needs_review` and claws back nothing. Reconstructing a figure from the plan's current `credits_per_cycle` would be wrong whenever the plan changed between the grant and the refund, so it refuses to guess.
- Status: `dispute` → `disputed`; a refund becomes `refunded` only when the whole charge is returned. There is no partial status and claiming the stronger one would overstate it, so the cumulative `refunded_amount_pence` carries the partial case.
- Never writes `clients.credit_balance` (invariant 1) — it inserts a compensating `adjust` entry and lets `fn_ledger_apply` move the balance.

**Reversal must never unlock a second charge.** `uq_payments_subscription_invoice` and `uq_overage_payment_per_walk` are partial indexes filtered on `status`, so flipping a row to `refunded`/`disputed` would drop it out of its own uniqueness guarantee — and `fn_apply_invoice_paid` decides idempotency the same way. Before 0023 that was a live double-grant hole: Stripe redelivers `invoice.paid` for three days, and a redelivery after a refund granted a second cycle. Both predicates and the function's check now include the reversed statuses.

**fn_apply_invoice_paid(…, p_is_renewal boolean) → boolean** — gained the flag in 0026. `fn_apply_rollover` runs ONLY when true. Rollover means "carry what is left of the cycle that just ended", so a first invoice (`subscription_create`) has no prior cycle and running it there is a bug rather than a policy: on `rollover_policy='none'` it inserts a negative ledger row for the whole balance before the first grant lands, destroying any credit granted before billing started. The six-argument version is dropped rather than kept as an overload — two functions differing only by a trailing boolean is the shape a caller gets wrong, and the six-argument one is the version that destroys credits.

**fn_walk_cost(p_walk uuid) → int** — `coalesce(walks.cost_credits, service_types.credit_cost + weekend_surcharge_credits if scheduled_date is Sat/Sun)`. STABLE, no lock.

**The price is snapshotted at creation, not read at completion (0043, review L7).** `walks.cost_credits` and `walks.overage_rate_pence` are written by `trg_walks_snapshot_price`, a BEFORE INSERT trigger. The client agrees to a price at booking and is charged at completion, and until 0043 both figures were read from fully mutable tables at the later moment — so an operator editing a service type or an overage rate on the Settings screen silently re-priced every walk already on the calendar, with nothing in the database proving what was agreed.

Three rules, each deliberate:

- **A trigger, not each creator.** A walk is born three ways — `fn_book_walk` (client), the operator's direct INSERT, and `fn_materialize_walks` (nightly) — and a fourth will exist. A trigger cannot be forgotten by the one that comes next.
- **Nothing is backfilled.** Rows created before 0043 carry null and fall back to the live tables, which is exactly the behaviour they shipped with. A backfill would stamp today's prices onto historical walks and present them as the agreed price — a guess indistinguishable from a real snapshot. Same call 0023 made on untraceable payments.
- **`overage_rate_pence` null means "no snapshot", never "free".** The overage path already refuses a walk whose client is on no plan; writing 0 would turn that honest refusal into a silent zero-value charge.

No API role has UPDATE on either column: a snapshot the operator can rewrite afterwards is not a snapshot. Re-pricing an existing walk is a decision, and a surface for it would need its own function and its own audit line.

**fn_debit_walk(p_walk uuid) → table(outcome text, cost int, new_balance int)** — locks the **walk, then the client** (0037, see the lock order below); cost := fn_walk_cost. If `balance >= cost`: ledger `debit` (−cost, walk_id), set `walks.credits_debited = cost`, `is_overage = false` → outcome `'debited'`. Else: NO ledger entry, balance untouched, set `credits_debited = 0`, `is_overage = true` → outcome `'overage'` (caller charges the WHOLE walk at `plans.overage_rate_pence` — invariant 3, never partial). Idempotent: if walk already debited or already flagged overage, returns prior outcome without re-applying.

**fn_adjust_credits(p_client uuid, p_amount int, p_note text) → int** — operator manual `adjust` (±). Rejects if result < 0.

**fn_apply_rollover(p_client uuid) → int** — called by stripe-webhook at cycle boundary (on `invoice.paid`, BEFORE `fn_grant_credits` for the new cycle). Reads plan policy; `bal` = current balance.
- `none`: insert `expiry` (−bal) if bal > 0. New cycle starts at 0 + grant.
- `capped`: carried := least(bal, rollover_cap); if bal > carried insert `expiry` −(bal − carried); if carried > 0 insert `expiry` (−carried) then `rollover` (+carried, `expires_at = now() + rollover_expiry_days` if set) — the expiry/rollover pair re-books the carryover as one explicit lot.
- `unlimited`: no entries; balance persists (optional `rollover` marker amount 0 is NOT inserted — amount must be ≠ 0).

**Single-lot v1 rule (documented simplification vs per-grant FIFO):** at most one live rollover lot exists per client (each boundary collapses everything into one lot). Debits conceptually consume the lot first.

**fn_expire_credits() → int** — sweep (invoked by scheduled edge cron, phase 08; callable manually). For each client with a `rollover` lot whose `expires_at < now()` and no later `expiry` referencing it: `consumed` := Σ|debit| since lot creation; `remaining` := greatest(0, lot.amount − consumed) capped at current balance; if remaining > 0 insert `expiry` (−remaining, note referencing lot id). Returns count of clients swept.

**fn_change_plan(p_client uuid, p_new_plan uuid, p_remaining_fraction numeric) → int** — credit-side proration only (Stripe prorates price via `proration_behavior=create_prorations`, driven by the change-plan edge function which supplies the remaining fraction from the Stripe period). `delta := floor((new.credits_per_cycle − old.credits_per_cycle) × f)`; if delta > 0 insert `adjust` (+delta, note 'plan upgrade proration'); if delta ≤ 0 **no clawback** — already-granted credits stand (documented). Updates `clients.plan_id`.

## Lifecycle
- **Subscribe**: operator creates Stripe Checkout (subscription mode) for a client → `checkout.session.completed` links `stripe_subscription_id`, sets `subscription_status='active'` → first `invoice.paid` grants cycle credits.
- **Renewal**: `invoice.paid` → **`fn_apply_invoice_paid(…, p_is_renewal => true)`**, which does the payment row, the rollover and the cycle grant in ONE transaction keyed on the Stripe invoice id (0013, extended in 0026). It is not `fn_apply_rollover` then `fn_grant_credits` — that sequence is what this line said until the H21 reconciliation, and running it as two calls is the bug 0013 fixed: a failure between them expires the old balance and never grants the new one. `p_is_renewal` gates the rollover, because a first invoice (`subscription_create`) has no prior cycle to carry — see `fn_apply_invoice_paid` above. `renewal_upcoming` is handled by the `invoice.upcoming` notification.
- **Walk completion**: complete-walk edge fn → `fn_debit_walk` → `'overage'` ⇒ charge-overage (off-session PaymentIntent, whole walk at plan rate) → payment row → report card + `walk_complete` notification, **and on a succeeded charge a `payment_taken` notification carrying the amount and the receipt** (review H12).

### Disclosing an off-session charge (review H12)

An overage is charged at COMPLETION, with nobody present. Three things now make
that visible rather than a surprise on a statement:

1. **At subscribe.** Stripe Checkout carries `custom_text.submit.message`
   naming the overage rate, so the mandate says what it authorises and Stripe
   stores the session. Omitted entirely when the plan has no overage rate —
   a disclosure with no figure in it is worse than none.
2. **At booking.** `needsOverage` compared the walk's cost against the RAW
   balance, so a client with two credits could book three walks and see the
   confirmation on none: each is individually affordable at booking, and
   billing happens later. `committedCredits` counts walks already booked and
   not yet started, so the disclosure matches what will actually happen.
   `scheduled` only — an `in_progress` walk has already been debited or
   flagged, and counting it twice would warn about a charge that will not come.
3. **At the moment money moves, and after.** `payment_taken` names the amount
   and links the receipt; the report card shows what the walk cost.

**Deliberately NOT built**: a sweep that notifies when a scheduled walk becomes
unfunded because the balance dropped. It fires per walk per night, the state it
warns about reverses at the next cycle grant, and a recurring "this will cost
extra" message is the kind that gets muted — after which the charge is a
surprise again, with the extra insult of having been "told". The disclosure
sits where the client is already looking and where the money actually moves.
- **Low credit**: after any successful debit, if `new_balance ≤ operators.low_credit_threshold` insert `low_credit` notifications (client + operator), deduped: skip if an unread `low_credit` for that client already exists.
- **Pause**: Stripe `pause_collection` → webhook sets `subscription_status='paused'`; no grants; balance preserved; materializer (phase 06) skips schedules whose client is paused and any date inside `paused_from…paused_until` windows.
- **Failed payment**: `invoice.payment_failed` → `subscription_status='past_due'` + `payment_failed` notifications; Stripe smart retries own the retry cadence.
- **Top-up**: v1 = operator runs `fn_adjust_credits` after taking payment manually or via a one-off Checkout (payment mode) recorded as `payments.type='topup'`.
