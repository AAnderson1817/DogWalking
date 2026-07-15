-- 0014 — tenant consistency guards.
-- Independent UUID foreign keys plus operator-scoped RLS are not sufficient:
-- an authenticated operator can know another tenant's UUID and create a row
-- with their own operator_id that points at the other tenant's client/property.
-- These SECURITY DEFINER guards make tenant ownership part of the write-time
-- invariant for every cross-row relationship that carries tenant data.

create function fn_assert_tenant_consistency()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client uuid;
  v_operator uuid;
begin
  if tg_table_name = 'clients' then
    if new.plan_id is not null and not exists (
      select 1 from plans p
       where p.id = new.plan_id and p.operator_id = new.operator_id
    ) then
      raise exception 'tenant consistency: client plan must belong to operator';
    end if;

  elsif tg_table_name = 'properties' then
    if not exists (
      select 1 from clients c
       where c.id = new.client_id and c.operator_id = new.operator_id
    ) then
      raise exception 'tenant consistency: property client must belong to operator';
    end if;

  elsif tg_table_name = 'pets' then
    if not exists (
      select 1 from clients c
       where c.id = new.client_id and c.operator_id = new.operator_id
    ) then
      raise exception 'tenant consistency: pet client must belong to operator';
    end if;

  elsif tg_table_name = 'access_credentials' then
    if not exists (
      select 1 from properties p
       where p.id = new.property_id and p.operator_id = new.operator_id
    ) then
      raise exception 'tenant consistency: credential property must belong to operator';
    end if;

  elsif tg_table_name = 'recurring_schedules' then
    if not exists (
      select 1 from clients c
       where c.id = new.client_id and c.operator_id = new.operator_id
    ) then
      raise exception 'tenant consistency: schedule client must belong to operator';
    end if;
    if not exists (
      select 1 from properties p
       where p.id = new.property_id
         and p.client_id = new.client_id
         and p.operator_id = new.operator_id
    ) then
      raise exception 'tenant consistency: schedule property must belong to client/operator';
    end if;
    if not exists (
      select 1 from service_types st
       where st.id = new.service_type_id and st.operator_id = new.operator_id
    ) then
      raise exception 'tenant consistency: schedule service must belong to operator';
    end if;

  elsif tg_table_name = 'schedule_pets' then
    select rs.client_id, rs.operator_id into v_client, v_operator
      from recurring_schedules rs where rs.id = new.schedule_id;
    if v_operator is null or v_operator <> new.operator_id then
      raise exception 'tenant consistency: schedule_pet schedule must belong to operator';
    end if;
    if not exists (
      select 1 from pets p
       where p.id = new.pet_id
         and p.client_id = v_client
         and p.operator_id = new.operator_id
    ) then
      raise exception 'tenant consistency: schedule_pet pet must belong to schedule client/operator';
    end if;

  elsif tg_table_name = 'walks' then
    if not exists (
      select 1 from clients c
       where c.id = new.client_id and c.operator_id = new.operator_id
    ) then
      raise exception 'tenant consistency: walk client must belong to operator';
    end if;
    if not exists (
      select 1 from properties p
       where p.id = new.property_id
         and p.client_id = new.client_id
         and p.operator_id = new.operator_id
    ) then
      raise exception 'tenant consistency: walk property must belong to client/operator';
    end if;
    if not exists (
      select 1 from service_types st
       where st.id = new.service_type_id and st.operator_id = new.operator_id
    ) then
      raise exception 'tenant consistency: walk service must belong to operator';
    end if;
    if new.schedule_id is not null and not exists (
      select 1 from recurring_schedules rs
       where rs.id = new.schedule_id
         and rs.client_id = new.client_id
         and rs.property_id = new.property_id
         and rs.service_type_id = new.service_type_id
         and rs.operator_id = new.operator_id
    ) then
      raise exception 'tenant consistency: walk schedule must match client/property/service/operator';
    end if;

  elsif tg_table_name = 'walk_pets' then
    select w.client_id, w.operator_id into v_client, v_operator
      from walks w where w.id = new.walk_id;
    if v_operator is null or v_operator <> new.operator_id then
      raise exception 'tenant consistency: walk_pet walk must belong to operator';
    end if;
    if not exists (
      select 1 from pets p
       where p.id = new.pet_id
         and p.client_id = v_client
         and p.operator_id = new.operator_id
    ) then
      raise exception 'tenant consistency: walk_pet pet must belong to walk client/operator';
    end if;

  elsif tg_table_name = 'walk_gps_points' or tg_table_name = 'walk_photos' then
    if not exists (
      select 1 from walks w
       where w.id = new.walk_id and w.operator_id = new.operator_id
    ) then
      raise exception 'tenant consistency: walk attachment must belong to operator';
    end if;

  elsif tg_table_name = 'credit_ledger' then
    if not exists (
      select 1 from clients c
       where c.id = new.client_id and c.operator_id = new.operator_id
    ) then
      raise exception 'tenant consistency: ledger client must belong to operator';
    end if;
    if new.walk_id is not null and not exists (
      select 1 from walks w
       where w.id = new.walk_id
         and w.client_id = new.client_id
         and w.operator_id = new.operator_id
    ) then
      raise exception 'tenant consistency: ledger walk must belong to client/operator';
    end if;

  elsif tg_table_name = 'payments' then
    if not exists (
      select 1 from clients c
       where c.id = new.client_id and c.operator_id = new.operator_id
    ) then
      raise exception 'tenant consistency: payment client must belong to operator';
    end if;
    if new.walk_id is not null and not exists (
      select 1 from walks w
       where w.id = new.walk_id
         and w.client_id = new.client_id
         and w.operator_id = new.operator_id
    ) then
      raise exception 'tenant consistency: payment walk must belong to client/operator';
    end if;

  elsif tg_table_name = 'notifications' then
    if new.client_id is not null and not exists (
      select 1 from clients c
       where c.id = new.client_id and c.operator_id = new.operator_id
    ) then
      raise exception 'tenant consistency: notification client must belong to operator';
    end if;
    if new.walk_id is not null and not exists (
      select 1 from walks w
       where w.id = new.walk_id
         and w.operator_id = new.operator_id
         and (new.client_id is null or w.client_id = new.client_id)
    ) then
      raise exception 'tenant consistency: notification walk must match operator/client';
    end if;
  end if;

  return new;
