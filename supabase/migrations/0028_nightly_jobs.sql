-- 0028 — the nightly job becomes a versioned schedule with a heartbeat
--        (review H15)
--
-- `materialize-walks` generates every walk on every calendar and runs the
-- daily credit-expiry sweep. It was scheduled by hand-typing a Supabase
-- dashboard cron entry with a pasted service_role bearer header. That entry
-- lived in no migration, no workflow and no runbook-recreatable form:
--
--   * a project restore does not bring it back, and docs/dev/disaster-recovery
--     had no step that would have noticed;
--   * nothing anywhere asserted it existed;
--   * the failure is silent for a fortnight, because the horizon is 14 days —
--     the operator finds out when a client asks why the calendar is empty;
--   * the expiry half is worse in a quieter way. `fn_expire_credits` swallowed
--     its own error (`if (!sweep.error) expired = …`), so a permanently
--     failing sweep was byte-identical in the response to a quiet night.
--     Clients keep credits they were billed for and stop paying overage: a
--     revenue leak with no symptom at all.
--
-- Three parts here: the work moves into one SQL entry point, pg_cron runs it
-- on a schedule this file owns, and every run leaves a row behind so "did it
-- run?" is a question with an answer.


-- ── 1. No credential, because none is needed ─────────────────────────────
-- The review's proposed fix was pg_net posting to the edge function with the
-- service key read from Supabase Vault. That is a faithful translation of the
-- dashboard entry, and it is more machinery than the problem needs.
--
-- fn_is_service_session() (0003) is satisfied by `session_user = 'postgres'`,
-- and a pg_cron job runs as the role that scheduled it — postgres, since
-- migrations are applied as postgres. So calling the SQL directly needs no
-- key, no Vault secret, no HTTP hop and no pg_net at all.
--
-- It also removes the detection problem rather than working around it. The
-- dashboard cron marks a run "successful" once the HTTP call is DISPATCHED,
-- so a 500 from the function looked identical to a good night; that is why
-- the old runbook told you to go and read net._http_response by hand. A
-- direct call either commits or does not, and cron.job_run_details records
-- which.
--
-- The edge function stays. It is the manual path (the Calendar screen's "Run
-- materializer") and what the staging smoke suite exercises.

-- The attempt is allowed to fail; the ASSERTION below is the gate.
--
-- On the platform this installs pg_cron. Locally and in CI the database is a
-- stock postgres image where the extension is not on disk at all, and
-- scripts/local-stack/shim.sql supplies a faithful stand-in for the two
-- functions and one table this migration touches — the same arrangement 0020
-- uses for realtime.messages.
--
-- Swallowing the error here hides nothing: a platform that genuinely cannot
-- install pg_cron has no cron.schedule either, so it trips the assertion one
-- statement later, carrying the original message with it.
do $$
begin
  execute 'create extension if not exists pg_cron';
exception when others then
  perform set_config('sanpo.pg_cron_error', sqlerrm, false);
end $$;

-- Assert rather than assume. If neither the real extension nor the stand-in
-- provides cron.schedule, every statement below is inert and the deploy
-- reports success having scheduled nothing — the same false assurance as a
-- typecheck that checks zero files, on the job that drives the whole product.
do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise exception
      'pg_cron is not installed and no stand-in is present: '
      'cron.schedule(text,text,text) does not exist. Enable it '
      '(Dashboard -> Database -> Extensions -> pg_cron) and re-run. '
      'create extension said: %',
      coalesce(nullif(current_setting('sanpo.pg_cron_error', true), ''),
               '(no error recorded)');
  end if;
end $$;


-- ── 2. Every run leaves a row ────────────────────────────────────────────
-- Deliberately NOT a tenant table, so invariant 7 does not apply: the
-- materializer runs across every operator at once and there is no operator_id
-- that would be true of a run. RLS is enabled with no policies and no grants
-- to anon/authenticated, so the only reader is service_role.
create table if not exists job_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean not null default false,
  detail jsonb not null default '{}'::jsonb,
  error text
);

create index if not exists idx_job_runs_name_started
  on job_runs (job_name, started_at desc);

alter table job_runs enable row level security;
revoke all on job_runs from public, anon, authenticated;
grant select, insert, update on job_runs to service_role;


