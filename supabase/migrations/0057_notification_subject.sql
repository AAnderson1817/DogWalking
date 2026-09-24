-- 0057 — an erasure left the client's name in the walker's notifications.
--
-- `notifications.client_id` decides who a notification is FOR, not who it is
-- ABOUT: a client-facing row carries the client's id so their portal can read
-- it (`notifications_client_select`), and an operator-facing row carries NULL
-- so only the walker can (`notifications_operator_select` requires it). So an
-- operator-facing row about a client records that client nowhere but in its
-- words, and through its walk when it names one. `fn_notify_low_credit` writes one ("Jane Doe is low on credits"), the
-- walk trigger writes two ("Jane Doe booked a walk" / "... cancelled a walk"),
-- the overage path one, and the Stripe webhook eight more (a top-up, a saved
-- card, a failed top-up, a plan corrected from an invoice, a price Sanpo does
-- not know, a failed payment, a plan changed outside Sanpo, a cancelled
-- subscription). Its refund or dispute alert names no one: it records no
-- subject, so the client's erasure does not take it, and one arriving after
-- the erasure is still written, because a dispute has a deadline the walker
-- answers in Stripe.
--
-- `fn_purge_client` deletes notifications `where client_id = p_client`, so it
-- removed the client's own inbox and none of these. Measured before this
-- migration, erasing a client the low-credit check had flagged:
--
--   clients.full_name                          -> 'Deleted client'
--   the walker's notification, after the purge -> 'Jane Erasure is low on
--     credits' / 'Jane Erasure has 0 credit(s) remaining.'
--
-- Spec 03 says what survives an erasure "carries no readable secret, and no
-- personal data beyond an unsubscribed address". That was false for every
-- client a walker had been notified about.
--
-- ── The fix: record who a notification is about ──────────────────────────
--
-- `subject_client_id` is the client a notification is about, whichever of
-- them it is for. A trigger fills it when the row already says: from
-- `client_id` on a client-facing row, and from the walk on a row that names
-- one. Only a writer whose row carries neither has to set it, and
-- `fn_notify_low_credit` is the one such writer in SQL (below); the Stripe
-- webhook's are in its handler, where the row type now requires the field.
-- The trigger also refuses a subject that belongs to another operator, or
-- that disagrees with the client or the walk the row names, because a wrong
-- subject would make an erasure delete another client's notices and keep
-- this one's.
--
-- The purge then deletes by subject. It still deletes by `client_id` as well,
-- which is the same set once every row has a subject, so that its hold on
-- the client's own inbox does not depend on the trigger having run.
--
-- ── A notice about an erased client is not written ───────────────────────
--
-- Deleting by subject is not enough on its own, because a writer can read a
-- client before an erasure and write after it. The Stripe webhook looks the
-- client up, then inserts "Jane Doe's top-up payment failed"; an erasure
-- committing between the two left that row behind, carrying the name the
-- erasure had just removed (Codex on PR #105). The purge keeps the client
-- row, its id and its operator, so a subject check that asks only whether
-- the client exists passes.
--
-- So the trigger takes the client row FOR KEY SHARE before it reads it. That
-- is the weakest row lock that conflicts with the FOR UPDATE the purge holds
-- on the same row until it commits, so a notice written while an erasure is
-- in flight waits for it, and then reads the erasure's own `purged_at`; a
-- notice written after reads it anyway. Either way, a notice about an erased
-- client is refused here:
--
--   - an INSERT is skipped: the trigger returns NULL, so the statement
--     writes no row and reports no error. The writers are money paths (a
--     refund arriving after an erasure still has to claw its credits back,
--     and a walk the walker finishes still has to be billed), so failing the
--     insert would fail them, and Stripe would redeliver into the same
--     refusal for days. There is nobody left to tell, and the walker's copy
--     would carry what the erasure removed;
--   - an UPDATE that would move an existing row onto an erased client
--     raises instead. No code path does that, and skipping an update
--     silently would report a change it never made.
--
-- The cost, stated: the walker gets no bell for what happens to an erased
-- client's account afterwards, a failed payment or a top-up among them; the
-- Money screen still shows the payment. A refund or dispute alert is not
-- affected, because it records no subject (above).
--
-- The lock takes the walk row first when the notice names one, then the
-- client row: the order 0037 fixed for every function that takes both, and
-- the order the purge takes them in. The foreign key checks on these
-- columns take the same KEY SHARE locks at the end of the statement anyway,
-- in the order of their trigger names, which on a database built from these
-- migrations checks `client_id` before `walk_id` (read off `pg_trigger`
-- locally). Taking them here, first, is what lets the read below see an
-- erasure that was in flight (`concurrency.sh` case 12), and it puts the
-- walk before the client for every insert. The foreign key checks alone put
-- the client first for a client-facing notice that names a walk
-- (complete-walk's "walk complete"), and that deadlocks with an erasure of
-- the same client: measured with a barrier between the two checks against
-- the trigger as first written, the transaction PostgreSQL aborted was the
-- erasure (case 12b).
--
-- ── What is backfilled, and what cannot be ────────────────────────────────
--
-- Existing rows get a subject where the row already records one: its
-- `client_id`, or its walk's client. That is read off a foreign key, not
-- guessed. An operator-facing row with neither (the low-credit notice, the
-- webhook's) is not linked. Matching a name in its text would be a guess
-- that deletes the wrong row when two clients share a name. The low-credit
-- one has a better handle, its client-facing twin, written by the same
-- statement with the same operator, type and `created_at`; but the twin of an
-- ERASED client's row is exactly what the old purge deleted, so joining on it
-- would link only rows about clients who are still live. Production has never
-- run (no production deploy exists), so those rows are staging fixtures, and
-- they stay unlinked.
--
-- Rows about a client erased before this migration, which the old purge
-- missed, are deleted rather than linked (section 2): they are what that
-- erasure should have removed, and the trigger refuses to link a row to an
-- erased client in any case.
--
-- ── Why the FK is RESTRICT ─────────────────────────────────────────────────
--
-- `notifications.client_id` is RESTRICT, and so is this. A client is never
-- deleted by the product: the purge redacts the row, which the ledger keeps
-- referencing, and nothing in the app uses the operator's DELETE grant on
-- `clients`. A hard delete of a client with a notice about them now fails
-- naming the constraint, where a CASCADE would delete the notice quietly, and
-- erasure is the path that removes both.

alter table notifications
  add column subject_client_id uuid references clients(id) on delete restrict;

comment on column notifications.subject_client_id is
  'The client this notification is about, whoever it is for (0057). client_id says who may read it; this says whose erasure removes it.';

create index idx_notifications_subject on notifications (subject_client_id)
  where subject_client_id is not null;

-- ── 1. Fill and check the subject on every write ──────────────────────────
create function fn_notification_subject()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_walk_client uuid;
  v_operator    uuid;
  v_purged_at   timestamptz;
begin
  -- An update that leaves whose row it is, who it is for, what it names and
  -- whom it is about alone is not re-checked. Marking a notification read,
  -- and the send path's claim and outcome writes, have nothing to do with its
  -- subject, and must not fail on a check about it. A change of operator is
  -- re-checked: `trg_notifications_tenant_consistency` lists only client_id
  -- and walk_id, so nothing else would notice a subject left behind under
  -- the old operator.
  if tg_op = 'UPDATE'
     and new.subject_client_id is not distinct from old.subject_client_id
     and new.client_id is not distinct from old.client_id
     and new.walk_id is not distinct from old.walk_id
     and new.operator_id is not distinct from old.operator_id then
    return new;
  end if;

  -- The walk row before the client row (0037), as the purge takes them.
  if new.walk_id is not null then
    select client_id into v_walk_client
      from walks
     where id = new.walk_id
       for key share;
  end if;

  new.subject_client_id := coalesce(new.subject_client_id, new.client_id, v_walk_client);

  if new.subject_client_id is null then
    return new;
  end if;

  if new.client_id is not null and new.subject_client_id <> new.client_id then
    raise exception 'notification subject %: a client-facing notification is about its own client (%)',
      new.subject_client_id, new.client_id;
  end if;
  if v_walk_client is not null and new.subject_client_id <> v_walk_client then
    raise exception 'notification subject %: the walk it names belongs to client %',
      new.subject_client_id, v_walk_client;
  end if;

  -- FOR KEY SHARE waits for an erasure in flight (the purge holds this row
  -- FOR UPDATE until it commits) and then returns the row as the erasure
  -- left it, so `purged_at` below is the erasure's own. It adds no wait the
  -- statement did not already have: the foreign key check on this column
  -- takes the same lock at its end, which waits for anything holding the row
  -- FOR UPDATE, the purge and the credit functions' own row lock alike.
  select c.operator_id, c.purged_at into v_operator, v_purged_at
    from clients c
   where c.id = new.subject_client_id
     for key share;
  if not found or v_operator <> new.operator_id then
    raise exception 'tenant consistency: notification subject must belong to operator';
  end if;

  if v_purged_at is not null then
    if tg_op = 'INSERT' then
      return null;
    end if;
    raise exception 'notification subject %: that client has been erased', new.subject_client_id;
  end if;
  return new;
end;
$$;

-- A trigger function is never called directly (PostgreSQL refuses), and
-- EXECUTE is checked when the trigger is created, not when it fires, so no
-- API role needs it (0053).
revoke all on function fn_notification_subject() from public, anon, authenticated;

-- No `OF` column list: that is evaluated against the columns a statement
-- names, not the row it ends up writing (the 0046 lesson), and the point of
-- the trigger is that a writer need not know it exists.
create trigger trg_notifications_subject
  before insert or update on notifications
  for each row execute function fn_notification_subject();

-- ── 2. Finish the erasures that already happened ─────────────────────────
-- A client erased before this migration kept every walker notice the old
-- purge did not delete. The ones that record the client, by `client_id` or
-- through a walk, are deleted here, as the purge now would. This runs before
-- the backfill because the trigger refuses to link a row to an erased client.
delete from notifications n
 where exists (select 1 from clients c
                where c.purged_at is not null
                  and (c.id = n.client_id
                       or c.id = (select w.client_id from walks w where w.id = n.walk_id)));

-- ── 3. Backfill what the rows already record ──────────────────────────────
-- A row's own `client_id`, or its walk's client: both read off a foreign key.
-- The trigger above runs for these updates too and checks each subject; the
-- `updated_at` trigger also stamps them, which is the one side effect.
update notifications n
   set subject_client_id = coalesce(n.client_id,
                                    (select w.client_id from walks w where w.id = n.walk_id))
 where n.subject_client_id is null
   and (n.client_id is not null or n.walk_id is not null);

-- ── 4. The one SQL writer whose rows record neither ───────────────────────
-- `fn_notify_low_credit` writes the walker's "<name> is low on credits" with
-- no walk, so it names its subject itself. Rebuilt from `pg_get_functiondef`
-- of the live function (0038's body, with 0055's search_path), with that one
-- change; a body written from an older file silently deletes what a later
-- migration added (the 0040 lesson).

create or replace function fn_notify_low_credit(p_client uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_client record;
  v_threshold int;
begin
  if not fn_is_service_session() then
    raise exception 'fn_notify_low_credit: service role required';
  end if;

  select c.id, c.operator_id, c.full_name, c.credit_balance
    into v_client
    from clients c where c.id = p_client;
  if not found then
    raise exception 'fn_notify_low_credit: unknown client %', p_client;
  end if;

  select low_credit_threshold into v_threshold
    from operators where id = v_client.operator_id;

  if v_client.credit_balance > v_threshold then
    return false;
  end if;

  if exists (select 1 from notifications
              where client_id = p_client
                and type = 'low_credit'
                and read_at is null) then
    return false;
  end if;

  insert into notifications (operator_id, client_id, subject_client_id, type, title, body)
  values
    (v_client.operator_id, p_client, p_client, 'low_credit', 'You are low on walk credits',
     'Open your portal to see your balance and top up before your next walk.'),
    (v_client.operator_id, null, p_client, 'low_credit', format('%s is low on credits', v_client.full_name),
     format('%s has %s credit(s) remaining.', v_client.full_name, v_client.credit_balance));

  return true;
end;
$function$;

-- ── 5. The purge deletes by subject ───────────────────────────────────────
-- Rebuilt the same way from the live function (0042's body, with 0055's
-- search_path), with one line changed: notifications go by subject as well
-- as by `client_id`. The rest of the erasure is unchanged. Its FOR UPDATE on
-- the client row is what a notice written meanwhile waits on (section 1), so
-- a notice either commits before that lock and is deleted here, or waits
-- until the erasure commits and is refused.

create or replace function fn_purge_client(p_client uuid)
returns TABLE(storage_path text)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_op uuid := (select auth.uid());
begin
  if not exists (
    select 1 from clients where id = p_client and operator_id = v_op
  ) then
    raise exception 'fn_purge_client: no such client';
  end if;

  -- Walks before clients (0037).
  perform 1 from walks where client_id = p_client order by id for update;
  perform 1 from clients where id = p_client for update;

  delete from walk_gps_points wg
   using walks w where wg.walk_id = w.id and w.client_id = p_client;

  delete from walk_pets wp
   using walks w where wp.walk_id = w.id and w.client_id = p_client;

  delete from schedule_pets sp
   using recurring_schedules rs
   where sp.schedule_id = rs.id and rs.client_id = p_client;

  delete from recurring_schedules where client_id = p_client;
  delete from plan_change_intents where client_id = p_client;
  delete from notifications where client_id = p_client or subject_client_id = p_client;

  -- The credential row is undeletable by design (credential_access_log
  -- RESTRICTs on it and is immutable — 0030). The destroyable thing is the
  -- secret: a 37-byte sentinel that is not a v2 blob, so 0021's key_id
  -- generated column resolves to NULL.
  update access_credentials ac
     set ciphertext = repeat('\000', 37)::bytea,
         label = null,
         revoked_at = coalesce(ac.revoked_at, now())
    from properties p
   where ac.property_id = p.id and p.client_id = p_client;

  update walks set notes = null where client_id = p_client;

  update properties
     set address_line1 = null, address_line2 = null, city = null,
         postcode = null, access_notes_public = null,
         lat = null, lng = null, label = 'Removed'
   where client_id = p_client;

  -- The tombstone moves ABOVE the attempt delete. `purged_at` is what
  -- authorises that delete, so writing it afterwards leaves the purge raising.
  update clients
     set full_name = 'Deleted client',
         email = null,
         phone = null,
         notes = null,
         auth_user_id = null,
         invite_token = gen_random_uuid(),
         unsubscribe_token = gen_random_uuid(),
         invite_revoked_at = now(),
         notice_accepted_at = null,
         notice_version = null,
         status = 'archived',
         purged_at = now()
   where id = p_client;

  -- `attempted_email` is the personal data here — the address somebody used to
  -- try this invite. It goes with the rest of the record.
  delete from invite_claim_attempts where client_id = p_client;

  return query
    select wp.storage_path from walk_photos wp
      join walks w on w.id = wp.walk_id
     where w.client_id = p_client
    union
    select pe.photo_path from pets pe
     where pe.client_id = p_client and pe.photo_path is not null;
end;
$function$;

-- ── 6. Refuse if it did not take ──────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_trigger
                  where tgname = 'trg_notifications_subject'
                    and tgrelid = 'public.notifications'::regclass
                    and not tgisinternal) then
    raise exception '0057: the trigger that records a notification''s subject is missing';
  end if;
  if exists (select 1 from notifications
              where subject_client_id is null
                and (client_id is not null or walk_id is not null)) then
    raise exception '0057: a notification that records its client was left without a subject';
  end if;
  if exists (select 1 from notifications n
               join clients c on c.id = n.subject_client_id
              where c.purged_at is not null) then
    raise exception '0057: a notification about an erased client survived';
  end if;
end $$;
