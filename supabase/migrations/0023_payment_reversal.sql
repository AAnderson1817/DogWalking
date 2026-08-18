-- 0023 — refunds, disputes and credit reversal (review B4, L6)
--
-- The webhook subscribes to six events and none of them is a reversal. A
-- refund issued from the Stripe dashboard — the only way to issue one —
-- returns the money and leaves the payments row reading 'succeeded' with the
-- cycle grant still in the ledger, so the client keeps credits they were
-- refunded for. A disputed overage pulls the funds plus a fee while Sanpo
-- shows the walk paid forever, and the operator finds out only if they happen
-- to read Stripe's email.
--
-- Four parts:
--   1. credit_ledger.stripe_invoice_id — grants become traceable to the money
--      that bought them. Nothing in the schema linked them before, so a
--      reversal could not be computed at all.
--   2. payments reversal columns.
--   3. fn_reverse_payment — the definer, row-locked reversal.
--   4. Two partial indexes widened, and fn_refund_cancelled_debit narrowed.


-- ── 1. Grants become traceable to their invoice ──────────────────────────
-- credit_ledger carried no link to the payment that granted the credits —
-- only free-text `note` reading 'cycle grant in_xxx'. Parsing money out of a
-- note is not a reconciliation strategy, so the invoice id becomes a column.
--
-- Deliberately NOT backfilled. The note text could be parsed for most rows,
-- but a silent best-effort backfill would make pre-migration grants
-- indistinguishable from traced ones, and reversal would then act on a number
-- nobody verified. fn_reverse_payment refuses those rows and flags them for
-- manual reconciliation instead — see reversal_needs_review below.
alter table credit_ledger add column if not exists stripe_invoice_id text;

create index if not exists idx_credit_ledger_invoice
  on credit_ledger (stripe_invoice_id)
  where stripe_invoice_id is not null;

