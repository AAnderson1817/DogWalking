-- 0029 — email delivery stops being fire-and-forget (review H17)
--
-- `notifications` recorded whether the in-app bell had a row and nothing about
-- whether the EMAIL ever left. Delivery is driven by a Supabase Database
-- Webhook on INSERT, which is pg_net-based and does not retry on a non-2xx —
-- so when Resend is down, rate-limited, or the sending domain falls out of
-- verification, the function threw a 502, the webhook recorded a failed row in
-- net._http_response (short retention), and the email was lost permanently
-- with nothing on the notification row to show it.
--
-- Worse than losing it silently: `if (!apiKey) return jsonOk({ skipped: true })`
-- meant a production deploy that forgot RESEND_API_KEY reported uniform success
-- forever while sending zero email. Affected types include payment_failed and
-- walk_cancelled — a client never learns their card failed, an operator never
-- learns a walk was cancelled, and the in-app bell still shows the row, so the
-- system looks healthy from the inside while the outside channel is dead.
--
-- "We cannot tell you whether our customers received their notifications" is a
-- diligence problem on its own.


-- ── 1. Four columns and a state ──────────────────────────────────────────
-- A brand-new enum, so it can be created and used in the same transaction.
-- (The 0022/0025 restriction is on ALTER TYPE ... ADD VALUE, which cannot be
-- used in the transaction that adds it; CREATE TYPE has no such limit.)
--
-- Four states rather than a bare `sent_at`, because "not sent" is three
-- different things and a retry sweep that cannot tell them apart either
-- retries forever or gives up on real failures:
--
--   pending  nobody has looked at it yet
--   sent     it left
--   skipped  TERMINAL non-send: operator-only notification, client has no
--            email. Correct, and must never be retried.
--   failed   the provider or we broke. Retryable within a window.
create type email_delivery_status as enum ('pending', 'sent', 'skipped', 'failed');

-- Prefixed `email_`, deliberately diverging from the review's suggested
-- `sent_at`/`attempts`/`last_error`. This table already carries `read_at` for
-- the in-app bell, and a bare `sent_at` on a table called `notifications`
-- reads as "the notification was sent" — which is true the moment the row
-- exists, and is not what these track.
alter table notifications
  add column if not exists email_status email_delivery_status not null default 'pending',
  add column if not exists email_attempts int not null default 0,
  add column if not exists email_sent_at timestamptz,
  add column if not exists email_last_error text;

-- Partial: the backlog query only ever wants non-terminal rows, and on a busy
-- operator the vast majority are 'sent'.
create index if not exists idx_notifications_email_backlog
  on notifications (created_at)
  where email_status in ('pending', 'failed');


-- ── 2. Existing rows are given up on, not retried ────────────────────────
-- Every row that predates this migration would otherwise default to 'pending'
-- and flood the first backlog sweep. We genuinely do not know whether those
-- emails were sent — that is the whole defect — and retrying them would send a
-- client "your walk is complete" for a walk from last month.
--
-- So they are marked terminal with a reason that says exactly that. A guessed
-- delivery state is worse than an admitted unknown, the same call 0023 made
-- about untraceable payments.
update notifications
   set email_status = 'skipped',
       email_last_error = 'predates delivery tracking (0029); unknown whether sent'
 where email_status = 'pending';


-- ── 3. The retryable backlog ─────────────────────────────────────────────
-- Deliberately NOT filtered on notification type. Which types are
-- client-facing lives in one place — CLIENT_FACING in send-notification — and
-- duplicating that list here would give it two homes and one of them would
-- drift. Instead the function marks anything it will not send as 'skipped' the
-- first time it sees the row, so a row only stays non-terminal if an attempt
-- has genuinely not concluded.
create or replace function fn_notification_backlog(
  p_window interval default interval '24 hours',
  p_max_attempts int default 5
)
returns table (
  id uuid,
  email_status email_delivery_status,
  email_attempts int,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select n.id, n.email_status, n.email_attempts, n.created_at
    from notifications n
   where n.email_status in ('pending', 'failed')
     and n.created_at > now() - p_window
     and n.email_attempts < p_max_attempts
   order by n.created_at
$$;

revoke all on function fn_notification_backlog(interval, int) from public, anon, authenticated;
grant execute on function fn_notification_backlog(interval, int) to service_role;

-- ── 4. Giving up, on purpose and countably ───────────────────────────────
-- Without this the backlog grows forever: a row that failed five times, or
-- aged out of the retry window, stays non-terminal and every future health
-- check reports it. Marking it terminal keeps the RETRYABLE backlog bounded,
-- and the count of what was abandoned is itself the thing worth reporting —
-- an operator should know an email was never delivered, even though nothing
-- more will be tried.
create or replace function fn_expire_notification_backlog(
  p_window interval default interval '24 hours',
  p_max_attempts int default 5
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  if not fn_is_service_session() then
    raise exception 'fn_expire_notification_backlog: service role required';
  end if;

  update notifications
     set email_status = 'failed',
         email_last_error = coalesce(email_last_error, '')
           || case when email_last_error is null then '' else ' | ' end
           || case
                when email_attempts >= p_max_attempts
                  then format('gave up after %s attempts', email_attempts)
                else format('aged out of the %s retry window', p_window)
              end
   where email_status in ('pending', 'failed')
     and (created_at <= now() - p_window or email_attempts >= p_max_attempts)
     -- Idempotent: a row already carrying a give-up note must not accrue a
     -- second one every night for the rest of time.
     and coalesce(email_last_error, '') not like '%gave up after%'
     and coalesce(email_last_error, '') not like '%aged out of%';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function fn_expire_notification_backlog(interval, int)
  from public, anon, authenticated;
grant execute on function fn_expire_notification_backlog(interval, int) to service_role;


-- ── 5. The nightly job reports the backlog ───────────────────────────────
-- Body copied from 0028 with one block added. The two existing halves are
-- unchanged: materialization propagates, the credit sweep is captured rather
-- than swallowed.
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

  -- Age out what will never be retried, then count what still can be. The
  -- order matters: counting first would include rows this run is about to
  -- abandon, and report a backlog that is already closed.
  v_abandoned := fn_expire_notification_backlog();
  select count(*) into v_backlog from fn_notification_backlog();

  update job_runs
     set finished_at = clock_timestamp(),
         ok = v_ok,
         error = v_expiry_error,
         detail = jsonb_build_object(
           'created', v_created,
           'expired_clients', v_expired,
           'horizon_days', p_horizon_days,
           'emails_abandoned', v_abandoned,
           'email_backlog', v_backlog)
   where id = v_run;

  return jsonb_build_object(
    'run_id', v_run,
    'created', v_created,
    'expired_clients', v_expired,
    'expiry_error', v_expiry_error,
    'emails_abandoned', v_abandoned,
    'email_backlog', v_backlog);
end;
$$;

revoke all on function fn_run_nightly_jobs(int) from public, anon, authenticated;
grant execute on function fn_run_nightly_jobs(int) to service_role;


-- No new grants for the API roles. 0004 grants `authenticated` only
-- `update (read_at)` — a COLUMN-level grant — so the four columns added here
-- are unwritable by a client without anything further. That is the existing
-- design being right rather than luck, and smoke.sql now asserts it, because a
-- later table-level `grant update on notifications` would silently let a client
-- mark their own payment_failed email as sent.
