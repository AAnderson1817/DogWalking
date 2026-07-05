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
