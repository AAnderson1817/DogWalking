-- 0013 — re-review fixes (append-only). Closes the holes the adversarial
-- re-review of 0010..0012 found: origin_date NULL escape, pause-cancel
-- asymmetry + UTC anchoring, non-idempotent invoice effects, stripe_events
-- delete-on-failure race, unrefunded debits on cancelled walks, photo
-- replay idempotency, non-atomic client booking, 24h notification copy.

-- ── 1. origin_date can never be NULL on schedule-linked walks ─────────────
-- NULLs are distinct in unique indexes, so a schedule walk without
-- origin_date escaped uq_walks_schedule_origin entirely and the materializer
-- duplicated its slot (the 0012 bug through a different door: seed data or
-- direct PostgREST inserts).
update walks set origin_date = scheduled_date
 where schedule_id is not null and origin_date is null;

create or replace function fn_default_walk_origin()
returns trigger
language plpgsql
as $$
begin
  if new.schedule_id is not null and new.origin_date is null then
    new.origin_date := new.scheduled_date;
  end if;
  return new;
end;
$$;

create trigger trg_walks_default_origin
  before insert or update of schedule_id on walks
  for each row execute function fn_default_walk_origin();

alter table walks add constraint chk_walks_origin
  check (schedule_id is null or origin_date is not null);

-- One-time cleanup: any residual duplicate live schedule walks on the same
-- date (from the pre-0012 resurrection bug, or a pre-0012 reschedule whose
-- vacated slot regenerated once before this migration) — keep the earliest.
update walks set status = 'cancelled'
 where id in (
   select id from (
     select id, row_number() over (
       partition by schedule_id, scheduled_date order by created_at) as rn
       from walks
      where schedule_id is not null
        and status = 'scheduled'
        and scheduled_date >= current_date
   ) d where d.rn > 1
 );

-- ── 2. Pause windows: operator wall-clock + symmetric restore ─────────────
-- 0012's trigger anchored at UTC current_date (evening-Central pauses missed
-- same-day walks) and cancelled walks could never come back when the pause
-- was cleared/shortened. Tag auto-cancellations and restore them when they
-- fall outside the new window.
alter table walks add column if not exists cancel_reason text;

create or replace function fn_cancel_paused_walks()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date;
begin
  select (now() at time zone coalesce(o.timezone, 'America/Chicago'))::date
    into v_today
    from operators o where o.id = new.operator_id;

  -- Cancel future scheduled walks inside the (new) pause window.
  if new.paused_from is not null then
    update walks
       set status = 'cancelled', cancel_reason = 'schedule_pause'
     where schedule_id = new.id
       and status = 'scheduled'
       and scheduled_date >= greatest(new.paused_from, v_today)
       and (new.paused_until is null or scheduled_date <= new.paused_until);
  end if;

  -- Restore our own auto-cancellations that no longer fall inside the window
  -- (pause cleared, shortened, or shifted).
  update walks
     set status = 'scheduled', cancel_reason = null
   where schedule_id = new.id
     and status = 'cancelled'
     and cancel_reason = 'schedule_pause'
     and scheduled_date >= v_today
     and (new.paused_from is null
          or scheduled_date < new.paused_from
          or (new.paused_until is not null and scheduled_date > new.paused_until));

  return new;
end;
$$;
-- (CREATE OR REPLACE rebinds the existing trg_schedule_pause_cancels.)

-- ── 3. Materializer horizon anchored to the operator's business day ───────
-- current_date is UTC; from ~18:00 Central onward that is already tomorrow,
-- so evening runs could never materialize the current Central day.
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
     and c.subscription_status <> 'paused'
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

revoke all on function fn_materialize_walks(int) from public, anon, authenticated;
grant execute on function fn_materialize_walks(int) to service_role;

-- ── 4. stripe_events becomes a stateful claim ledger ──────────────────────
-- 0012-era code DELETEd the claim on failure; a concurrent duplicate
-- delivery acked 200 while the claimant failed → event lost with no retry
-- coming, and a failed DELETE (same outage as the failing effect) silently
-- reintroduced the drop. A status column makes claims re-processable
-- without ever deleting, and duplicates of an unfinished claim are NOT
-- acked.
alter table stripe_events
  add column if not exists status text not null default 'processed',
  add column if not exists claimed_at timestamptz not null default now();

alter table stripe_events
  add constraint chk_stripe_events_status check (status in ('processing', 'processed'));

-- ── 5. Atomic, idempotent invoice.paid effects ────────────────────────────
-- rollover + grant + payment insert in ONE transaction, keyed on the Stripe
-- invoice id: a webhook retry after a partial failure either replays into a
-- clean no-op or commits everything at once — never a double grant.
create unique index if not exists uq_payments_subscription_invoice
  on payments (stripe_invoice_id)
  where stripe_invoice_id is not null and type = 'subscription' and status = 'succeeded';

