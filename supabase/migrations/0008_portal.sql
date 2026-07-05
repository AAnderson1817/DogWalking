-- 0008 — client portal & billing console support (phase 07)
-- Adds the cancellation cutoff (default 12 h) and a cached renewal date,
-- exposes the cutoff to clients via v_my_operator, and grants the client
-- persona exactly the booking surface the spec 07 flows need: insert own
-- scheduled walks (+pets), cancel own scheduled walks before the cutoff
-- (guard trigger), and read walk/pet photos for their own records.

-- ── columns ──────────────────────────────────────────────────────────────
alter table operators
  add column cancellation_cutoff_hours int not null default 12
    check (cancellation_cutoff_hours >= 0);

-- Cached from Stripe (customer.subscription.updated) for the billing
-- console's upcoming-renewals list. Never client-writable: it is absent
-- from every authenticated update grant.
alter table clients
  add column current_period_end timestamptz null;

grant update (cancellation_cutoff_hours) on operators to authenticated;

-- Expose the cutoff (and operator identity) to the client persona.
create or replace view v_my_operator as
  select o.id, o.display_name, o.business_name, o.cancellation_cutoff_hours
    from operators o
   where o.id = auth.uid()
      or o.id = (select operator_id from clients where auth_user_id = auth.uid());

-- ── client booking: insert own scheduled walks ───────────────────────────
create policy walks_client_insert on walks
  for insert to authenticated
  with check (
    client_id = my_client_id()
    and status = 'scheduled'
    and schedule_id is null
    and operator_id = (select operator_id from clients where id = my_client_id())
  );

create policy walk_pets_client_insert on walk_pets
  for insert to authenticated
  with check (
    exists (select 1 from walks w
             where w.id = walk_id and w.client_id = my_client_id())
    and exists (select 1 from pets p
                 where p.id = pet_id and p.client_id = my_client_id())
  );

-- ── client cancellation: own scheduled walks, before the cutoff ─────────
create policy walks_client_update on walks
  for update to authenticated
  using (client_id = my_client_id())
  with check (client_id = my_client_id());

-- Guard: the client persona may ONLY flip scheduled → cancelled, may touch
-- no other column, and only while now() is at least cutoff hours before the
-- walk's window start (operator wall-clock).
create function fn_guard_walks_client_update() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cutoff int;
  v_tz text;
  v_walk_start timestamptz;
begin
  if fn_is_service_session() or auth.uid() = old.operator_id then
    return new;
  end if;

  if not (old.status = 'scheduled' and new.status = 'cancelled') then
    raise exception 'walks: this persona may only cancel scheduled walks';
  end if;
  if new.scheduled_date is distinct from old.scheduled_date
     or new.window_start is distinct from old.window_start
     or new.window_end is distinct from old.window_end
     or new.property_id is distinct from old.property_id
     or new.service_type_id is distinct from old.service_type_id
     or new.schedule_id is distinct from old.schedule_id
     or new.started_at is distinct from old.started_at
     or new.ended_at is distinct from old.ended_at
     or new.distance_m is distinct from old.distance_m
     or new.notes is distinct from old.notes
     or new.potty_pee is distinct from old.potty_pee
     or new.potty_poo is distinct from old.potty_poo
     or new.fed is distinct from old.fed
     or new.watered is distinct from old.watered
     or new.report_sent_at is distinct from old.report_sent_at
     or new.client_id is distinct from old.client_id
     or new.operator_id is distinct from old.operator_id then
    raise exception 'walks: cancellation may not modify other fields';
  end if;

  select o.cancellation_cutoff_hours, o.timezone
    into v_cutoff, v_tz
    from operators o where o.id = old.operator_id;
  v_walk_start := (old.scheduled_date + old.window_start) at time zone coalesce(v_tz, 'Europe/London');
  if now() > v_walk_start - make_interval(hours => coalesce(v_cutoff, 12)) then
    raise exception 'walks: within % h of the walk — contact your walker to cancel', coalesce(v_cutoff, 12);
  end if;

  return new;
end;
$$;

create trigger trg_walks_guard_client_update
  before update on walks
  for each row execute function fn_guard_walks_client_update();

revoke all on function fn_guard_walks_client_update() from public, anon, authenticated;

-- ── storage: clients read photos belonging to their own records ─────────
-- Path convention {operator_id}/{entity_id}/{uuid}.jpg ⇒ second segment
-- identifies the walk / pet.
create policy storage_client_select_walk_photos on storage.objects
  for select to authenticated
  using (
    bucket_id = 'walk-photos'
    and exists (select 1 from walks w
                 where w.id::text = (storage.foldername(name))[2]
                   and w.client_id = my_client_id())
  );

create policy storage_client_pet_photos on storage.objects
  for select to authenticated
  using (
    bucket_id = 'pet-photos'
    and exists (select 1 from pets p
                 where p.id::text = (storage.foldername(name))[2]
                   and p.client_id = my_client_id())
  );

create policy storage_client_pet_photos_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'pet-photos'
    and exists (select 1 from pets p
                 where p.id::text = (storage.foldername(name))[2]
                   and p.client_id = my_client_id())
  );
