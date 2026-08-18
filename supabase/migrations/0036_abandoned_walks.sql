-- 0036 — a walk that was never ended stops being invisible.
--
-- Review M28. There is no maximum duration, no server-side auto-complete and
-- no stale sweep, and `complete-walk` is the ONLY exit from `in_progress`. So
-- an operator who forgets to press END WALK — or whose phone dies, or who
-- loses the tab — leaves a walk that:
--
--   * never completes, so it never debits and never charges: silent revenue
--     loss, on a visit that actually happened
--   * never sends the client a report, so the proof of service never arrives
--   * keeps accepting GPS points for as long as the app is open
--   * is INVISIBLE, because Today fetches `{ date: today }` and yesterday's
--     abandoned walk is not today's
--
-- The last one is what makes the other three permanent. Nothing in the product
-- ever shows the operator that it happened.
--
-- ── What the sweep deliberately does NOT do ───────────────────────────────
--
-- It does not auto-complete, and it does not guess an end time or a distance.
--
-- Completing means BILLING: debiting a credit or charging a card for a visit
-- whose end nobody recorded. Getting that wrong bills a client for a walk that
-- may have been cut short, using a duration invented by a cron job — and the
-- distance on the report card is sold as proof of service. Silently charging
-- is a worse failure than silently not charging, because the client sees it
-- and the operator does not.
--
-- So the sweep only ends the SILENCE: it stamps `abandoned_at`, which is what
-- the operator's Today screen keys on. The walk stays `in_progress` on purpose
-- — `complete-walk` asserts that status, so the operator can still finish it
-- properly, with the real numbers, once they have been told it is there.

alter table walks add column abandoned_at timestamptz;

comment on column walks.abandoned_at is
  'Stamped by the nightly sweep when a walk has been in_progress far longer than any real visit. The walk stays in_progress so it can still be completed properly — this only marks it as needing the operator (review M28).';

-- Partial: "walks needing attention" is a handful of rows in a table that
-- grows with every visit, and the query runs on every Today load.
create index idx_walks_abandoned
  on walks (operator_id, abandoned_at)
  where status = 'in_progress' and abandoned_at is null;

create function fn_sweep_abandoned_walks(p_hours int default 6)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  if not fn_is_service_session() then
    raise exception 'fn_sweep_abandoned_walks: service role required';
  end if;
  if p_hours is null or p_hours <= 0 then
    raise exception 'fn_sweep_abandoned_walks: hours must be positive';
  end if;

  -- `started_at`, not `scheduled_date`: a walk started at 23:50 and abandoned
  -- is barely an hour old at midnight, and sweeping by calendar day would
  -- flag it while the operator is still on the doorstep. The clock that
  -- matters is how long it has actually been running.
  --
  -- `abandoned_at is null` keeps this idempotent — a walk already flagged
  -- keeps its original timestamp, so "how long has this been sitting there"
  -- stays answerable after the second night.
  update walks
     set abandoned_at = now()
   where status = 'in_progress'
     and abandoned_at is null
     and started_at is not null
     and started_at < now() - make_interval(hours => p_hours);

  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function fn_sweep_abandoned_walks(int) from public, anon, authenticated;

comment on function fn_sweep_abandoned_walks(int) is
  'Marks walks that have been in_progress far longer than any real visit, so the operator is told. Deliberately does not complete them: completing means billing, and a duration invented by a cron job is not a thing to charge for (review M28).';

-- ── Wire it into the nightly run ─────────────────────────────────────────
-- Same shape as the expiry sweep: advisory, so a failure must not cost the
-- operator a calendar, but CAPTURED and reported rather than swallowed. The
-- expiry sweep's `if (!sweep.error)` swallow is exactly the defect 0028 fixed,
-- and repeating it here would be repeating it knowingly.
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
  v_abandoned int := 0;
  v_backlog int := 0;
  v_stale_walks int := 0;
  v_stale_error text;
  v_ok boolean := true;
begin
  if not fn_is_service_session() then
    raise exception 'fn_run_nightly_jobs: service role required';
  end if;

  insert into job_runs (job_name) values ('nightly') returning id into v_run;

  v_created := fn_materialize_walks(p_horizon_days);

  begin
    v_expired := fn_expire_credits();
  exception when others then
    v_expiry_error := sqlerrm;
    v_ok := false;
  end;

  begin
    v_stale_walks := fn_sweep_abandoned_walks();
  exception when others then
    v_stale_error := sqlerrm;
    v_ok := false;
  end;

  -- Age out what will never be retried, then count what still can be. The
  -- order matters: counting first would include rows this run is about to
  -- abandon, and report a backlog that is already closed.
  v_abandoned := fn_expire_notification_backlog();
  select count(*) into v_backlog from fn_notification_backlog();

  update job_runs
     set finished_at = clock_timestamp(),
         ok = v_ok,
         -- Both, not `coalesce`: two failing sweeps must not hide behind each
         -- other. `concat_ws` skips nulls, and the `nullif` keeps a quiet
         -- night's error genuinely null rather than the empty string.
         error = nullif(concat_ws(' | ', v_expiry_error, v_stale_error), ''),
         detail = jsonb_build_object(
           'created', v_created,
           'expired_clients', v_expired,
           'horizon_days', p_horizon_days,
           'emails_abandoned', v_abandoned,
           'email_backlog', v_backlog,
           'walks_flagged_abandoned', v_stale_walks)
   where id = v_run;

  return jsonb_build_object(
    'run_id', v_run,
    'created', v_created,
    'expired_clients', v_expired,
    'expiry_error', v_expiry_error,
    'emails_abandoned', v_abandoned,
    'email_backlog', v_backlog,
    'walks_flagged_abandoned', v_stale_walks,
    'stale_walk_error', v_stale_error);
end;
$$;

revoke all on function fn_run_nightly_jobs(int) from public, anon, authenticated;
