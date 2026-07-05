# 02 — Credit & billing engine

Single source of truth = `credit_ledger`. `clients.credit_balance` is a denormalized running balance maintained exclusively by the functions below. Ledger inserts are privileged (spec 03); `balance_after` forms an auditable chain: for each client, ordered by `created_at, id`, every row satisfies `balance_after = previous.balance_after + amount`, first row `balance_after = amount`.

## Locking protocol
Every function below begins `SELECT credit_balance INTO … FROM clients WHERE id = p_client_id FOR UPDATE;` — serializing all balance mutations per client. Ledger insert and `clients.credit_balance` update happen in the same transaction.

## Functions (all `SECURITY DEFINER`, `SET search_path = public`; grants per spec 03)

**fn_grant_credits(p_client uuid, p_amount int, p_note text) → int** — inserts `grant` (+p_amount), updates balance, returns new balance. Called by stripe-webhook on `invoice.paid`.

**fn_walk_cost(p_walk uuid) → int** — `service_types.credit_cost` + `weekend_surcharge_credits` if `scheduled_date` is Sat/Sun. STABLE, no lock.

**fn_debit_walk(p_walk uuid) → table(outcome text, cost int, new_balance int)** — locks client; cost := fn_walk_cost. If `balance >= cost`: ledger `debit` (−cost, walk_id), set `walks.credits_debited = cost`, `is_overage = false` → outcome `'debited'`. Else: NO ledger entry, balance untouched, set `credits_debited = 0`, `is_overage = true` → outcome `'overage'` (caller charges the WHOLE walk at `plans.overage_rate_pence` — invariant 3, never partial). Idempotent: if walk already debited or already flagged overage, returns prior outcome without re-applying.

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
- **Renewal**: `invoice.paid` → `fn_apply_rollover` then `fn_grant_credits(credits_per_cycle)` → `renewal_upcoming` handled by `invoice.upcoming` notification.
- **Walk completion**: complete-walk edge fn → `fn_debit_walk` → `'overage'` ⇒ charge-overage (off-session PaymentIntent, whole walk at plan rate) → payment row → report card + `walk_complete` notification.
- **Low credit**: after any successful debit, if `new_balance ≤ operators.low_credit_threshold` insert `low_credit` notifications (client + operator), deduped: skip if an unread `low_credit` for that client already exists.
- **Pause**: Stripe `pause_collection` → webhook sets `subscription_status='paused'`; no grants; balance preserved; materializer (phase 06) skips schedules whose client is paused and any date inside `paused_from…paused_until` windows.
- **Failed payment**: `invoice.payment_failed` → `subscription_status='past_due'` + `payment_failed` notifications; Stripe smart retries own the retry cadence.
- **Top-up**: v1 = operator runs `fn_adjust_credits` after taking payment manually or via a one-off Checkout (payment mode) recorded as `payments.type='topup'`.