-- ── 3. One entry point for the night's work ──────────────────────────────
-- The two halves are independent on purpose. A failing expiry sweep must not
-- stop walks being generated — an operator with no calendar is a worse day
-- than an operator whose rollover lots expire late. But it must not be
-- SILENT either, which is the half the old code got wrong: the sweep's error
-- is caught, recorded, and reported, and the run is marked not-ok.
create or replace function fn_run_nightly_jobs(p_horizon_days int default 14)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run uuid;
  v_created int := 0;
  v_expired int := 0;
  v_expiry_error text;
  v_ok boolean := true;
begin
  if not fn_is_service_session() then
    raise exception 'fn_run_nightly_jobs: service role required';
  end if;

  insert into job_runs (job_name) values ('nightly') returning id into v_run;

  -- Materialization first: it is the half the product cannot do without.
  -- Left to propagate. If walk generation is broken the run must fail loudly
  -- — cron.job_run_details records the exception, and the job_runs row stays
  -- ok = false with no finished_at, which is exactly what the staleness
  -- check below is looking for.
  v_created := fn_materialize_walks(p_horizon_days);

  begin
    v_expired := fn_expire_credits();
  exception when others then
    -- Captured, not swallowed. sqlerrm rather than the whole context: this
    -- row is readable by anything holding the service key, and a plpgsql
    -- context dump can carry row values from the credit ledger.
    v_expiry_error := sqlerrm;
    v_ok := false;
  end;

  update job_runs
     -- clock_timestamp(), not now(): now() is the TRANSACTION start time, so
     -- it would make finished_at equal started_at on every row and the
     -- duration permanently zero.
     set finished_at = clock_timestamp(),
         ok = v_ok,
         error = v_expiry_error,
         detail = jsonb_build_object(
           'created', v_created,
           'expired_clients', v_expired,
           'horizon_days', p_horizon_days)
   where id = v_run;

  -- run_id so a caller can correlate the response with its heartbeat row.
  -- Also the only reliable way to find that row: started_at defaults to now(),
  -- which is transaction-constant, so two runs in one transaction are
  -- indistinguishable by timestamp.
  return jsonb_build_object(
    'run_id', v_run,
    'created', v_created,
    'expired_clients', v_expired,
    'expiry_error', v_expiry_error);
end;
$$;

revoke all on function fn_run_nightly_jobs(int) from public, anon, authenticated;
grant execute on function fn_run_nightly_jobs(int) to service_role;


-- ── 4. Is the thing that runs the product still running? ─────────────────
-- The question the old setup could not answer at all. 26 hours rather than 24
-- gives the 03:00 job a two-hour grace for a slow night or a clock skew,
-- while still failing well inside the 14-day horizon that hid the problem.
create or replace function fn_job_health(p_stale_after interval default interval '26 hours')
returns table (job_name text, last_success timestamptz, age interval, stale boolean)
language sql
stable
security definer
set search_path = public
as $$
  select j.name,
         r.started_at,
         now() - r.started_at,
         -- No successful run EVER is stale, not unknown. A fresh project that
         -- has never run the job is precisely the state this exists to catch,
         -- and returning null there would make the check pass by default.
         r.started_at is null or now() - r.started_at > p_stale_after
    from (values ('nightly')) as j(name)
    left join lateral (
      select started_at from job_runs
       where job_runs.job_name = j.name and ok
       order by started_at desc
       limit 1
    ) r on true
$$;

revoke all on function fn_job_health(interval) from public, anon, authenticated;
grant execute on function fn_job_health(interval) to service_role;


-- ── 5. The schedule itself, in version control ───────────────────────────
-- Idempotent: unschedule-then-schedule, because cron.schedule on an existing
-- name updates it in pg_cron >= 1.4 but the local stand-in should not have to
-- reimplement that, and a migration that behaves differently on the two is a
-- migration that proves nothing.
--
-- 03:00 UTC is 22:00 / 21:00 US Central. The horizon is 14 days, so the exact
-- minute has never mattered; what matters is that it is written down.
do $$
begin
  perform cron.unschedule('sanpo-nightly');
exception when others then
  null; -- not scheduled yet
end $$;

select cron.schedule('sanpo-nightly', '0 3 * * *', 'select fn_run_nightly_jobs()');

-- Prove the row landed. cron.schedule returning a job id is not the same as a
-- job existing to run — and this is the whole point of the migration.
do $$
begin
  if not exists (select 1 from cron.job where jobname = 'sanpo-nightly') then
    raise exception 'cron.schedule reported success but no sanpo-nightly job exists';
  end if;
end $$;
