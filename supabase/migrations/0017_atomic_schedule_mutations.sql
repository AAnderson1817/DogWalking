-- 0017 — atomic schedule mutations.
-- Move multi-step schedule pet replacement and schedule deactivation/cancel
-- workflows out of PostgREST client sequences and into one transaction each.

create function fn_set_schedule_pets(p_schedule uuid, p_pet_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operator uuid;
  v_client uuid;
  v_pet uuid;
begin
  select operator_id, client_id into v_operator, v_client
    from recurring_schedules
   where id = p_schedule
   for update;
  if not found then
    raise exception 'fn_set_schedule_pets: unknown schedule %', p_schedule;
  end if;
  if not fn_is_service_session() and auth.uid() <> v_operator then
    raise exception 'fn_set_schedule_pets: forbidden';
  end if;

  delete from schedule_pets where schedule_id = p_schedule;

  foreach v_pet in array coalesce(p_pet_ids, array[]::uuid[]) loop
    if not exists (
      select 1 from pets p
       where p.id = v_pet and p.client_id = v_client and p.operator_id = v_operator
    ) then
      raise exception 'fn_set_schedule_pets: pet % does not belong to schedule client/operator', v_pet;
    end if;
    insert into schedule_pets (schedule_id, pet_id, operator_id)
    values (p_schedule, v_pet, v_operator)
    on conflict do nothing;
  end loop;
end;
$$;

create function fn_deactivate_schedule(p_schedule uuid, p_today date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operator uuid;
begin
  if p_today is null then
    raise exception 'fn_deactivate_schedule: today is required';
  end if;

  select operator_id into v_operator
    from recurring_schedules
   where id = p_schedule
   for update;
  if not found then
    raise exception 'fn_deactivate_schedule: unknown schedule %', p_schedule;
  end if;
  if not fn_is_service_session() and auth.uid() <> v_operator then
    raise exception 'fn_deactivate_schedule: forbidden';
  end if;

  update recurring_schedules
     set active = false
   where id = p_schedule;

  update walks
     set status = 'cancelled'
   where schedule_id = p_schedule
     and status = 'scheduled'
     and scheduled_date >= p_today;
end;
$$;

revoke all on function fn_set_schedule_pets(uuid, uuid[]) from public, anon;
revoke all on function fn_deactivate_schedule(uuid, date) from public, anon;
grant execute on function fn_set_schedule_pets(uuid, uuid[]) to authenticated, service_role;
grant execute on function fn_deactivate_schedule(uuid, date) to authenticated, service_role;
