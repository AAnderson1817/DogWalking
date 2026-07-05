-- 0007 — walk materializer core (phase 06, spec 04 materialize-walks)
-- Set-based generation so the logic is testable from SQL
-- (supabase/tests/materializer.sql) and the edge function stays a thin
-- auth/cron wrapper. Idempotent via the (schedule_id, scheduled_date)
-- partial unique index — re-runs and operator-cancelled dates never
-- duplicate or resurrect walks.

create function fn_materialize_walks(p_horizon_days int default 14)
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
                     schedule_id, scheduled_date, window_start, window_end, status)
  select rs.operator_id, rs.client_id, rs.property_id, rs.service_type_id,
         rs.id, d.day, rs.window_start, rs.window_end, 'scheduled'
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
     -- pause window: closed range, or open-ended from paused_from
     and not (rs.paused_from is not null
              and d.day >= rs.paused_from
              and (rs.paused_until is null or d.day <= rs.paused_until))
  on conflict (schedule_id, scheduled_date) where schedule_id is not null
  do nothing;

  get diagnostics v_created = row_count;

  -- Materialized walks carry the schedule's pets.
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
