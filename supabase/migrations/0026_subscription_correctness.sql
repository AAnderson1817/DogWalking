-- 0026 — a cancelled or past-due subscription must not generate billable work
--        (review H9, H10; owner decision: halt service until paid)
--
-- Three defects, all silent, all money:
--
-- 1. fn_materialize_walks consults exactly ONE subscription predicate,
--    `subscription_status <> 'paused'` (0013:131). A client who cancelled, or
--    whose card failed, keeps having walks generated nightly — work the
--    operator performs and cannot bill.
--
-- 2. fn_book_walk never consults subscription_status at all (0019:57-58): it
--    gates on `status = 'active'`, which is the CLIENT lifecycle column, not
--    the billing one. A cancelled client can self-book from the portal, and
--    the UI does not compensate — Booking.tsx gates on credit_balance only.
--
-- 3. fn_apply_invoice_paid runs fn_apply_rollover unconditionally (0023:333),
--    so the FIRST invoice of a subscription applies rollover before its first
--    grant. On rollover_policy 'none' that inserts a negative ledger row for
--    the whole balance (0003:271-274), destroying any credit the operator
--    granted before billing started. #33 rewrote this function and did not
--    close it.
--
-- The owner's decision on past_due is HALT: stop materializing and refuse new
-- bookings until payment clears. The alternative — keep serving and warn — was
-- considered and rejected. Already-scheduled walks are untouched either way;
-- this only stops NEW work being created.


-- ── 1. The materializer stops at cancelled and past_due ──────────────────
-- Body copied verbatim from 0013:99-153; the only change is the subscription
-- predicate. Everything the three prior definitions earned stays: origin_date
-- anti-resurrection (0012/0013), the per-operator-timezone horizon, the
-- pause-window skip, and ON CONFLICT idempotency.
create or replace function fn_materialize_walks(p_horizon_days int default 14)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_created int;
begin
  if not fn_is_service_session() then
    raise exception 'fn_materialize_walks: service role required';
  end if;
  if p_horizon_days is null or p_horizon_days < 1 or p_horizon_days > 60 then
    raise exception 'fn_materialize_walks: horizon must be 1..60 days';
  end if;

  insert into walks (operator_id, client_id, property_id, service_type_id,
                     schedule_id, scheduled_date, origin_date,
                     window_start, window_end, status)
  select rs.operator_id, rs.client_id, rs.property_id, rs.service_type_id,
         rs.id, d.day, d.day, rs.window_start, rs.window_end, 'scheduled'
    from recurring_schedules rs
    join clients c on c.id = rs.client_id
    join operators o on o.id = rs.operator_id
    cross join lateral (
      select ((now() at time zone coalesce(o.timezone, 'America/Chicago'))::date
              + offs)::date as day
        from generate_series(0, p_horizon_days - 1) as offs
    ) d
   where rs.active
     and c.status <> 'paused'
     and c.status <> 'archived'
     -- Was `<> 'paused'`. An allow-list rather than a deny-list, so a value
     -- added to subscription_status later fails CLOSED — it stops generating
     -- work until somebody decides what it means, rather than silently
     -- generating unbillable walks.
     and c.subscription_status in ('active', 'none')
     and extract(isodow from d.day)::int = any (rs.days_of_week)
     and d.day >= rs.start_date
     and (rs.end_date is null or d.day <= rs.end_date)
     and not (rs.paused_from is not null
              and d.day >= rs.paused_from
              and (rs.paused_until is null or d.day <= rs.paused_until))
  on conflict (schedule_id, origin_date) where schedule_id is not null
  do nothing;

  get diagnostics v_created = row_count;

  insert into walk_pets (walk_id, pet_id, operator_id)
  select w.id, sp.pet_id, w.operator_id
    from walks w
    join schedule_pets sp on sp.schedule_id = w.schedule_id
   where w.schedule_id is not null
     and w.status = 'scheduled'
  on conflict do nothing;

  return v_created;
end;
$$;

-- 'none' is deliberately allowed. It is the state of a client who has never
-- subscribed — the operator may be billing them outside Sanpo, and the
-- credit engine handles a zero balance as overage. Excluding it would break
-- every pre-subscription client the moment this migration applied.


