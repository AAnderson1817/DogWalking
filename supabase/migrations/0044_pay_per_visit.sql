-- 0044 — pay-per-visit becomes first-class (review H32).
--
-- Adopting Sanpo required moving 100% of a book onto recurring card
-- subscriptions on day one: a client with no plan hit the overage path's
-- "no plan on file" refusal at every completion, and payments.type='topup'
-- had been a dead enum value since 0001 — cash top-ups were collected
-- out-of-band and typed into fn_adjust_credits by hand.
--
-- Three schema pieces here; the edge functions and UI land in the same PR.
--
--   1. service_types.visit_price_pence — what one visit costs in dollars when
--      it is not credit-funded. Nullable: null means the operator does not
--      offer cash billing for this service, and the completion path keeps its
--      honest refusal.
--   2. walks.visit_price_pence — the 0043 treatment: snapshotted at INSERT by
--      the same trigger, because the price in force when the walk was put on
--      the calendar is the price the walk is charged at. Read by the charge
--      path in preference to any live table (which 0043 said about
--      overage_rate_pence and did not deliver — the charge path read the live
--      plan rate until this PR; see _lib/overage.ts).
--   3. fn_apply_topup — payment row + credit grant in ONE transaction keyed on
--      the Stripe PaymentIntent, the fn_apply_invoice_paid shape. The webhook
--      calls it for PAID payment-mode checkout completions.

-- ── 0. A bell type for "the client saved a card" ──────────────────────────
-- Setup-mode checkout is how a no-plan client puts a card on file; the
-- operator needs to know it happened, because it is the moment the client
-- becomes chargeable. Operator-only: it is not in send-notification's
-- CLIENT_FACING set, so no email is ever attempted for it. The value is
-- added here and used only from TypeScript, never in this file — adding and
-- using an enum value in one migration fails db-push-check's
-- transaction-per-file apply (recorded in ops(deploy-verify)).
alter type notification_type add value if not exists 'card_saved';

-- ── 1. The visit price on the service ─────────────────────────────────────
-- > 0 for the same reason plans_overage_rate_positive exists (0026): a zero
-- price is not "free", it is a misconfiguration that Stripe would reject at
-- the moment of charging, after the walk is done. "No cash billing" is NULL.
alter table service_types
  add column visit_price_pence int check (visit_price_pence > 0);

comment on column service_types.visit_price_pence is
  'Cash price of one visit when not credit-funded (review H32). Cents despite the name (CLAUDE.md). Null = this service is not offered pay-per-visit.';

-- The column rides the existing table-level grants (0004): the operator edits
-- it from Settings through PostgREST, and the client persona can SELECT it
-- through service_types_client_select — deliberately, because Booking's
-- charge disclosure (review H12) has to show the figure the client will pay.

-- ── 2. The snapshot on the walk ───────────────────────────────────────────
alter table walks
  add column visit_price_pence int check (visit_price_pence > 0);

comment on column walks.visit_price_pence is
  'The service''s visit price when this walk was created (0043 treatment). Null means "no snapshot", never "free": a walk with neither a plan-rate snapshot nor a visit-price snapshot is refused by the overage path, not charged 0.';

