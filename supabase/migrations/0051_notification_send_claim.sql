-- 0051 — send-once becomes atomic, on BOTH channels.
--
-- `deliverNotification` and `deliverPush` each read the channel's status and
-- then write the outcome later, so the guard is a read-then-act. Two
-- concurrent invocations both pass it and both deliver. That is reachable
-- three ways today: the INSERT database webhook racing the nightly drain, the
-- drain racing itself if a run overlaps, and the endpoint accepting a
-- `notification_id` directly (M1), which an operator can POST in a loop.
--
-- The harm is ASYMMETRIC, which is why this was worth doing properly rather
-- than only for push: the service worker sets `tag` to the notification id, so
-- a duplicate push COLLAPSES on the lock screen and the person sees one
-- notification. A duplicate email is a second email. The email arm is the one
-- that actually reaches somebody twice, and it has had this shape since M1.
--
-- ── Why a timestamp claim and not a 'sending' status ──────────────────────
--
-- The obvious modelling is a new `sending` value on the two delivery enums.
-- It is refused here for a mechanical reason this repository has already paid
-- for: `alter type ... add value` cannot be used in the same transaction that
-- adds it, and `db-push-check.sh` applies one transaction per file, so it
-- would take two migrations to express one idea. A nullable claim timestamp
-- says the same thing -- "somebody is sending this right now" -- in one file,
-- and leaves `*_status` meaning only what it has always meant: the OUTCOME.
--
-- ── Why a lease ──────────────────────────────────────────────────────────
--
-- A claim with no expiry turns a crash into a permanent loss: the row is
-- neither sent nor reclaimable, which is worse than the duplicate it prevents.
-- The lease is the 0013 stripe_events shape -- a claim older than the lease is
-- assumed crashed and may be taken over. Edge functions cap out well below it.

alter table notifications
  add column if not exists email_claimed_at timestamptz,
  add column if not exists push_claimed_at  timestamptz;

comment on column notifications.email_claimed_at is
  'When a sender claimed the email channel (0051). NULL = unclaimed. A claim '
  'older than the lease is assumed crashed and may be taken over.';
comment on column notifications.push_claimed_at is
  'When a sender claimed the push channel (0051). See email_claimed_at.';

-- Neither column is writable by an API role: the claim is the whole mutual
-- exclusion, and a caller that can set it can defeat it. 0004 revoked all on
-- notifications from the API roles and granted a narrow set; this asserts the
-- claim columns did not arrive inside that set.
do $$
begin
  if has_column_privilege('authenticated', 'notifications', 'email_claimed_at', 'update')
     or has_column_privilege('authenticated', 'notifications', 'push_claimed_at', 'update') then
    raise exception '0051: the claim columns must not be writable by authenticated';
  end if;
end $$;

/**
 * Claim one channel of one notification for sending. Returns true if THIS
 * caller may send, false if somebody else holds a live claim or the channel
 * is already settled.
 *
 * The mutual exclusion is the single conditional UPDATE, not the read before
 * it. Under READ COMMITTED a second contender blocks on the row lock, then
 * re-evaluates its WHERE against the row the winner just wrote -- sees a claim
 * that is no longer older than the cutoff -- and updates zero rows. That is
 * the same instrument as 0016's rate limit and 0048's budget, and it is the
 * reason this cannot be a SELECT followed by an UPDATE.
 *
 * The channel is validated and then dispatched to STATIC sql. A definer
 * function assembling an identifier from an argument is how injection gets
 * into a security-definer context, and two short branches cost less than the
 * argument for why the dynamic version is safe.
 */
create function fn_claim_notification_send(
  p_id uuid,
  p_channel text,
  p_lease interval default interval '5 minutes'
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed int;
begin
  if not fn_is_service_session() then
    raise exception 'fn_claim_notification_send: service role only';
  end if;
  if p_channel is null or p_channel not in ('email', 'push') then
    raise exception 'fn_claim_notification_send: unknown channel %', p_channel;
  end if;
  if p_lease is null or p_lease <= interval '0' then
    raise exception 'fn_claim_notification_send: lease must be positive';
  end if;

  if p_channel = 'email' then
    update notifications
       set email_claimed_at = now()
     where id = p_id
       -- Only the retryable set, so this cannot revive a settled channel.
       -- Deliberately the same two values `fn_notification_backlog` selects
       -- and `isSettled` refuses, rather than a third list that can drift.
       and email_status in ('pending', 'failed')
       and (email_claimed_at is null or email_claimed_at < now() - p_lease);
  else
    update notifications
       set push_claimed_at = now()
     where id = p_id
       and push_status in ('pending', 'failed')
       and (push_claimed_at is null or push_claimed_at < now() - p_lease);
  end if;

  get diagnostics v_claimed = row_count;
  return v_claimed = 1;
end $$;

revoke all on function fn_claim_notification_send(uuid, text, interval)
  from public, anon, authenticated;
grant execute on function fn_claim_notification_send(uuid, text, interval)
  to service_role;

comment on function fn_claim_notification_send(uuid, text, interval) is
  'Atomically claim one channel of one notification for sending (0051). The '
  'single conditional UPDATE is the mutual exclusion; the lease lets a '
  'crashed sender be taken over rather than stranding the row.';

/**
 * The backlog stops handing out a row somebody is sending RIGHT NOW.
 *
 * Without this the drain selects a claimed row, the claim then refuses it, and
 * the run reports work it never did. Built from pg_get_functiondef of the LIVE
 * function rather than from 0029's text, because 0049 widened it for push and
 * a body written from the older file would silently delete that.
 */
create or replace function fn_notification_backlog(
  p_window interval default interval '24 hours',
  p_max_attempts int default 5
) returns table (
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
   where n.created_at > now() - p_window
     and (
       (n.email_status in ('pending', 'failed') and n.email_attempts < p_max_attempts
          and (n.email_claimed_at is null
               or n.email_claimed_at < now() - interval '5 minutes'))
       or (n.push_status in ('pending', 'failed') and n.push_attempts < p_max_attempts
          and (n.push_claimed_at is null
               or n.push_claimed_at < now() - interval '5 minutes'))
     )
   order by n.created_at
$$;