-- A distinct name rather than an overload of fn_grant_credits. Two things
-- pushed against an overload: a default parameter would make the existing
-- three-argument calls ambiguous ('function is not unique'), and even a
-- clean distinct-arity overload breaks scripts/gen-types.py, which keys the
-- generated Database["Functions"] map by NAME and so emits a duplicate
-- identifier that fails tsc. The name also reads better at the call site --
-- this variant exists specifically for invoice-backed cycle grants.
create function fn_grant_cycle_credits(p_client uuid, p_amount int, p_note text,
                                       p_invoice_id text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operator uuid;
  v_balance int;
begin
  if not fn_is_service_session() then
    raise exception 'fn_grant_cycle_credits: service role required';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'fn_grant_cycle_credits: amount must be positive';
  end if;

  select operator_id into v_operator
    from clients where id = p_client for update;
  if not found then
    raise exception 'fn_grant_cycle_credits: unknown client %', p_client;
  end if;

  insert into credit_ledger (operator_id, client_id, entry_type, amount, note,
                             stripe_invoice_id)
  values (v_operator, p_client, 'grant', p_amount, p_note, p_invoice_id);

  select credit_balance into v_balance from clients where id = p_client;
  return v_balance;
end;
$$;

revoke all on function fn_grant_cycle_credits(uuid, int, text, text)
  from public, anon, authenticated;
grant execute on function fn_grant_cycle_credits(uuid, int, text, text) to service_role;


-- ── 2. Reversal state on payments ────────────────────────────────────────
-- refunded_amount_pence is CUMULATIVE, mirroring Stripe's
-- charge.amount_refunded. Stripe reports the running total rather than each
-- delta, and partial refunds can arrive repeatedly; storing the same quantity
-- Stripe stores is what makes replay a no-op instead of a double clawback.
alter table payments
  add column if not exists refunded_amount_pence int not null default 0,
  add column if not exists reversed_at timestamptz,
  add column if not exists reversal_reason text,
  add column if not exists credits_reversed int not null default 0,
  add column if not exists credits_unrecovered int not null default 0,
  add column if not exists reversal_needs_review boolean not null default false,
  add column if not exists stripe_charge_id text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payments_refund_within_amount') then
    alter table payments add constraint payments_refund_within_amount
      check (refunded_amount_pence >= 0 and refunded_amount_pence <= amount_pence);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payments_credits_reversed_nonneg') then
    alter table payments add constraint payments_credits_reversed_nonneg
      check (credits_reversed >= 0 and credits_unrecovered >= 0);
  end if;
end $$;

create index if not exists idx_payments_charge
  on payments (stripe_charge_id) where stripe_charge_id is not null;

-- Surfaced to the operator, so it must be readable. Writes stay definer-only:
-- the table already grants authenticated nothing but SELECT (spec 03).
comment on column payments.credits_unrecovered is
  'Credits owed back on a reversal that the balance could not cover. Real money the operator will not get back — surfaced, never silently absorbed.';


-- ── 3. Reversing a payment ───────────────────────────────────────────────
-- Credit balance is floored at zero by both a CHECK constraint on
-- clients.credit_balance and an explicit raise in fn_ledger_apply, so "let the
-- balance go negative" is not available without breaking invariant 1. The
-- clawback therefore takes what is there and records the rest as unrecovered.
--
-- Proportional, because a partial refund of a cycle invoice returns part of
-- what bought the credits. Overage payments buy no credits at all (a walk is
-- EITHER credit-funded OR charged — invariant 3), so an overage reversal
-- moves money only and touches the ledger not at all.
--
-- Never writes clients.credit_balance directly (invariant 1): it inserts a
-- compensating ledger entry and lets fn_ledger_apply move the balance.
create function fn_reverse_payment(
  p_payment uuid,
  p_kind text,            -- 'refund' | 'dispute'
  p_amount_pence int,     -- CUMULATIVE reversed total, as Stripe reports it
  p_reason text
) returns table (
  outcome text,
  credits_reversed int,
  credits_unrecovered int,
  needs_review boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pay payments%rowtype;
  v_delta int;
  v_granted int;
  v_due int;
  v_claw int;
  v_short int;
  v_balance int;
  v_review boolean := false;
  v_status payment_status;
begin
  if not fn_is_service_session() then
    raise exception 'fn_reverse_payment: service role required';
  end if;
  if p_kind is null or p_kind not in ('refund', 'dispute') then
    raise exception 'fn_reverse_payment: kind must be refund or dispute, got %', p_kind;
  end if;
  if p_amount_pence is null or p_amount_pence < 0 then
    raise exception 'fn_reverse_payment: amount must be non-negative';
  end if;

  select * into v_pay from payments where id = p_payment;
  if not found then
    raise exception 'fn_reverse_payment: unknown payment %', p_payment;
  end if;

  -- Serialize with every other balance mutation for this client, and do it
  -- BEFORE re-reading the payment, so two deliveries of the same refund
  -- cannot both compute a delta against the same starting figure.
  perform 1 from clients where id = v_pay.client_id for update;
  select * into v_pay from payments where id = p_payment;

  if p_amount_pence > v_pay.amount_pence then
    raise exception 'fn_reverse_payment: reversed % exceeds charged % on payment %',
      p_amount_pence, v_pay.amount_pence, p_payment;
  end if;

  v_delta := p_amount_pence - v_pay.refunded_amount_pence;
  if v_delta <= 0 then
    -- Replay, or an out-of-order delivery reporting a smaller cumulative
    -- total than one already applied. Both are no-ops by construction.
    return query select 'noop'::text, 0, 0, v_pay.reversal_needs_review;
    return;
  end if;

  -- How many credits did this money buy?
  if v_pay.type = 'overage' then
    v_due := 0;                                    -- overage grants nothing
  elsif v_pay.stripe_invoice_id is null then
    v_due := 0; v_review := true;                  -- untraceable
  else
    select coalesce(sum(amount), 0) into v_granted
      from credit_ledger
     where stripe_invoice_id = v_pay.stripe_invoice_id
       and entry_type = 'grant';
    if v_granted = 0 then
      -- Either a grant predating the stripe_invoice_id column, or a payment
      -- that never granted. Indistinguishable from here, so refuse to guess.
      v_due := 0; v_review := true;
    elsif v_pay.amount_pence = 0 then
      v_due := 0; v_review := true;                -- fully discounted; no ratio
    else
      v_due := round(v_granted::numeric * v_delta::numeric / v_pay.amount_pence::numeric);
    end if;
  end if;

  select credit_balance into v_balance from clients where id = v_pay.client_id;
  v_claw := least(v_due, greatest(v_balance, 0));
  v_short := v_due - v_claw;

  if v_claw > 0 then
    insert into credit_ledger (operator_id, client_id, entry_type, amount,
                               note, stripe_invoice_id)
    values (v_pay.operator_id, v_pay.client_id, 'adjust', -v_claw,
            format('%s reversal: %s', p_kind, coalesce(p_reason, 'no reason given')),
            v_pay.stripe_invoice_id);
  end if;

  -- A dispute is its own state. A refund only becomes 'refunded' when the
  -- whole charge is returned — there is no 'partially_refunded', and calling
  -- a half-refunded payment 'refunded' would overstate it. The cumulative
  -- refunded_amount_pence carries the partial case.
  if p_kind = 'dispute' then
    v_status := 'disputed';
  elsif p_amount_pence >= v_pay.amount_pence then
    v_status := 'refunded';
  else
    v_status := v_pay.status;
  end if;

  -- The right-hand sides are qualified because this function's RETURNS TABLE
  -- columns are named credits_reversed / credits_unrecovered too, and an
  -- unqualified reference resolves to the plpgsql OUT variable -- which is 0
  -- here. The accumulation would silently become an assignment, so a second
  -- partial refund would overwrite the first rather than add to it. Postgres
  -- catches this one as an ambiguity; it would not catch it if the OUT names
  -- had differed by a character.
  update payments
     set refunded_amount_pence = p_amount_pence,
         reversed_at = now(),
         reversal_reason = p_reason,
         credits_reversed = payments.credits_reversed + v_claw,
         credits_unrecovered = payments.credits_unrecovered + v_short,
         reversal_needs_review = payments.reversal_needs_review or v_review,
         status = v_status
   where id = p_payment;

  return query select 'reversed'::text, v_claw, v_short, v_review;
end;
$$;

revoke all on function fn_reverse_payment(uuid, text, int, text)
  from public, anon, authenticated;
grant execute on function fn_reverse_payment(uuid, text, int, text) to service_role;


-- ── 4a. Reversal must not unlock a second charge ─────────────────────────
-- Both of these partial indexes filter on status, so flipping a row to
-- 'refunded' or 'disputed' would drop it OUT of its own uniqueness guarantee.
--
-- On payments/uq_payments_subscription_invoice that is a double-grant hole:
-- fn_apply_invoice_paid decides idempotency by looking for a succeeded
-- payment on the invoice, so a replayed invoice.paid after a refund would
-- find nothing and grant a second cycle of credits. On the overage index it
-- is a double-charge hole by the same mechanism.
--
-- Reversing a charge must never restore the ability to make it again.
-- Dropping and recreating an index is a forward change, not an edit to an
-- applied migration (invariant 6).
drop index if exists uq_payments_subscription_invoice;
create unique index uq_payments_subscription_invoice
  on payments (stripe_invoice_id)
  where stripe_invoice_id is not null and type = 'subscription'
    and status in ('succeeded', 'refunded', 'disputed');

-- 'failed' stays excluded: invoice.payment_failed writes a row carrying the
-- same invoice id, and a later successful payment for that invoice must be
-- able to coexist with it.
drop index if exists uq_overage_payment_per_walk;
create unique index uq_overage_payment_per_walk
  on payments (walk_id)
  where type = 'overage' and status in ('succeeded', 'pending', 'refunded', 'disputed');

-- The matching half of the same fix: the function's own idempotency test has
-- to widen with its index, or the index simply raises instead of the check
-- returning false. Body is otherwise byte-identical to 0013's, and now passes
-- the invoice id through to the grant so the ledger row is traceable.
create or replace function fn_apply_invoice_paid(
  p_client uuid,
  p_credits int,
  p_invoice_id text,
  p_amount_pence int,
  p_currency text,
  p_receipt_url text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operator uuid;
begin
  if not fn_is_service_session() then
    raise exception 'fn_apply_invoice_paid: service role required';
  end if;
  if p_invoice_id is null or length(p_invoice_id) = 0 then
    raise exception 'fn_apply_invoice_paid: invoice id required';
  end if;

  select operator_id into v_operator
    from clients where id = p_client for update;
  if not found then
    raise exception 'fn_apply_invoice_paid: unknown client %', p_client;
  end if;

  if exists (
    select 1 from payments
     where stripe_invoice_id = p_invoice_id
       and type = 'subscription'
       and status in ('succeeded', 'refunded', 'disputed')
  ) then
    return false;
  end if;

  insert into payments (operator_id, client_id, type, amount_pence, currency,
                        status, stripe_invoice_id, receipt_url)
  values (v_operator, p_client, 'subscription', coalesce(p_amount_pence, 0),
          upper(coalesce(p_currency, 'USD')), 'succeeded', p_invoice_id, p_receipt_url);

  perform fn_apply_rollover(p_client);
  perform fn_grant_cycle_credits(p_client, p_credits,
                                 format('cycle grant %s', p_invoice_id), p_invoice_id);

  return true;
end;
$$;


-- ── 4b. L6 — the auto-refund trigger was too broad ───────────────────────
-- 0013 added it for a state the bill-before-complete reorder created:
-- in_progress with credits_debited > 0. Its guard was `old.status not in
-- (cancelled, no_show)`, which also matches a COMPLETED walk. Marking a
-- delivered walk no_show would refund the credit and leave credits_debited
-- set, making any re-completion free.
--
-- Latent rather than live — Calendar.tsx gates the buttons to
-- scheduled/in_progress and the client guard trigger allows only
-- scheduled -> cancelled — so this narrows the function to the state it was
-- written for and zeroes credits_debited on the way out, which is what stops
-- a re-completion being free even if a surface ever reaches it.
create or replace function fn_refund_cancelled_debit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('cancelled', 'no_show')
     and old.status = 'in_progress'
     and old.credits_debited > 0
     and not exists (
       select 1 from credit_ledger
        where walk_id = new.id and entry_type = 'adjust' and amount > 0
          and note = 'auto refund: walk cancelled after debit'
     )
  then
    perform 1 from clients where id = new.client_id for update;
    insert into credit_ledger (operator_id, client_id, entry_type, amount, walk_id, note)
    values (new.operator_id, new.client_id, 'adjust', old.credits_debited,
            new.id, 'auto refund: walk cancelled after debit');
    -- The credit is back; the walk must stop claiming it was paid for.
    new.credits_debited := 0;
  end if;
  return new;
end;
$$;