-- Body below is pg_get_functiondef of the live 0043 function plus the third
-- fill block — read back from the database before editing, not rewritten
-- from memory (the security(email-consent) entry records what writing a
-- CREATE OR REPLACE from memory cost).
create or replace function fn_snapshot_walk_price() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.cost_credits is null then
    select st.credit_cost
         + case when extract(isodow from new.scheduled_date) in (6, 7)
                then st.weekend_surcharge_credits else 0 end
      into new.cost_credits
      from service_types st
     where st.id = new.service_type_id;
  end if;

  -- Null when the client is on no plan. That is not "free": the overage path
  -- already refuses a walk with no rate (`failWithoutAttempt`, "not on a
  -- plan"), and writing 0 here would turn that honest refusal into a silent
  -- zero-value charge.
  --
  -- A retained plan prices walks only while its subscription is LIVE
  -- (active/paused/past_due — an allow-list, so a future enum value stops
  -- pricing until somebody decides what it means, the 0026 posture).
  -- customer.subscription.deleted clears the binding but deliberately keeps
  -- plan_id, so a cancelled client walked as pay-per-visit would otherwise
  -- have every new walk stamped with a rate whose Stripe mandate died with
  -- the subscription, while their card-save mandate names visit prices
  -- (Codex review finding on #76). A client who never checked out
  -- ('none' with a plan picked but never subscribed) never mandated the
  -- plan rate at all — same rule covers both.
  if new.overage_rate_pence is null then
    select p.overage_rate_pence into new.overage_rate_pence
      from clients c
      join plans p on p.id = c.plan_id
     where c.id = new.client_id
       and c.subscription_status in ('active', 'paused', 'past_due');
  end if;

  -- The visit price, same treatment. Null when the service has no cash
  -- price; the charge path prefers the plan-rate snapshot when both exist,
  -- so a plan client's walk is never charged the cash price by accident.
  if new.visit_price_pence is null then
    select st.visit_price_pence into new.visit_price_pence
      from service_types st
     where st.id = new.service_type_id;
  end if;

  return new;
end;
$$;

revoke all on function fn_snapshot_walk_price() from public, anon, authenticated;

-- ── 3. Setting a price prices the walks already on the calendar ───────────
-- The materializer runs 14 days ahead, so the fortnight of walks that exist
-- when an operator first sets a visit price all carry a null snapshot — and
-- null falls back to nothing for a no-plan client, so every one of them
-- would refuse to bill for two weeks on exactly the adoption path H32 is
-- about. When a price is set, scheduled walks that were never priced take it.
--
-- This can only ever FILL a null, so it is pricing, not re-pricing:
--   * only walks with no snapshot — a price already agreed stands, so
--     editing the service price cannot rewrite anything;
--   * only status 'scheduled' — a walk in progress started under the terms
--     in force at the time, and a completed one is history;
--   * only walks whose CLIENT has no LIVE plan subscription. A live plan
--     client's un-snapshotted walk (a pre-0043 row) already charges
--     correctly through the live plan-rate fallback, and stamping a visit
--     price onto it would make the visit-price branch of the charge
--     resolution beat that fallback — a plan client billed the cash rate
--     under a "per-visit" label their Stripe mandate never mentioned
--     (caught in adversarial review). A client whose subscription is dead
--     (cancelled, or 'none' with a plan merely picked) IS stamped: the
--     visit price is the only rate their current mandate can name.
-- The no-API-role-UPDATE rule on the snapshot columns (0043) survives: the
-- only writers are still definer trigger functions.
--
-- Fires on ANY price-bearing edit, not just the NULL→value edge. Fill-only
-- makes re-firing harmless, and the wider trigger is the self-heal for a
-- narrow race: a walk INSERTed concurrently with the price edit can read the
-- pre-edit NULL in its snapshot trigger while being invisible to this
-- backfill's scan — priced by neither. The next price edit fills it; until
-- then the charge-time refusal names the Settings fix. Accepted and stated
-- rather than serialized away, because the fix would be locking
-- service_types in the INSERT path of every walk.
--
-- Lock order: the row locks are taken in id order via the FOR UPDATE
-- subselect, matching fn_purge_client's id-ordered walk locking (0042) so
-- two multi-row walk updaters cannot deadlock each other mid-scan. No
-- clients lock is ever taken here, so the 0037 walks→clients order is not
-- in play.
create function fn_price_unpriced_scheduled_walks() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update walks w
     set visit_price_pence = new.visit_price_pence
    from (
      select w2.id
        from walks w2
        join clients c on c.id = w2.client_id
       where w2.service_type_id = new.id
         and w2.status = 'scheduled'
         and w2.visit_price_pence is null
         and not (c.plan_id is not null
                  and c.subscription_status in ('active', 'paused', 'past_due'))
       order by w2.id
         for update of w2
    ) t
   where w.id = t.id;
  return new;
end;
$$;

revoke all on function fn_price_unpriced_scheduled_walks() from public, anon, authenticated;

create trigger trg_service_types_visit_price
  after update of visit_price_pence on service_types
  for each row
  when (new.visit_price_pence is not null
        and new.visit_price_pence is distinct from old.visit_price_pence)
  execute function fn_price_unpriced_scheduled_walks();

-- ── 4. The top-up: payment row + grant, one transaction, one key ──────────
-- The fn_apply_invoice_paid shape (0013/0026): the stripe_events claim
-- ledger is at-least-once — a crashed handler's retry takes over the lease —
-- so the money effect needs its own idempotency, keyed on the Stripe object
-- that paid. A payment-mode Checkout Session has no invoice; the
-- PaymentIntent is that object.
--
-- The caller (stripe-webhook) applies a top-up only for a session whose
-- payment_status is 'paid' — checkout.session.completed also fires with
-- 'unpaid' for delayed-notification methods (ACH), where the money arrives
-- or fails days later via checkout.session.async_payment_succeeded/failed.
-- Granting on completion alone would hand out credits for money never
-- received (caught in adversarial review).
--
-- The PI id is stamped on BOTH payments.stripe_invoice_id and (through
-- fn_grant_cycle_credits) credit_ledger.stripe_invoice_id. That column is
-- the grant↔money trace fn_reverse_payment claws back through (0023), and
-- 'invoice' in its name is historical: it holds the id of the Stripe object
-- that bought the credits — in_… for cycles, pi_… for top-ups. The two
-- namespaces cannot collide, and uq_payments_subscription_invoice filters
-- type='subscription' so a top-up row never enters its uniqueness set. This
-- is what makes a dashboard refund of a top-up reverse the credits with no
-- change to fn_reverse_payment: findPaymentForReversal matches the PI id,
-- and the ledger trace matches the payment's stripe_invoice_id.
create function fn_apply_topup(
  p_client uuid,
  p_credits int,
  p_payment_intent_id text,
  p_amount_pence int
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operator uuid;
begin
  if not fn_is_service_session() then
    raise exception 'fn_apply_topup: service role required';
  end if;
  if p_payment_intent_id is null or length(p_payment_intent_id) = 0 then
    raise exception 'fn_apply_topup: payment intent id required';
  end if;
  if p_credits is null or p_credits <= 0 then
    raise exception 'fn_apply_topup: credits must be positive';
  end if;
  -- A zero-amount 'succeeded' payment is unrefundable by construction:
  -- fn_reverse_payment refuses any reversal exceeding amount_pence, so a
  -- charge.refunded for such a row would 500 on every redelivery for three
  -- days while the client kept the credits. No session create-checkout
  -- mints can produce one; refusing here keeps the invariant even for an
  -- event shape outside that contract.
  if p_amount_pence is null or p_amount_pence <= 0 then
    raise exception 'fn_apply_topup: amount must be positive';
  end if;

  select operator_id into v_operator
    from clients where id = p_client for update;
  if not found then
    raise exception 'fn_apply_topup: unknown client %', p_client;
  end if;

  -- Same set as uq_topup_payment_per_intent below. 'refunded'/'disputed'
  -- are in it because Stripe redelivers checkout.session.completed for up
  -- to three days, and a redelivery after a refund must not grant a second
  -- batch of credits — the 0023 double-grant hole, avoided rather than
  -- re-fixed. 'failed' is absent: no failed top-up row exists to conflict
  -- with, and excluding it costs nothing if one ever does.
  if exists (
    select 1 from payments
     where stripe_payment_intent_id = p_payment_intent_id
       and type = 'topup'
       and status in ('succeeded', 'refunded', 'disputed')
  ) then
    return false;
  end if;

  insert into payments (operator_id, client_id, type, amount_pence, currency,
                        status, stripe_payment_intent_id, stripe_invoice_id)
  values (v_operator, p_client, 'topup', p_amount_pence, 'USD',
          'succeeded', p_payment_intent_id, p_payment_intent_id);

  perform fn_grant_cycle_credits(
    p_client, p_credits,
    format('top-up %s credits (%s)', p_credits, p_payment_intent_id),
    p_payment_intent_id);

  return true;
end;
$$;

revoke all on function fn_apply_topup(uuid, int, text, int)
  from public, anon, authenticated;
grant execute on function fn_apply_topup(uuid, int, text, int) to service_role;

-- The index half of the idempotency above. Filtered exactly like its two
-- siblings (0023): the reversal statuses are IN the set so a refunded row
-- keeps holding its uniqueness slot.
create unique index uq_topup_payment_per_intent
  on payments (stripe_payment_intent_id)
  where type = 'topup' and status in ('succeeded', 'refunded', 'disputed');

-- ── 5. Refuse if it did not take ──────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_trigger
     where tgname = 'trg_service_types_visit_price' and not tgisinternal
  ) then
    raise exception '0044: setting a visit price does not price queued walks — refusing';
  end if;

  if not exists (
    select 1 from pg_indexes
     where indexname = 'uq_topup_payment_per_intent'
  ) then
    raise exception '0044: top-up idempotency index missing — refusing';
  end if;

  -- The snapshot rule (0043): no API role may rewrite an agreed price.
  if exists (
    select 1 from information_schema.column_privileges
     where table_name = 'walks'
       and column_name = 'visit_price_pence'
       and grantee in ('authenticated', 'anon')
       and privilege_type = 'UPDATE'
  ) then
    raise exception '0044: an API role can rewrite a walk''s visit-price snapshot — refusing';
  end if;

  if has_function_privilege('authenticated',
       'fn_apply_topup(uuid, int, text, int)', 'execute') then
    raise exception '0044: fn_apply_topup is callable by an API role — refusing';
  end if;
end;
$$;
