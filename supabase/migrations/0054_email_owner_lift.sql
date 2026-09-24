-- 0054 — the address owner can turn email back on.
--
-- From the backlog. `0038` made a suppression permanent on purpose: it is
-- somebody asking us to stop, and an operator must never be able to lift one,
-- or the list is worthless. But nobody else could lift one either. A client
-- who unsubscribed from one walker's mail and later hires another gets no
-- email from anyone, forever — not the walk reports, not the billing notices —
-- and `0052`'s notice could only tell the operator so.
--
-- ── What proves an address is yours ──────────────────────────────────────
--
-- The one proof available without Sanpo emailing a suppressed address is the
-- sign-in: a claimed client whose login email, CONFIRMED by GoTrue, is the
-- suppressed address. `email_confirmed_at` is set when someone clicks a link
-- that GoTrue sent to that inbox — a signup confirmation, a magic link, a
-- recovery link — so it says that whoever controls the inbox took part.
-- `claim-signup` creates every client account with `email_confirm: false`,
-- so a client's confirmation is always such a click and never the account's
-- own creation.
--
-- The proof is exactly as strong as the deployed project makes it, and that
-- is stated rather than implied. With email confirmations OFF, GoTrue confirms
-- a public `/signup` account at creation, with no link. An account created
-- that way at a stranger's address that then becomes a client (by claiming an
-- invite, then setting its own contact address, which a client may edit)
-- could lift the stranger's suppression. That is the same setting owner action
-- 16 already names for the claim flow, where the same guess is a takeover of
-- the client portal, and this is a smaller consequence of it added to that
-- entry. Changing an existing account's address is not a way round it: GoTrue
-- confirms a new address through its inbox for every account that is not
-- anonymous (`internal/api/user.go`, read on `master`), and anonymous sign-ins
-- are off. With confirmations ON, a login at an address is usable only after
-- that inbox's link is clicked; a magic or recovery link confirms it too
-- (`recoverVerify` in `internal/api/verify.go`).
--
-- A shared login proves what a login proves: whoever holds it holds the inbox
-- it was confirmed at, so lifting as that login is the inbox's decision.
--
-- ── What a lift removes, and what it leaves ─────────────────────────────
--
-- Only the rows one-click unsubscribe writes: platform-wide
-- (`operator_id is null`) and every-type (`notification_type is null`), for
-- the one address. An operator-scoped row ("stop from this business") or a
-- typed row ("no walk_complete") is a narrower preference, and turning email
-- back on in general is not the same decision; nothing writes either kind
-- today, and the status below reports such a suppression as one this cannot
-- lift rather than pretending otherwise. A later one-click unsubscribe inserts
-- a fresh row, so a lift never weakens the next opt-out.
--
-- ── Whether a lift is logged ─────────────────────────────────────────────
--
-- Yes. A lift is consent to receive mail at an address that once asked us to
-- stop, and if it is ever disputed, "which account turned it back on, and
-- when" must have an answer. Each removed row is copied into
-- `email_suppression_lifts` in the same statement that deletes it, with when
-- the suppression was made and why. The table holds the address and the
-- account id and nothing else. No operator reads it: it belongs to the address,
-- not to a tenant. `lifted_by` is deliberately not a foreign key: an account
-- deleted later must not be blocked by the record of what it once did — the
-- claim replay's undeletable fixtures are what a RESTRICT into auth.users costs.
--
-- ── What erasure does to it ──────────────────────────────────────────────
--
-- An erased client's lift records are deleted with the rest of the record
-- (section 6). `fn_purge_client` already destroys the consent record kept on
-- the client row (`notice_accepted_at`, 0041), and the privacy notice lists
-- what survives an erasure; this is not on it. The suppression list itself is
-- NOT touched, as it never was: it is the address owner's instruction to stop,
-- and erasing a record must never start email to an address again.
--
-- ── One decision, two readers ────────────────────────────────────────────
--
-- The portal asks `fn_my_email_status()` whether to offer the lift, and
-- `fn_lift_my_email_suppression()` performs it. Both read one decision,
-- `fn_email_lift_decision`, so the button cannot be offered for a lift that
-- would be refused, or refused for one it offered. The lift deletes the
-- address the decision validated, not a second read of the row, because the
-- contact address can change between two statements and only the validated
-- one was proven.
--
-- ── One aggregation, both notices ────────────────────────────────────────
--
-- "Every email the sender would send to this address is suppressed" was
-- written once, inside `0052`'s operator function. The client's notice needs
-- the same answer, and two copies of a predicate is the drift this repository
-- keeps paying for, so it moves into `fn_email_fully_suppressed` and `0052`'s
-- function calls it. The operator's notice and the client's cannot disagree.
--
-- ── search_path ─────────────────────────────────────────────────────────
--
-- The new functions set `public, pg_temp`, the form PostgreSQL's documentation
-- recommends and the backlog's TEMP and `search_path` item will move every
-- definer function to: it searches temp tables last.
-- `fn_client_email_suppressed` keeps `public`, which smoke pins for it; that
-- item moves it with the rest.

