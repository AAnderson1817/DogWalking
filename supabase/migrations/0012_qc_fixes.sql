-- 0012 — QC-pass correctness + security fixes (append-only; supersedes
-- pieces of 0002/0004/0007/0008 without editing them).

-- ── 1. Materializer must not resurrect a rescheduled walk ────────────────
-- The idempotency key was (schedule_id, scheduled_date). Drag-rescheduling a
-- materialized walk changes scheduled_date, freeing the original slot, so the
-- nightly run re-created a walk on the origin date → duplicate + double bill.
-- Track the immutable generation date (origin_date) and key idempotency on
-- it; reschedule changes scheduled_date but never origin_date.
alter table walks add column if not exists origin_date date;

update walks set origin_date = scheduled_date
 where schedule_id is not null and origin_date is null;

-- The old (schedule_id, scheduled_date) unique index would also block a
-- legitimate reschedule onto a day that already holds a schedule walk. Drop
-- it in favour of the origin_date key.
drop index if exists uq_walks_schedule_date;

create unique index if not exists uq_walks_schedule_origin
  on walks (schedule_id, origin_date)
  where schedule_id is not null;

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
    cross join lateral (
      select (current_date + offs)::date as day
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

-- ── 2. Pausing a schedule cancels its already-materialized walks ─────────
-- The materializer skips generating walks in the pause window, but walks
-- materialized before the pause was set stayed live and billable during a
-- client's vacation. Cancel future scheduled walks that now fall inside the
-- window whenever the pause fields change.
create or replace function fn_cancel_paused_walks()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.paused_from is not null then
    update walks
       set status = 'cancelled'
     where schedule_id = new.id
       and status = 'scheduled'
       and scheduled_date >= greatest(new.paused_from, current_date)
       and (new.paused_until is null or scheduled_date <= new.paused_until);
  end if;
  return new;
end;
$$;

create trigger trg_schedule_pause_cancels
  after update of paused_from, paused_until on recurring_schedules
  for each row execute function fn_cancel_paused_walks();

-- ── 3. Overage: at most one live payment row per walk ────────────────────
-- Belt-and-suspenders behind the Stripe idempotency key: prevent two
-- concurrent completions from inserting two overage charges for one walk.
create unique index if not exists uq_overage_payment_per_walk
  on payments (walk_id)
  where type = 'overage' and status in ('succeeded', 'pending');

-- ── 4. Vault: authenticated may never write the ciphertext column ────────
-- Table-level INSERT let an operator POST plaintext straight into ciphertext
-- via PostgREST, bypassing the credential-vault edge function (invariant 2).
-- All legitimate writes go through that function as service_role, which
-- ignores column grants; authenticated keeps no INSERT path at all (ciphertext
-- is NOT NULL and now ungranted).
revoke insert on access_credentials from authenticated;
grant insert (operator_id, property_id, entry_method, label, key_location_hint)
  on access_credentials to authenticated;

-- ── 5. Client pet-photo upload must stay in the operator's folder ────────
-- The INSERT policy checked only the pet (2nd path segment), not the
-- operator_id (1st segment), allowing writes into another tenant's folder.
drop policy if exists storage_client_pet_photos_insert on storage.objects;
create policy storage_client_pet_photos_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'pet-photos'
    and exists (
      select 1 from pets p
       where p.id::text = (storage.foldername(name))[2]
         and p.client_id = my_client_id()
         and p.operator_id::text = (storage.foldername(name))[1]
    )
  );
