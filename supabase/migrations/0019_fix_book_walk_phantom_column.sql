-- 0019 — fn_book_walk referenced a column that has never existed.
--
-- Review 2026-08 finding B1 (issue #9). 0013 introduced fn_book_walk as the
-- atomic client self-booking RPC, and its service check read:
--
--     where id = p_service and operator_id = v_operator and active
--
-- `service_types` has no `active` column and never has — the table is defined
-- in 0002_schema.sql:185-195 with id, operator_id, name, duration_minutes,
-- credit_cost, weekend_surcharge_credits, is_default, created_at, updated_at.
-- No migration adds one. PostgreSQL resolves column references at execution,
-- not at CREATE FUNCTION time, so the function installed cleanly and then
-- raised 42703 undefined_column on every single call.
--
-- Effect: client self-booking — one of the two things the client portal exists
-- for — has never worked in production. app/src/lib/api.ts:162 calls this RPC
-- from Booking.tsx.
--
-- Why it went unnoticed: smoke.sql never called fn_book_walk, and the
-- Playwright suite ran in no workflow. Both gaps are closed — the e2e job
-- landed in #19, and this migration ships with the smoke coverage that would
-- have caught it (supabase/tests/smoke.sql, "fn_book_walk (0019)" block).
--
-- Fix: drop the phantom predicate. The real authorization check is
-- `operator_id = v_operator`, which is unchanged — a client can still only
-- book a service belonging to their own operator.
--
-- Deliberately NOT adding an `active` column. Nothing in the schema, the API
-- layer or the UI has a concept of service deactivation, and there is no
-- surface that could set it (review B6, issue #15). Adding an unused column
-- to satisfy a typo would be permanent under the append-only rule. If service
-- deactivation is wanted later it should arrive as a deliberate feature: a
-- column, a default, the UI to toggle it, and a test that a deactivated
-- service is rejected here.
--
-- The body below is 0013's verbatim, with `and active` removed and nothing
-- else changed.

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

-- CREATE OR REPLACE preserves privileges, but restate them so the grant
-- surface of this function is readable in one place rather than only in 0013
-- (invariant 5).
revoke all on function fn_book_walk(uuid, uuid, date, time, time, uuid[])
  from public, anon;
grant execute on function fn_book_walk(uuid, uuid, date, time, time, uuid[])
  to authenticated;