-- ── 1. The aggregation both notices share ────────────────────────────────
create function fn_email_fully_suppressed(p_email text, p_operator uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  -- The sender's own question (`fn_email_suppressed`, 0038), asked once for
  -- every type it emails (`fn_client_facing_notification_types`, 0052).
  select coalesce((
    select bool_and(fn_email_suppressed(p_email, p_operator, t.value))
      from unnest(fn_client_facing_notification_types()) as t(value)
  ), false);
$$;

-- Not a definer: it runs as whichever definer function calls it. No API role
-- needs it directly.
revoke all on function fn_email_fully_suppressed(text, uuid) from public, anon, authenticated;

comment on function fn_email_fully_suppressed(text, uuid) is
  'Whether every email send-notification would send to this address, for this operator, is suppressed. The one copy of that rule; fn_client_email_suppressed and fn_email_lift_decision both call it (0054).';

-- `0052`'s operator notice, re-pointed at the shared rule. Built from
-- `pg_get_functiondef` of the live function, not from 0052's text, with one
-- expression changed; the signature, `security definer` and `search_path` are
-- the ones it had, and `create or replace` keeps its grants and comment.
create or replace function fn_client_email_suppressed(p_client uuid)
returns table (o_email text, o_suppressed boolean)
language sql
stable
security definer
set search_path = public
as $$
  select c.email, fn_email_fully_suppressed(c.email, c.operator_id)
    from clients c
   where c.id = p_client
     -- The caller check IS the scoping. Only the client's own operator may
     -- ask; a client persona, another operator or an unknown id gets no row.
     and c.operator_id = (select auth.uid())
     and c.email is not null;
$$;

-- ── 2. The record of a lift ──────────────────────────────────────────────
create table email_suppression_lifts (
  id uuid primary key default gen_random_uuid(),
  -- The address, in the canonical form email_suppressions stores it.
  email text not null check (email = lower(email) and position('@' in email) > 1),
  -- The account that lifted it. Not a foreign key: see the header.
  lifted_by uuid not null,
  lifted_at timestamptz not null default now(),
  -- The suppression that was removed: when it was made, and why.
  suppressed_at timestamptz not null,
  suppression_reason text not null
);

create index idx_email_suppression_lifts_email on email_suppression_lifts (email);
-- The erasure trigger (section 6) deletes by account.
create index idx_email_suppression_lifts_lifted_by on email_suppression_lifts (lifted_by);

alter table email_suppression_lifts enable row level security;
alter table email_suppression_lifts force row level security;
-- No policies and no API grants, like email_suppressions. The lift function
-- writes it as its owner; the service role may read it to answer a dispute.
-- Not a tenant table (invariant 7 does not apply): the address belongs to no
-- operator.
revoke all on email_suppression_lifts from public, anon, authenticated;
grant select on email_suppression_lifts to service_role;

comment on table email_suppression_lifts is
  'Suppressions an address owner removed by turning email back on: the address, the account that did it, and the suppression it replaced. The consent record for mailing an address that once asked us to stop; deleted when that account''s client is erased (0054).';

-- ── 3. The decision ──────────────────────────────────────────────────────
-- One row for the account's client, or none when the account is not a
-- claimed, unerased client. `o_email` is the contact address the decision is
-- about. States, in the order they are decided:
--   no_address        the client has no email address
--   not_suppressed    email to it is not fully off, so there is nothing to lift
--   not_liftable      it is off, but not by a row a lift removes
--   not_login_address it is not the address this account signs in with
--   not_confirmed     it is, but GoTrue has not confirmed it
--   ready             the lift will remove it
--
-- The suppression checks compare the address exactly as the sender does:
-- lowercased, not trimmed (`fn_email_suppressed`, 0038), which is also how
-- one-click stores it. The sign-in comparison trims as well, as the claim
-- ladders do, because whitespace around an address is not part of it.
create function fn_email_lift_decision(p_user uuid)
returns table (o_state text, o_email text)
language sql
stable
set search_path = public, pg_temp
as $$
  select case
           when c.email is null then 'no_address'
           when not fn_email_fully_suppressed(c.email, c.operator_id) then 'not_suppressed'
           when not exists (
             select 1 from email_suppressions s
              where s.email = lower(c.email)
                and s.operator_id is null
                and s.notification_type is null
           ) then 'not_liftable'
           when u.email is null
             or lower(trim(u.email)) <> lower(trim(c.email)) then 'not_login_address'
           when u.email_confirmed_at is null then 'not_confirmed'
           else 'ready'
         end,
         c.email
    from clients c
    left join auth.users u on u.id = c.auth_user_id
   where c.auth_user_id = p_user
     -- The purge nulls auth_user_id, so no login reaches an erased row today.
     -- Stated here too, so the rule does not rest on that.
     and c.purged_at is null;
$$;

revoke all on function fn_email_lift_decision(uuid) from public, anon, authenticated;

comment on function fn_email_lift_decision(uuid) is
  'Whether this account''s client may turn email back on for its contact address, and if not why. Read by both fn_my_email_status and fn_lift_my_email_suppression, so the offer and the lift cannot disagree (0054).';

-- ── 4. What the portal asks ──────────────────────────────────────────────
create function fn_my_email_status()
returns table (o_email text, o_state text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- The caller is the scope: auth.uid() picks the one client row this account
  -- is bound to (clients.auth_user_id is unique), and nothing else is asked.
  select d.o_email, d.o_state from fn_email_lift_decision((select auth.uid())) d;
$$;

revoke all on function fn_my_email_status() from public, anon, authenticated;
grant execute on function fn_my_email_status() to authenticated;

comment on function fn_my_email_status() is
  'For the calling client: its contact address, and whether email to it is off and can be turned back on from this account (a state from fn_email_lift_decision). No row for an account that is not a claimed client (0054).';

-- ── 5. The lift ──────────────────────────────────────────────────────────
-- Refusals are returned, not raised: they are answers the portal shows, and
-- nothing here is written on the way to one.
create function fn_lift_my_email_suppression()
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := (select auth.uid());
  v_state text;
  v_email text;
  v_lifted int;
begin
  select d.o_state, d.o_email into v_state, v_email
    from fn_email_lift_decision(v_user) d;
  if not found then
    return 'not_client';
  end if;
  if v_state <> 'ready' then
    return v_state;
  end if;

  -- The address the decision validated, not a second read of the row, and
  -- compared as the sender compares it.
  with lifted as (
    delete from email_suppressions s
     where s.email = lower(v_email)
       and s.operator_id is null
       and s.notification_type is null
    returning s.email, s.created_at, s.reason
  )
  insert into email_suppression_lifts (email, lifted_by, suppressed_at, suppression_reason)
  select l.email, v_user, l.created_at, l.reason from lifted l;
  get diagnostics v_lifted = row_count;

  -- Zero here means another request lifted it between the decision and the
  -- delete: the address is no longer suppressed by a row this removes.
  return case when v_lifted > 0 then 'lifted' else 'not_suppressed' end;
end $$;

revoke all on function fn_lift_my_email_suppression() from public, anon, authenticated;
grant execute on function fn_lift_my_email_suppression() to authenticated;

comment on function fn_lift_my_email_suppression() is
  'Turns email back on for the calling client''s contact address when it is the address the account signs in with and GoTrue has confirmed it: removes the platform-wide one-click suppression and records the lift in email_suppression_lifts. Returns lifted, or the reason it did not (0054).';

-- ── 6. An erased client's lifts go with them ─────────────────────────────
-- A trigger, as 0049's `fn_forget_purged_push_subscriptions` is, rather than
-- another `create or replace` of `fn_purge_client`: a purge path written later
-- gets this without knowing the rule exists, and the purge is not rebuilt from
-- a body that could drop what a later migration added to it (the 0040 lesson).
--
-- Keyed on the account that lifted. The purge nulls `auth_user_id` in the same
-- UPDATE that sets `purged_at`, so OLD still names the account. AFTER, with the
-- WHEN clause reading the final row image, for 0049's reasons: a BEFORE
-- trigger sees the image only as it stands when it runs, and `update of
-- purged_at` is evaluated against the columns the statement names.
create function fn_forget_purged_email_lifts() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.auth_user_id is not null then
    delete from email_suppression_lifts where lifted_by = old.auth_user_id;
  end if;
  return null;
end $$;

revoke all on function fn_forget_purged_email_lifts() from public, anon, authenticated;

create trigger trg_clients_forget_email_lifts
  after update on clients
  for each row
  when (old.purged_at is null and new.purged_at is not null)
  execute function fn_forget_purged_email_lifts();

-- An inert trigger that deployed cleanly is worse than a failed deploy: the
-- erasure would silently not erase, and nothing would say so (the 0028 rule).
do $$
begin
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'clients'::regclass
       and tgname = 'trg_clients_forget_email_lifts'
       and not tgisinternal
  ) then
    raise exception '0054: the erasure trigger was not installed — refusing';
  end if;
end $$;