-- ── 2. Client self-booking stops at cancelled and past_due ───────────────
-- Body copied verbatim from 0019:39-93; the only change is the client gate.
-- 0019 exists because this function referenced a column that never existed,
-- so it is worth restating: `status` is the client lifecycle (invited/active/
-- paused/archived) and `subscription_status` is billing. They are different
-- columns and this function only ever read the first.
create or replace function fn_book_walk(
  p_property uuid,
  p_service uuid,
  p_date date,
  p_window_start time,
  p_window_end time,
  p_pet_ids uuid[]
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client uuid;
  v_operator uuid;
  v_walk uuid;
  v_pet uuid;
  v_sub subscription_status;
begin
  select id, operator_id, subscription_status
    into v_client, v_operator, v_sub
    from clients where auth_user_id = auth.uid() and status = 'active';
  if not found then
    raise exception 'fn_book_walk: caller is not an active client';
  end if;
  -- Same allow-list as the materializer, and the message names the state so
  -- the portal can say something true rather than "booking failed".
  if v_sub not in ('active', 'none') then
    raise exception 'fn_book_walk: subscription is % — booking is closed until it is settled', v_sub;
  end if;
  if p_date is null or p_date < (now() at time zone 'America/Chicago')::date then
    raise exception 'fn_book_walk: date must be today or later';
  end if;
  if p_pet_ids is null or array_length(p_pet_ids, 1) is null then
    raise exception 'fn_book_walk: at least one pet required';
  end if;
  if not exists (select 1 from properties
                  where id = p_property and client_id = v_client) then
    raise exception 'fn_book_walk: property does not belong to caller';
  end if;
  if not exists (select 1 from service_types
                  where id = p_service and operator_id = v_operator) then
    raise exception 'fn_book_walk: unknown service';
  end if;

  insert into walks (operator_id, client_id, property_id, service_type_id,
                     scheduled_date, window_start, window_end, status)
  values (v_operator, v_client, p_property, p_service,
          p_date, p_window_start, p_window_end, 'scheduled')
  returning id into v_walk;

  foreach v_pet in array p_pet_ids loop
    if not exists (select 1 from pets where id = v_pet and client_id = v_client) then
      raise exception 'fn_book_walk: pet does not belong to caller';
    end if;
    insert into walk_pets (walk_id, pet_id, operator_id)
    values (v_walk, v_pet, v_operator);
  end loop;

  return v_walk;
end;
$$;


-- ── 3. Rollover runs on renewals, never on the first invoice ─────────────
-- Body copied from 0023:305-341 with one parameter added and one branch. The
-- signature CHANGES, so this is a new function rather than a replace; the old
-- six-argument version is dropped after, and the webhook is updated in the
-- same PR.
--
-- Rollover means "carry what is left of the cycle that just ended". There is
-- no prior cycle on subscription_create, so running it there is not a policy
-- choice, it is a bug: on 'none' it books an expiry for the entire balance
-- before the first grant lands.
create or replace function fn_apply_invoice_paid(
  p_client uuid,
  p_credits int,
  p_invoice_id text,
  p_amount_pence int,
  p_currency text,
  p_receipt_url text,
  p_is_renewal boolean
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

  -- Renewals only. A first invoice has no prior cycle to carry or expire.
  if p_is_renewal then
    perform fn_apply_rollover(p_client);
  end if;
  perform fn_grant_cycle_credits(p_client, p_credits,
                                 format('cycle grant %s', p_invoice_id), p_invoice_id);

  return true;
end;
$$;

revoke all on function fn_apply_invoice_paid(uuid, int, text, int, text, text, boolean)
  from public, anon, authenticated;
grant execute on function fn_apply_invoice_paid(uuid, int, text, int, text, text, boolean)
  to service_role;

-- Dropped rather than left as an overload. Two functions differing only by a
-- trailing boolean is precisely the shape a caller gets wrong, and the
-- six-argument one is the version that destroys credits.
drop function if exists fn_apply_invoice_paid(uuid, int, text, int, text, text);


-- ── 4. An overage rate of zero is not a plan ─────────────────────────────
-- create-plan and the Settings screen (#35) both accept any integer >= 0, and
-- 0 falls through to paymentIntents.create with amount 0, which Stripe
-- rejects at the moment of charging — after the walk is done.
--
-- Owner decision: every plan must state what an extra walk costs. NOT floored
-- at Stripe's minimum charge; a rate below it is still accepted here and will
-- still be refused by Stripe.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'plans_overage_rate_positive') then
    -- Existing rows first: a zero-rate plan already in the table would make
    -- the ALTER fail, and failing a deploy over historical data is worse than
    -- reporting it. There are none in any environment today (production has
    -- never run), so this is a guard rather than a migration step.
    if exists (select 1 from plans where overage_rate_pence <= 0) then
      raise exception 'plans with overage_rate_pence <= 0 exist; set a rate before applying 0026';
    end if;
    alter table plans add constraint plans_overage_rate_positive
      check (overage_rate_pence > 0);
  end if;
end $$;
