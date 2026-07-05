-- 0004 — security model (spec 03)
-- RLS enabled + FORCED everywhere; explicit grants per the spec 03 matrix
-- (no reliance on platform default privileges); column privileges done the
-- only way Postgres supports them — table-level REVOKE + column-list GRANT;
-- guard triggers enforce the client persona's partial-column updates, since
-- both personas share the `authenticated` role and column grants alone
-- cannot tell them apart.

-- ── helper predicates (STABLE, SECURITY DEFINER: avoid RLS recursion) ────
create function is_operator() returns boolean
language sql stable
security definer
set search_path = public
as $$
  select exists (select 1 from operators where id = auth.uid())
$$;

create function my_client_id() returns uuid
language sql stable
security definer
set search_path = public
as $$
  select id from clients where auth_user_id = auth.uid()
$$;

-- ── operator identity for clients (spec 03 matrix, operators row) ────────
-- Owner (postgres) bypasses RLS; the WHERE scopes rows to the caller's own
-- operator (their own row, or the operator of the client they belong to).
create view v_my_operator as
  select o.id, o.display_name, o.business_name
    from operators o
   where o.id = auth.uid()
      or o.id = (select operator_id from clients where auth_user_id = auth.uid());

-- ── RLS enable + force, baseline revoke ──────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array[
    'operators','plans','clients','properties','access_credentials',
    'credential_access_log','pets','service_types','recurring_schedules',
    'schedule_pets','walks','walk_pets','walk_gps_points','walk_photos',
    'credit_ledger','payments','notifications','stripe_events'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('revoke all on table %I from public, anon, authenticated', t);
    execute format('grant all on table %I to service_role', t);
  end loop;
end
$$;

revoke all on v_my_operator from public, anon, authenticated;
grant select on v_my_operator to authenticated, service_role;

-- ── operators ────────────────────────────────────────────────────────────
-- Matrix: operator select/update own row. INSERT of own row added for the
-- Onboard flow (spec 06 first-run creates the operators row).
create policy operators_self_select on operators
  for select to authenticated using (id = auth.uid());
create policy operators_self_insert on operators
  for insert to authenticated with check (id = auth.uid());
create policy operators_self_update on operators
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

grant select, insert on operators to authenticated;
grant update (business_name, display_name, email, phone, timezone, currency, low_credit_threshold)
  on operators to authenticated;

-- ── clients ──────────────────────────────────────────────────────────────
create policy clients_operator_all on clients
  for all to authenticated
  using (operator_id = auth.uid()) with check (operator_id = auth.uid());
create policy clients_self_select on clients
  for select to authenticated using (auth_user_id = auth.uid());
create policy clients_self_update on clients
  for update to authenticated
  using (auth_user_id = auth.uid()) with check (auth_user_id = auth.uid());

grant select, delete on clients to authenticated;
-- Insert cannot name the protected columns at all: balance/plan/subscription
-- fields are unforgeable from any authenticated JWT (invariant 1).
grant insert (operator_id, full_name, email, phone, status, notes)
  on clients to authenticated;
grant update (full_name, email, phone, status, notes)
  on clients to authenticated;

-- Client persona may update contact fields only (guard trigger; the column
-- grant above is the union of both personas' needs).
create function fn_guard_clients_update() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if fn_is_service_session() or auth.uid() = old.operator_id then
    return new;
  end if;
  if auth.uid() = old.auth_user_id then
    if new.status is distinct from old.status
       or new.notes is distinct from old.notes then
      raise exception 'clients: this persona may update contact fields only';
    end if;
    return new;
  end if;
  return new;
end;
$$;

create trigger trg_clients_guard_update
  before update on clients
  for each row execute function fn_guard_clients_update();

-- ── properties ───────────────────────────────────────────────────────────
create policy properties_operator_all on properties
  for all to authenticated
  using (operator_id = auth.uid()) with check (operator_id = auth.uid());
create policy properties_client_select on properties
  for select to authenticated using (client_id = my_client_id());
create policy properties_client_update on properties
  for update to authenticated
  using (client_id = my_client_id()) with check (client_id = my_client_id());

grant select, insert, delete on properties to authenticated;
grant update (label, address_line1, address_line2, city, postcode,
              access_notes_public, lat, lng, client_id)
  on properties to authenticated;

-- Client persona: access_notes_public only (spec 03 matrix).
create function fn_guard_properties_update() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if fn_is_service_session() or auth.uid() = old.operator_id then
    return new;
  end if;
  if new.label is distinct from old.label
     or new.address_line1 is distinct from old.address_line1
     or new.address_line2 is distinct from old.address_line2
     or new.city is distinct from old.city
     or new.postcode is distinct from old.postcode
     or new.lat is distinct from old.lat
     or new.lng is distinct from old.lng
     or new.client_id is distinct from old.client_id then
    raise exception 'properties: this persona may update access_notes_public only';
  end if;
  return new;
end;
$$;

create trigger trg_properties_guard_update
  before update on properties
  for each row execute function fn_guard_properties_update();

-- ── access_credentials ───────────────────────────────────────────────────
-- Operator: metadata only — no select on ciphertext (invariant 2); update
-- grant excludes ciphertext so rotation flows only through the vault
-- (service role). Client persona: no policies ⇒ no access at all.
create policy access_credentials_operator_select on access_credentials
  for select to authenticated using (operator_id = auth.uid());
create policy access_credentials_operator_insert on access_credentials
  for insert to authenticated with check (operator_id = auth.uid());
create policy access_credentials_operator_update on access_credentials
  for update to authenticated
  using (operator_id = auth.uid()) with check (operator_id = auth.uid());
create policy access_credentials_operator_delete on access_credentials
  for delete to authenticated using (operator_id = auth.uid());

grant select (id, operator_id, property_id, entry_method, label,
              key_location_hint, rotated_at, revoked_at, created_at, updated_at)
  on access_credentials to authenticated;
grant insert on access_credentials to authenticated;
grant update (entry_method, label, key_location_hint, rotated_at, revoked_at)
  on access_credentials to authenticated;
grant delete on access_credentials to authenticated;

-- ── credential_access_log ────────────────────────────────────────────────
-- Append-only via fn_read_credential; operators read their own trail.
create policy credential_access_log_operator_select on credential_access_log
  for select to authenticated using (operator_id = auth.uid());

grant select on credential_access_log to authenticated;

-- ── pets ─────────────────────────────────────────────────────────────────
create policy pets_operator_all on pets
  for all to authenticated
  using (operator_id = auth.uid()) with check (operator_id = auth.uid());
create policy pets_client_select on pets
  for select to authenticated using (client_id = my_client_id());
create policy pets_client_update on pets
  for update to authenticated
  using (client_id = my_client_id()) with check (client_id = my_client_id());

grant select, insert, delete on pets to authenticated;
grant update (name, breed, size, temperament, medical_notes, feeding_notes,
              medication_notes, vet_name, vet_phone, is_reactive,
              is_escape_risk, photo_path, active, client_id)
  on pets to authenticated;

-- Client persona: care fields only (temperament, feeding, medical,
-- medication, vet, photo — spec 03 matrix).
create function fn_guard_pets_update() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if fn_is_service_session() or auth.uid() = old.operator_id then
    return new;
  end if;
  if new.name is distinct from old.name
     or new.breed is distinct from old.breed
     or new.size is distinct from old.size
     or new.is_reactive is distinct from old.is_reactive
     or new.is_escape_risk is distinct from old.is_escape_risk
     or new.active is distinct from old.active
     or new.client_id is distinct from old.client_id then
    raise exception 'pets: this persona may update care fields only';
  end if;
  return new;
end;
$$;

create trigger trg_pets_guard_update
  before update on pets
  for each row execute function fn_guard_pets_update();

-- ── service_types ────────────────────────────────────────────────────────
create policy service_types_operator_all on service_types
  for all to authenticated
  using (operator_id = auth.uid()) with check (operator_id = auth.uid());
create policy service_types_client_select on service_types
  for select to authenticated
  using (operator_id = (select operator_id from clients where id = my_client_id()));

grant select, insert, update, delete on service_types to authenticated;

-- ── plans ────────────────────────────────────────────────────────────────
create policy plans_operator_all on plans
  for all to authenticated
  using (operator_id = auth.uid()) with check (operator_id = auth.uid());
create policy plans_client_select_own on plans
  for select to authenticated
  using (id = (select plan_id from clients where id = my_client_id()));

grant select, insert, update, delete on plans to authenticated;

-- ── recurring_schedules / schedule_pets ──────────────────────────────────
create policy recurring_schedules_operator_all on recurring_schedules
  for all to authenticated
  using (operator_id = auth.uid()) with check (operator_id = auth.uid());
create policy recurring_schedules_client_select on recurring_schedules
  for select to authenticated using (client_id = my_client_id());

grant select, insert, update, delete on recurring_schedules to authenticated;

create policy schedule_pets_operator_all on schedule_pets
  for all to authenticated
  using (operator_id = auth.uid()) with check (operator_id = auth.uid());
create policy schedule_pets_client_select on schedule_pets
  for select to authenticated
  using (exists (select 1 from recurring_schedules rs
                  where rs.id = schedule_id and rs.client_id = my_client_id()));

grant select, insert, update, delete on schedule_pets to authenticated;

-- ── walks / walk_pets ────────────────────────────────────────────────────
create policy walks_operator_all on walks
  for all to authenticated
  using (operator_id = auth.uid()) with check (operator_id = auth.uid());
create policy walks_client_select on walks
  for select to authenticated using (client_id = my_client_id());

grant select, delete on walks to authenticated;
-- credits_debited / is_overage are set only inside fn_debit_walk (spec 03):
-- they appear in no insert or update grant.
grant insert (operator_id, client_id, property_id, service_type_id, schedule_id,
              scheduled_date, window_start, window_end, status, started_at,
              ended_at, distance_m, notes, potty_pee, potty_poo, fed, watered,
              report_sent_at)
  on walks to authenticated;
grant update (property_id, service_type_id, schedule_id, scheduled_date,
              window_start, window_end, status, started_at, ended_at,
              distance_m, notes, potty_pee, potty_poo, fed, watered,
              report_sent_at)
  on walks to authenticated;

create policy walk_pets_operator_all on walk_pets
  for all to authenticated
  using (operator_id = auth.uid()) with check (operator_id = auth.uid());
create policy walk_pets_client_select on walk_pets
  for select to authenticated
  using (exists (select 1 from walks w
                  where w.id = walk_id and w.client_id = my_client_id()));

grant select, insert, update, delete on walk_pets to authenticated;

-- ── walk_gps_points ──────────────────────────────────────────────────────
create policy walk_gps_points_operator_select on walk_gps_points
  for select to authenticated using (operator_id = auth.uid());
create policy walk_gps_points_operator_insert on walk_gps_points
  for insert to authenticated
  with check (operator_id = auth.uid()
              and exists (select 1 from walks w
                           where w.id = walk_id and w.operator_id = auth.uid()));
create policy walk_gps_points_client_select on walk_gps_points
  for select to authenticated
  using (exists (select 1 from walks w
                  where w.id = walk_id and w.client_id = my_client_id()));

grant select, insert on walk_gps_points to authenticated;

-- ── walk_photos ──────────────────────────────────────────────────────────
create policy walk_photos_operator_select on walk_photos
  for select to authenticated using (operator_id = auth.uid());
create policy walk_photos_operator_insert on walk_photos
  for insert to authenticated with check (operator_id = auth.uid());
create policy walk_photos_operator_delete on walk_photos
  for delete to authenticated using (operator_id = auth.uid());
create policy walk_photos_client_select on walk_photos
  for select to authenticated
  using (exists (select 1 from walks w
                  where w.id = walk_id and w.client_id = my_client_id()));

grant select, insert, delete on walk_photos to authenticated;

-- ── credit_ledger ────────────────────────────────────────────────────────
-- SELECT only; sole write path = credit-engine definer functions.
create policy credit_ledger_operator_select on credit_ledger
  for select to authenticated using (operator_id = auth.uid());
create policy credit_ledger_client_select on credit_ledger
  for select to authenticated using (client_id = my_client_id());

grant select on credit_ledger to authenticated;

-- ── payments ─────────────────────────────────────────────────────────────
create policy payments_operator_select on payments
  for select to authenticated using (operator_id = auth.uid());
create policy payments_client_select on payments
  for select to authenticated using (client_id = my_client_id());

grant select on payments to authenticated;

-- ── notifications ────────────────────────────────────────────────────────
-- client_id null ⇒ operator-facing. Each persona reads its own rows and may
-- flip read_at only (column grant).
create policy notifications_operator_select on notifications
  for select to authenticated
  using (operator_id = auth.uid() and client_id is null);
create policy notifications_operator_update on notifications
  for update to authenticated
  using (operator_id = auth.uid() and client_id is null)
  with check (operator_id = auth.uid() and client_id is null);
create policy notifications_client_select on notifications
  for select to authenticated using (client_id = my_client_id());
create policy notifications_client_update on notifications
  for update to authenticated
  using (client_id = my_client_id()) with check (client_id = my_client_id());

grant select on notifications to authenticated;
grant update (read_at) on notifications to authenticated;

-- ── stripe_events ────────────────────────────────────────────────────────
-- Service role only: no policies, no grants beyond the baseline block.

-- ── function privilege catalog (spec 03) ─────────────────────────────────
-- service_role only:
revoke all on function fn_grant_credits(uuid, int, text) from public, anon, authenticated;
revoke all on function fn_apply_rollover(uuid) from public, anon, authenticated;
revoke all on function fn_change_plan(uuid, uuid, numeric) from public, anon, authenticated;
revoke all on function fn_expire_credits() from public, anon, authenticated;
revoke all on function fn_debit_walk(uuid) from public, anon, authenticated;
revoke all on function fn_read_credential(uuid, text, uuid) from public, anon, authenticated;
revoke all on function fn_notify_low_credit(uuid) from public, anon, authenticated;
grant execute on function fn_grant_credits(uuid, int, text) to service_role;
grant execute on function fn_apply_rollover(uuid) to service_role;
grant execute on function fn_change_plan(uuid, uuid, numeric) to service_role;
grant execute on function fn_expire_credits() to service_role;
grant execute on function fn_debit_walk(uuid) to service_role;
grant execute on function fn_read_credential(uuid, text, uuid) to service_role;
grant execute on function fn_notify_low_credit(uuid) to service_role;

-- authenticated (bodies re-verify tenancy):
revoke all on function fn_adjust_credits(uuid, int, text) from public, anon;
revoke all on function fn_walk_cost(uuid) from public, anon;
revoke all on function fn_claim_invite(uuid) from public, anon;
revoke all on function is_operator() from public, anon;
revoke all on function my_client_id() from public, anon;
revoke all on function fn_is_service_session() from public, anon;
grant execute on function fn_adjust_credits(uuid, int, text) to authenticated, service_role;
grant execute on function fn_walk_cost(uuid) to authenticated, service_role;
grant execute on function fn_claim_invite(uuid) to authenticated, service_role;
grant execute on function is_operator() to authenticated, service_role;
grant execute on function my_client_id() to authenticated, service_role;
grant execute on function fn_is_service_session() to authenticated, service_role;

-- internal trigger/guard machinery: callable by no API role.
revoke all on function fn_touch_updated_at() from public, anon, authenticated;
revoke all on function fn_seed_operator_defaults() from public, anon, authenticated;
revoke all on function fn_ledger_apply() from public, anon, authenticated;
revoke all on function fn_ledger_block_mutation() from public, anon, authenticated;
revoke all on function fn_guard_clients_update() from public, anon, authenticated;
revoke all on function fn_guard_properties_update() from public, anon, authenticated;
revoke all on function fn_guard_pets_update() from public, anon, authenticated;

-- ── storage: scope object access by first path segment = operator_id ─────
create policy storage_operator_insert on storage.objects
  for insert to authenticated
  with check (bucket_id in ('pet-photos', 'walk-photos')
              and (storage.foldername(name))[1] = auth.uid()::text);
create policy storage_operator_select on storage.objects
  for select to authenticated
  using (bucket_id in ('pet-photos', 'walk-photos')
         and (storage.foldername(name))[1] = auth.uid()::text);
create policy storage_operator_update on storage.objects
  for update to authenticated
  using (bucket_id in ('pet-photos', 'walk-photos')
         and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id in ('pet-photos', 'walk-photos')
              and (storage.foldername(name))[1] = auth.uid()::text);
create policy storage_operator_delete on storage.objects
  for delete to authenticated
  using (bucket_id in ('pet-photos', 'walk-photos')
         and (storage.foldername(name))[1] = auth.uid()::text);