end;
$$;

create trigger trg_clients_tenant_consistency
  before insert or update of operator_id, plan_id on clients
  for each row execute function fn_assert_tenant_consistency();

create trigger trg_properties_tenant_consistency
  before insert or update of operator_id, client_id on properties
  for each row execute function fn_assert_tenant_consistency();

create trigger trg_pets_tenant_consistency
  before insert or update of operator_id, client_id on pets
  for each row execute function fn_assert_tenant_consistency();

create trigger trg_access_credentials_tenant_consistency
  before insert or update of operator_id, property_id on access_credentials
  for each row execute function fn_assert_tenant_consistency();

create trigger trg_recurring_schedules_tenant_consistency
  before insert or update of operator_id, client_id, property_id, service_type_id
  on recurring_schedules
  for each row execute function fn_assert_tenant_consistency();

create trigger trg_schedule_pets_tenant_consistency
  before insert or update of operator_id, schedule_id, pet_id on schedule_pets
  for each row execute function fn_assert_tenant_consistency();

create trigger trg_walks_tenant_consistency
  before insert or update of operator_id, client_id, property_id, service_type_id, schedule_id
  on walks
  for each row execute function fn_assert_tenant_consistency();

create trigger trg_walk_pets_tenant_consistency
  before insert or update of operator_id, walk_id, pet_id on walk_pets
  for each row execute function fn_assert_tenant_consistency();

create trigger trg_walk_gps_points_tenant_consistency
  before insert or update of operator_id, walk_id on walk_gps_points
  for each row execute function fn_assert_tenant_consistency();

create trigger trg_walk_photos_tenant_consistency
  before insert or update of operator_id, walk_id on walk_photos
  for each row execute function fn_assert_tenant_consistency();

create trigger trg_credit_ledger_tenant_consistency
  before insert or update of operator_id, client_id, walk_id on credit_ledger
  for each row execute function fn_assert_tenant_consistency();

create trigger trg_payments_tenant_consistency
  before insert or update of operator_id, client_id, walk_id on payments
  for each row execute function fn_assert_tenant_consistency();

create trigger trg_notifications_tenant_consistency
  before insert or update of operator_id, client_id, walk_id on notifications
  for each row execute function fn_assert_tenant_consistency();