create function fn_apply_invoice_paid(
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

  -- Per-client serialization (same lock discipline as the other credit fns).
  select operator_id into v_operator
    from clients where id = p_client for update;
  if not found then
    raise exception 'fn_apply_invoice_paid: unknown client %', p_client;
  end if;

  -- Idempotency: the payment row claims the invoice id under the partial
  -- unique index; a replay (or concurrent duplicate — the index makes the
  -- loser roll back atomically) is a no-op.
  if exists (
    select 1 from payments
     where stripe_invoice_id = p_invoice_id
       and type = 'subscription' and status = 'succeeded'
  ) then
    return false;
  end if;

  insert into payments (operator_id, client_id, type, amount_pence, currency,
                        status, stripe_invoice_id, receipt_url)
  values (v_operator, p_client, 'subscription', coalesce(p_amount_pence, 0),
          upper(coalesce(p_currency, 'USD')), 'succeeded', p_invoice_id, p_receipt_url);

  -- Cycle boundary: rollover BEFORE the new cycle's grant (spec 02).
  perform fn_apply_rollover(p_client);
  perform fn_grant_credits(p_client, p_credits, format('cycle grant %s', p_invoice_id));

  return true;
end;
$$;

revoke all on function fn_apply_invoice_paid(uuid, int, text, int, text, text)
  from public, anon, authenticated;
grant execute on function fn_apply_invoice_paid(uuid, int, text, int, text, text)
  to service_role;

-- ── 6. Cancelling a billed walk refunds the debit ─────────────────────────
-- The bill-before-complete reorder created a state that couldn't previously
-- exist: in_progress with credits_debited > 0. If such a walk is cancelled /
-- no-showed instead of re-completed, the client must get the credit back.
create function fn_refund_cancelled_debit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('cancelled', 'no_show')
     and old.status not in ('cancelled', 'no_show')
     and old.credits_debited > 0
     and not exists (
       select 1 from credit_ledger
        where walk_id = new.id and entry_type = 'adjust' and amount > 0
          and note = 'auto refund: walk cancelled after debit'
     )
  then
    -- Serialize with other balance mutations for this client.
    perform 1 from clients where id = new.client_id for update;
    insert into credit_ledger (operator_id, client_id, entry_type, amount, walk_id, note)
    values (new.operator_id, new.client_id, 'adjust', old.credits_debited,
            new.id, 'auto refund: walk cancelled after debit');
  end if;
  return new;
end;
$$;

create trigger trg_walks_refund_on_cancel
  before update of status on walks
  for each row execute function fn_refund_cancelled_debit();

-- ── 7. Photo replay idempotency ───────────────────────────────────────────
-- complete-walk's retry path backfills photos; the unique index makes the
-- backfill safe to repeat.
create unique index if not exists uq_walk_photos_path
  on walk_photos (walk_id, storage_path);

-- ── 8. Atomic client booking ──────────────────────────────────────────────
-- Booking was two REST writes (walks insert, then walk_pets) — a failure
-- between them left an orphan petless walk and a retry double-booked.
create function fn_book_walk(
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
begin
  select id, operator_id into v_client, v_operator
    from clients where auth_user_id = auth.uid() and status = 'active';
  if not found then
    raise exception 'fn_book_walk: caller is not an active client';
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
                  where id = p_service and operator_id = v_operator and active) then
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

revoke all on function fn_book_walk(uuid, uuid, date, time, time, uuid[])
  from public, anon;
grant execute on function fn_book_walk(uuid, uuid, date, time, time, uuid[])
  to authenticated;

-- ── 9. Notification bodies in US 12-hour style ────────────────────────────
-- fn_notify_walk_changes still rendered 'Mon 06 Jul, 14:00–15:00'.
create or replace function fn_notify_walk_changes() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_user uuid;
  v_client_name text;
  v_slot text;
begin
  select auth_user_id, full_name into v_client_user, v_client_name
    from clients where id = new.client_id;
  v_slot := format('%s, %s–%s',
    to_char(new.scheduled_date, 'Dy Mon FMDD'),
    trim(to_char(new.window_start, 'FMHH12:MI AM')),
    trim(to_char(new.window_end, 'FMHH12:MI AM')));

  if tg_op = 'INSERT' then
    if new.schedule_id is null and new.status = 'scheduled' then
      if auth.uid() is not null and auth.uid() = v_client_user then
        insert into notifications (operator_id, client_id, type, title, body, walk_id)
        values (new.operator_id, null, 'walk_scheduled',
                format('%s booked a walk', v_client_name), v_slot, new.id);
      else
        insert into notifications (operator_id, client_id, type, title, body, walk_id)
        values (new.operator_id, new.client_id, 'walk_scheduled',
                'New walk scheduled', v_slot, new.id);
      end if;
    end if;
    return new;
  end if;

  if old.status <> 'cancelled' and new.status = 'cancelled' then
    if auth.uid() is not null and auth.uid() = v_client_user then
      insert into notifications (operator_id, client_id, type, title, body, walk_id)
      values (new.operator_id, null, 'walk_cancelled',
              format('%s cancelled a walk', v_client_name), v_slot, new.id);
    else
      insert into notifications (operator_id, client_id, type, title, body, walk_id)
      values (new.operator_id, new.client_id, 'walk_cancelled',
              'Your walk was cancelled', format('%s — get in touch if this is unexpected.', v_slot), new.id);
    end if;
  end if;
  return new;
end;
$$;
