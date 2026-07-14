-- Materializer assertions (phase 06). Run through /validate after smoke:
--   psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/materializer.sql
-- Rolls back — leaves the database untouched. Fixture namespace 88888888-….

begin;

do $$
declare
  v_created int;
  v_second int;
  v_bad int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- ── fixtures ────────────────────────────────────────────────────────────
  insert into auth.users (id, email)
  values ('88888888-0000-4000-a000-000000000001', 'mat-op@pawtrail.dev');
  insert into operators (id, business_name, display_name, email)
  values ('88888888-0000-4000-a000-000000000001', 'Mat Walks', 'Mat', 'mat-op@pawtrail.dev');

  insert into clients (id, operator_id, full_name, status, subscription_status)
  values
    ('88888888-0000-4000-c000-000000000001', '88888888-0000-4000-a000-000000000001',
     'Mat Active', 'active', 'active'),
    ('88888888-0000-4000-c000-000000000002', '88888888-0000-4000-a000-000000000001',
     'Mat Paused', 'active', 'paused');

  insert into properties (id, operator_id, client_id, label) values
    ('88888888-0000-4000-d000-000000000001', '88888888-0000-4000-a000-000000000001',
     '88888888-0000-4000-c000-000000000001', 'Home'),
    ('88888888-0000-4000-d000-000000000002', '88888888-0000-4000-a000-000000000001',
     '88888888-0000-4000-c000-000000000002', 'Home');

  insert into pets (id, operator_id, client_id, name)
  values ('88888888-0000-4000-e000-000000000001', '88888888-0000-4000-a000-000000000001',
          '88888888-0000-4000-c000-000000000001', 'Mat Pet');

  -- Schedule A: Mon/Wed/Fri lunchtime, active client, pause window covering
  -- days 5..7 of the horizon; ends day 10.
  insert into recurring_schedules
    (id, operator_id, client_id, property_id, service_type_id, days_of_week,
     window_start, window_end, start_date, end_date, paused_from, paused_until)
  select '88888888-0000-4000-1000-000000000001', '88888888-0000-4000-a000-000000000001',
         '88888888-0000-4000-c000-000000000001', '88888888-0000-4000-d000-000000000001',
         st.id, array[1,3,5], '12:00', '13:00',
         current_date, current_date + 10, current_date + 5, current_date + 7
    from service_types st
   where st.operator_id = '88888888-0000-4000-a000-000000000001' and st.is_default;

  insert into schedule_pets (schedule_id, pet_id, operator_id)
  values ('88888888-0000-4000-1000-000000000001', '88888888-0000-4000-e000-000000000001',
          '88888888-0000-4000-a000-000000000001');

  -- Schedule B: daily, but the client's subscription is paused ⇒ nothing.
  insert into recurring_schedules
    (id, operator_id, client_id, property_id, service_type_id, days_of_week,
     window_start, window_end, start_date)
  select '88888888-0000-4000-1000-000000000002', '88888888-0000-4000-a000-000000000001',
         '88888888-0000-4000-c000-000000000002', '88888888-0000-4000-d000-000000000002',
         st.id, array[1,2,3,4,5,6,7], '09:00', '10:00', current_date
    from service_types st
   where st.operator_id = '88888888-0000-4000-a000-000000000001' and st.is_default;

  -- ── run ─────────────────────────────────────────────────────────────────
  select fn_materialize_walks(14) into v_created;
  if v_created < 1 then
    raise exception 'MATERIALIZER FAIL: first run created % walks', v_created;
  end if;

  -- Idempotent: second run adds nothing (for these or any seeded schedules).
  select fn_materialize_walks(14) into v_second;
  if v_second <> 0 then
    raise exception 'MATERIALIZER FAIL: second run created % new walks', v_second;
  end if;

  -- Only Mon/Wed/Fri.
  select count(*) into v_bad
    from walks
   where schedule_id = '88888888-0000-4000-1000-000000000001'
     and extract(isodow from scheduled_date)::int <> all (array[1,3,5]);
  if v_bad <> 0 then
    raise exception 'MATERIALIZER FAIL: % walks on wrong weekdays', v_bad;
  end if;

  -- None inside the pause window.
  select count(*) into v_bad
    from walks
   where schedule_id = '88888888-0000-4000-1000-000000000001'
     and scheduled_date between current_date + 5 and current_date + 7;
  if v_bad <> 0 then
    raise exception 'MATERIALIZER FAIL: % walks inside the pause window', v_bad;
  end if;

  -- None beyond end_date.
  select count(*) into v_bad
    from walks
   where schedule_id = '88888888-0000-4000-1000-000000000001'
     and scheduled_date > current_date + 10;
  if v_bad <> 0 then
    raise exception 'MATERIALIZER FAIL: % walks beyond end_date', v_bad;
  end if;

  -- None for the paused client.
  select count(*) into v_bad
    from walks
   where schedule_id = '88888888-0000-4000-1000-000000000002';
  if v_bad <> 0 then
    raise exception 'MATERIALIZER FAIL: % walks for a paused client', v_bad;
  end if;

  -- Pets copied onto materialized walks.
  select count(*) into v_bad
    from walks w
   where w.schedule_id = '88888888-0000-4000-1000-000000000001'
     and not exists (select 1 from walk_pets wp
                      where wp.walk_id = w.id
                        and wp.pet_id = '88888888-0000-4000-e000-000000000001');
  if v_bad <> 0 then
    raise exception 'MATERIALIZER FAIL: % walks missing schedule pets', v_bad;
  end if;

  -- Cancelled dates are not resurrected.
  update walks set status = 'cancelled'
   where schedule_id = '88888888-0000-4000-1000-000000000001'
     and scheduled_date = (
       select min(scheduled_date) from walks
        where schedule_id = '88888888-0000-4000-1000-000000000001');
  select fn_materialize_walks(14) into v_second;
  if v_second <> 0 then
    raise exception 'MATERIALIZER FAIL: re-run resurrected a cancelled walk';
  end if;

  -- A rescheduled (moved) walk is NOT resurrected on its origin date (0012).
  declare
    v_moved uuid;
    v_before int;
    v_after int;
  begin
    select id into v_moved from walks
      where schedule_id = '88888888-0000-4000-1000-000000000001'
        and status = 'scheduled'
      order by scheduled_date limit 1;
    -- Move it a year out so it can't collide with any generated date.
    update walks set scheduled_date = scheduled_date + 365
      where id = v_moved;
    select count(*) into v_before from walks
      where schedule_id = '88888888-0000-4000-1000-000000000001';
    perform fn_materialize_walks(14);
    select count(*) into v_after from walks
      where schedule_id = '88888888-0000-4000-1000-000000000001';
    if v_after <> v_before then
      raise exception 'MATERIALIZER FAIL: rescheduled walk was resurrected (% -> %)',
        v_before, v_after;
    end if;
  end;

  -- NULL-origin escape (0013): a schedule walk inserted without origin_date
  -- must be defaulted by the trigger, occupy its slot, and never duplicate.
  declare
    v_null_day date;
    v_dup int;
  begin
    select min(scheduled_date) into v_null_day from walks
      where schedule_id = '88888888-0000-4000-1000-000000000001' and status = 'scheduled';
    -- simulate a direct PostgREST-style insert omitting origin_date on a NEW day
    insert into walks (operator_id, client_id, property_id, service_type_id,
                       schedule_id, scheduled_date, window_start, window_end, status)
    select operator_id, client_id, property_id, service_type_id,
           schedule_id, scheduled_date + 100, window_start, window_end, 'scheduled'
      from walks where schedule_id = '88888888-0000-4000-1000-000000000001' limit 1;
    if exists (select 1 from walks
                where schedule_id is not null and origin_date is null) then
      raise exception 'MATERIALIZER FAIL: origin_date not defaulted on insert';
    end if;
    perform fn_materialize_walks(14);
    select count(*) into v_dup from (
      select schedule_id, scheduled_date from walks
       where schedule_id is not null and status = 'scheduled'
       group by 1, 2 having count(*) > 1) d;
    if v_dup <> 0 then
      raise exception 'MATERIALIZER FAIL: duplicate live schedule walks exist (%)', v_dup;
    end if;
  end;

  -- Pause cancels materialized walks; clearing the pause restores them (0013).
  declare
    v_target date;
    v_status text;
  begin
    select min(scheduled_date) into v_target from walks
      where schedule_id = '88888888-0000-4000-1000-000000000001'
        and status = 'scheduled' and scheduled_date > current_date;
    if v_target is null then
      raise exception 'MATERIALIZER FAIL: no future walk to pause-test against';
    end if;
    update recurring_schedules
       set paused_from = v_target, paused_until = v_target
     where id = '88888888-0000-4000-1000-000000000001';
    select status into v_status from walks
      where schedule_id = '88888888-0000-4000-1000-000000000001'
        and scheduled_date = v_target
        and origin_date = scheduled_date;
    if v_status is distinct from 'cancelled' then
      raise exception 'MATERIALIZER FAIL: pause did not cancel in-window walk (%)', v_status;
    end if;
    update recurring_schedules
       set paused_from = null, paused_until = null
     where id = '88888888-0000-4000-1000-000000000001';
    select status into v_status from walks
      where schedule_id = '88888888-0000-4000-1000-000000000001'
        and scheduled_date = v_target
        and origin_date = scheduled_date;
    if v_status is distinct from 'scheduled' then
      raise exception 'MATERIALIZER FAIL: clearing pause did not restore walk (%)', v_status;
    end if;
  end;

  -- Authenticated callers are rejected (service only).
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"88888888-0000-4000-a000-000000000001","role":"authenticated"}', true);
    set local session authorization authenticated;
    begin
      perform fn_materialize_walks(14);
      raise exception 'MATERIALIZER FAIL: authenticated caller was not rejected';
    exception when insufficient_privilege then
      null; -- expected: no EXECUTE grant
    end;
    reset session authorization;
  end;

  raise notice 'MATERIALIZER PASS (first run created % walks)', v_created;
end $$;

rollback;
