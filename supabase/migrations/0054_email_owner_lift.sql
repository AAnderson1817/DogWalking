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
-- Control of the inbox NOW, shown by the session the request arrives on. The
-- lift is offered only to a claimed client whose sign-in address is the
-- suppressed address and whose current session began with a link GoTrue sent
-- to that address, opened AFTER the address last asked us to stop. Sanpo
-- never emails a suppressed address itself: GoTrue's sign-in mail does not go
-- through the sender, so the link still arrives.
--
-- GoTrue records how a session began in the access token's `amr` claim, one
-- entry per method with the time it was used (auth-js `AMREntry`: `method`,
-- `timestamp` in epoch seconds). Opening an emailed link, or typing an
-- emailed code, records `otp` in the implicit flow this app uses
-- (`internal/api/verify.go`, both `verifyGet` and `verifyPost`) and
-- `magiclink`, `recovery`, `email/signup`, `invite` or `email_change` in the
-- PKCE flow (`ParseAuthenticationMethod` of the link's type). Refreshing a
-- token rebuilds the claim from the session's stored entries without
-- restamping them (`internal/tokens/service.go`: the refresh grant calls
-- `GenerateAccessToken`, which reads `CalculateAALAndAMR`; only a new session
-- or an MFA step adds an entry). So an entry of one of those methods dated
-- after the address's latest request to stop says the holder of this session
-- opened a link from that inbox after that request. All read on GoTrue
-- `master`.
--
-- The first version of this file proved ownership with `email_confirmed_at`,
-- and a review showed why that is not enough. A confirmation is history: it
-- says someone opened the inbox once, possibly years before the unsubscribe.
-- A mailbox that changed hands keeps its confirmation, so the account that
-- confirmed it long ago could lift the new holder's unsubscribe, and lift it
-- again after every unsubscribe that followed. It also rested on a dashboard
-- setting: with email confirmations off, GoTrue confirms a public `/signup`
-- account at creation with no click, and a magic-link request confirms any
-- unconfirmed account the same way (`magic_link.go` routes one through
-- `Signup`). The session proof rests on neither. An account confirmed without
-- a click still has to open a link sent to that inbox before it can lift,
-- and a password, a TOTP code or an anonymous sign-in is not such a link.
--
-- What it still assumes, stated rather than implied:
--   - `otp` also records an SMS code (`verifyPost`, `smsVerification`), so an
--     account that could add and verify a phone number would get a fresh
--     `otp` entry without opening the inbox. No SMS provider is enabled in
--     `config.toml`; the deployed projects' setting is not measured from here.
--   - A GoTrue admin email change (the dashboard, or the service role) moves
--     the sign-in address without a link and without touching an existing
--     session, whose entry then describes a different inbox. Nothing in this
--     repository changes a sign-in address that way; the session timebox
--     bounds how long such a session lives.
--   - A shared login proves what the session proves: whoever opened that
--     link could read that inbox, and lifting is that inbox's decision.
--   - The entry is dated when the link was OPENED, not when it was read.
--     Someone who read a link in that inbox before the unsubscribe and opens
--     it after would pass. The link's lifetime bounds that window
--     (`otp_expiry`, one hour in `config.toml`; the deployed setting is not
--     measured from here).
--
-- `email_confirmed_at` is still read. A link session implies it, so it only
-- matters when it is missing, and then the remedy differs: an unconfirmed
-- account's magic-link request goes through `Signup`, which a closed signup
-- refuses, while a password reset link is not gated on signup and confirms
-- the address (`recoverVerify`). So `not_confirmed` is its own answer.
--
-- ── What a lift removes, and what it leaves ─────────────────────────────
--
-- Only the row one-click unsubscribe writes: platform-wide (`operator_id is
-- null`), every type (`notification_type is null`), with the reason
-- `fn_unsubscribe_by_token` gives it (`'one-click unsubscribe'`, 0038). The
-- reason is part of the match. A platform-wide, every-type row written for
-- any other reason, such as a bounce, a complaint or a manual block, none of
-- which exists yet, is not a lift's to remove. Because the unique index
-- treats NULLs as equal, there is at most one such row per address.
--
-- And only when that row is ALL that keeps this client's email off. A row
-- that also applies, either the client's own operator's stop or a typed row
-- for a type the sender emails, is a narrower preference that turning email
-- back on in general does not decide. The answer then is `not_liftable`,
-- not a `lifted` that leaves some email off. That keeps the portal's
-- confirmation true: after a lift, nothing the sender consults suppresses
-- this address for this client's operator. The "also applies" test restates
-- the sender's own match (`fn_email_suppressed`, 0038): same operator scope,
-- same type scope. Smoke ties the two by asking the sender after every lift.
--
-- ── Every opt-out moves the boundary ────────────────────────────────────
--
-- The link has to be newer than the address's LATEST request to stop, not
-- its first. One-click used to write its row once and do nothing when asked
-- again (`on conflict do nothing`, 0038), so the row kept the time of the
-- first request, and a session whose link was opened between two requests
-- could undo the second (Codex on #101). One-click now records every request
-- in `last_requested_at`: a new row gets it when inserted, and a repeated
-- request moves it on the row already there. The row's reason, and when it
-- was first made, are kept. Rows that existed before this migration read the
-- migration's own time, which is later than any request they record: lifting
-- one needs a link opened after this migration. That is the safe direction,
-- and the only one available, because the requests `do nothing` swallowed
-- cannot be recovered.
--
-- The lift checks the boundary again in the statement that deletes the row,
-- not only in the decision. A repeated request that lands between the two
-- holds the row until it commits. The delete waits for it, reads the row it
-- wrote, and leaves it; the lift then answers a fresh decision
-- (`needs_link_sign_in`). `concurrency.sh` case 11c.
--
-- ── Whether a lift is logged ─────────────────────────────────────────────
--
-- Yes. A lift is consent to receive mail at an address that once asked us to
-- stop, and if it is ever disputed, "which account turned it back on, and
-- when" must have an answer. Each removed row is copied into
-- `email_suppression_lifts` in the same statement that deletes it. The row
-- holds the address, the client it was lifted for, the account that lifted
-- it, when, and when and why the removed suppression was made and when the
-- address last asked us to stop. No operator
-- reads it: it belongs to the address, not to a tenant. `lifted_by` is
-- deliberately not a foreign key: an account deleted later must not be
-- blocked by the record of what it once did, and the claim replay's
-- undeletable fixtures are what a RESTRICT into auth.users costs. The service
-- role may read it and nothing else: the platform's default privileges would
-- otherwise let any service-role path rewrite the consent record.
--
-- ── What erasure does to it ──────────────────────────────────────────────
--
-- An erased client's lift records are deleted with the rest of the record
-- (section 6), keyed on the CLIENT, as 0049's devices are. The first version
-- keyed them on the account, which missed a lift made before the operator
-- released the account (`fn_unbind_invite` nulls `auth_user_id`, so the
-- erasure found nobody), and deleted another client's record when the same
-- account had since been bound elsewhere. `fn_purge_client` already destroys
-- the consent record kept on the client row (`notice_accepted_at`, 0041). The
-- suppression list itself is NOT touched, as it never was: it is the address
-- owner's instruction to stop, and erasing a record must never start email
-- to an address again.
--
-- ── A lift and an erasure do not interleave ──────────────────────────────
--
-- The lift takes the client row `for no key update` before it decides, as
-- 0049's registration does. The first version took no lock, and a review
-- measured a lift and an erasure of the same client failing to serialize in
-- either order: a lift committing after the erasure's trigger had run left
-- its record behind, and a lift reading the row while the erasure was in
-- flight lifted for a client being erased. With the lock, whichever comes
-- second waits: a lift after an erasure finds no account on the row and
-- answers `not_client`, and an erasure after a lift deletes the lift's
-- record. (This version's foreign key to the client already makes an
-- erasure wait behind a lift, through the key-share check the record's
-- insert takes; a lift behind an erasure needs the lock. `concurrency.sh`
-- case 11 shows both.)
-- Lock order: this function takes clients, then email_suppressions, then
-- email_suppression_lifts. The purge takes walks, then clients, then the lift
-- rows through its trigger, and never touches email_suppressions. Both take
-- clients before the lift rows, so there is no cycle (0037).
--
-- ── What a client can learn ──────────────────────────────────────────────
--
-- The status names the client's own contact address, and a client may edit
-- that field (`clients_self_update`). So, like the operator with 0052's
-- notice, a client can learn whether any address it saves there is
-- suppressed. What bounds that is how little comes back: one state, with no
-- business, no date and no reason, the argument 0052 makes for the operator.
--
-- ── One decision, two readers ────────────────────────────────────────────
--
-- The portal asks `fn_my_email_status()` whether to offer the lift, and
-- `fn_lift_my_email_suppression()` performs it. Both read one decision,
-- `fn_email_lift_decision`, so the button cannot be offered for a lift that
-- would be refused, or refused for one it offered. The lift deletes the
-- address the decision validated, not a second read of the row, and answers
-- with that address, so the portal names the address the lift was about.
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

-- ── 0. When the address last asked us to stop ───────────────────────────
-- A default, not a backfill: an existing row reads this migration's time,
-- later than any request it records (the header says why that is the safe
-- direction). `now()` is STABLE, so it is evaluated once and stored as the
-- column's missing value; the table is not rewritten.
alter table email_suppressions
  add column last_requested_at timestamptz not null default now();

comment on column email_suppressions.last_requested_at is
  'When the address last asked us to stop through this row. One-click moves it on every request, including a repeated one that finds the row already there; a lift must be newer than it (0054). Rows older than 0054 read the migration''s time.';

-- `0038`'s one-click writer, with one clause changed: a repeated request
-- moves `last_requested_at` instead of doing nothing. Built from
-- `pg_get_functiondef` of the live function, not from 0038's text; the
-- signature, `security definer` and `search_path` are the ones it had, and
-- `create or replace` keeps its grants (0050's to service_role) and comment.
create or replace function fn_unsubscribe_by_token(p_token uuid)
returns table (o_applied boolean, o_email text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  if not fn_is_service_session() then
    raise exception 'fn_unsubscribe_by_token: service role required';
  end if;

  select lower(c.email) into v_email
    from clients c
   where c.unsubscribe_token = p_token
     and c.email is not null;

  -- Deliberately NOT an error, and deliberately indistinguishable from a
  -- token that does exist. An unauthenticated endpoint that says "no such
  -- token" is an oracle for guessing them, and a person who clicks
  -- unsubscribe twice should see the same thing both times.
  if v_email is null then
    return query select false, null::text;
    return;
  end if;

  insert into email_suppressions (email, operator_id, notification_type, reason)
  values (v_email, null, null, 'one-click unsubscribe')
  -- A repeated request is still a request: it moves the time the address last
  -- asked us to stop, which a lift must be newer than (0054). The row, its
  -- reason and when it was first made are kept, so a second click still
  -- writes no second row.
  on conflict (email, operator_id, notification_type)
  do update set last_requested_at = now();

  return query select true, v_email;
end $$;

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
  -- The client it was lifted for: what the erasure trigger (section 6) keys
  -- on. A lift needs a claimed client, and a claimed client can never be
  -- deleted (0039's attempt rows restrict it), so the cascade only states the
  -- relationship.
  client_id uuid not null references clients (id) on delete cascade,
  -- The account that lifted it. Not a foreign key: see the header.
  lifted_by uuid not null,
  lifted_at timestamptz not null default now(),
  -- The suppression that was removed: when it was made, when the address
  -- last asked us to stop (the boundary the lift was checked against), and
  -- why.
  suppressed_at timestamptz not null,
  last_requested_at timestamptz not null,
  suppression_reason text not null
);

create index idx_email_suppression_lifts_email on email_suppression_lifts (email);
create index idx_email_suppression_lifts_client on email_suppression_lifts (client_id);

alter table email_suppression_lifts enable row level security;
alter table email_suppression_lifts force row level security;
-- No policies and no API grants, like email_suppressions. The lift function
-- writes it as its owner and the erasure trigger deletes from it as its
-- owner. The service role may only read it, to answer a dispute: the
-- platform's default privileges grant it everything on a new table, so the
-- revoke names it too. Not a tenant table (invariant 7 does not apply): the
-- address belongs to no operator, the 0048 precedent for a client-keyed log.
revoke all on email_suppression_lifts from public, anon, authenticated, service_role;
grant select on email_suppression_lifts to service_role;

comment on table email_suppression_lifts is
  'Suppressions an address owner removed by turning email back on: the address, the client it was for, the account that did it, and the suppression it replaced. The consent record for mailing an address that once asked us to stop; deleted when that client is erased (0054).';

-- ── 3. The decision ──────────────────────────────────────────────────────
-- Whether a session's `amr` shows an emailed link or code opened after
-- `p_since` (the header says which methods and why). Anything unreadable is
-- no evidence: a missing claim, a claim that is not an array, an entry that
-- is not an object or whose timestamp is not a number.
create function fn_amr_has_email_link_since(p_amr jsonb, p_since timestamptz)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce((
    select bool_or(to_timestamp((e ->> 'timestamp')::double precision) > p_since)
      from jsonb_array_elements(
             case when jsonb_typeof(p_amr) = 'array' then p_amr else '[]'::jsonb end
           ) as e
     where jsonb_typeof(e) = 'object'
       and e ->> 'method' in ('otp', 'magiclink', 'recovery', 'email/signup', 'invite', 'email_change')
       and jsonb_typeof(e -> 'timestamp') = 'number'
  ), false);
$$;

revoke all on function fn_amr_has_email_link_since(jsonb, timestamptz) from public, anon, authenticated;

comment on function fn_amr_has_email_link_since(jsonb, timestamptz) is
  'Whether an access token''s amr claim records an emailed link or code opened after the given time. The proof of current inbox control fn_email_lift_decision asks for (0054).';

-- One row for the account's client, or none when the account is not a
-- claimed, unerased client. `o_email` is the contact address the decision is
-- about. States, in the order they are decided:
--   no_address          the client has no email address
--   not_suppressed      email to it is not fully off, so there is nothing to lift
--   not_liftable        it is off, but not by the one-click row alone
--   not_login_address   it is not the address this account signs in with
--   not_confirmed       it is, but GoTrue has not confirmed it
--   needs_link_sign_in  this session did not begin with a link sent to it
--                       and opened after the latest unsubscribe
--   ready               the lift will remove it
--
-- The suppression checks compare the address exactly as the sender does:
-- lowercased, not trimmed (`fn_email_suppressed`, 0038), which is also how
-- one-click stores it. The sign-in comparison trims as well, as the claim
-- ladders do, because whitespace around an address is not part of it.
create function fn_email_lift_decision(p_user uuid, p_amr jsonb)
returns table (o_state text, o_email text, o_client uuid)
language sql
stable
set search_path = public, pg_temp
as $$
  select case
           when c.email is null then 'no_address'
           when not fn_email_fully_suppressed(c.email, c.operator_id) then 'not_suppressed'
           -- No row that one-click wrote: nothing here is a lift's to remove.
           when g.last_requested_at is null then 'not_liftable'
           -- Another row that also applies to this client's email: the
           -- sender's own match, without the one-click row.
           when exists (
             select 1 from email_suppressions s
              where s.email = lower(c.email)
                and (s.operator_id is null or s.operator_id = c.operator_id)
                and (s.notification_type is null
                     or s.notification_type = any (fn_client_facing_notification_types()))
                and not (s.operator_id is null and s.notification_type is null)
           ) then 'not_liftable'
           when u.email is null
             or lower(trim(u.email)) <> lower(trim(c.email)) then 'not_login_address'
           when u.email_confirmed_at is null then 'not_confirmed'
           when not fn_amr_has_email_link_since(p_amr, g.last_requested_at) then 'needs_link_sign_in'
           else 'ready'
         end,
         c.email,
         c.id
    from clients c
    left join auth.users u on u.id = c.auth_user_id
    left join lateral (
      select s.last_requested_at
        from email_suppressions s
       where s.email = lower(c.email)
         and s.operator_id is null
         and s.notification_type is null
         and s.reason = 'one-click unsubscribe'
    ) g on true
   where c.auth_user_id = p_user
     -- The purge nulls auth_user_id, so no login reaches an erased row today.
     -- Stated here too, so the rule does not rest on that.
     and c.purged_at is null;
$$;

revoke all on function fn_email_lift_decision(uuid, jsonb) from public, anon, authenticated;

comment on function fn_email_lift_decision(uuid, jsonb) is
  'Whether this account''s client may turn email back on for its contact address, given the session''s amr claim, and if not why. Read by both fn_my_email_status and fn_lift_my_email_suppression, so the offer and the lift cannot disagree (0054).';

-- ── 4. What the portal asks ──────────────────────────────────────────────
create function fn_my_email_status()
returns table (o_email text, o_state text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- The caller is the scope: auth.uid() picks the one client row this account
  -- is bound to (clients.auth_user_id is unique), and the session's own token
  -- supplies the amr. Nothing is taken from the caller as an argument.
  select d.o_email, d.o_state
    from fn_email_lift_decision((select auth.uid()), (select auth.jwt()) -> 'amr') d;
$$;

revoke all on function fn_my_email_status() from public, anon, authenticated;
grant execute on function fn_my_email_status() to authenticated;

comment on function fn_my_email_status() is
  'For the calling client: its contact address, and whether email to it is off and can be turned back on from this session (a state from fn_email_lift_decision). No row for an account that is not a claimed client (0054).';

-- ── 5. The lift ──────────────────────────────────────────────────────────
-- Refusals are returned, not raised: they are answers the portal shows, and
-- nothing here is written on the way to one. Every answer carries the
-- address it is about, or null when there is no client.
create function fn_lift_my_email_suppression()
returns table (o_result text, o_email text)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := (select auth.uid());
  -- Read once: the decision and the delete judge the same session.
  v_amr jsonb := (select auth.jwt()) -> 'amr';
  v_client uuid;
  v_state text;
  v_email text;
  v_lifted int;
begin
  -- Held until the lift commits, so an erasure of this client waits for it,
  -- or it waits for the erasure and finds no row: the purge nulls
  -- auth_user_id, and the re-check after the wait reads the new row (the
  -- header's section on interleaving). The erased-row rule itself is the
  -- decision's, which states it rather than resting on that.
  select c.id into v_client
    from clients c
   where c.auth_user_id = v_user
     for no key update;
  if not found then
    return query select 'not_client'::text, null::text;
    return;
  end if;

  select d.o_state, d.o_email into v_state, v_email
    from fn_email_lift_decision(v_user, v_amr) d
   where d.o_client = v_client;
  if not found then
    return query select 'not_client'::text, null::text;
    return;
  end if;
  if v_state <> 'ready' then
    return query select v_state, v_email;
    return;
  end if;

  -- The address the decision validated, not a second read of the row, and
  -- compared as the sender compares it; the row one-click wrote, by shape
  -- and by reason, as the decision matched it; and only while this session's
  -- link is still newer than the address's latest request. That last test is
  -- repeated here because a repeated one-click request can land between the
  -- decision and this statement: it holds the row until it commits, so this
  -- delete waits, re-reads the row it wrote, and leaves it (the header's
  -- section on the boundary; `concurrency.sh` case 11c).
  with lifted as (
    delete from email_suppressions s
     where s.email = lower(v_email)
       and s.operator_id is null
       and s.notification_type is null
       and s.reason = 'one-click unsubscribe'
       and fn_amr_has_email_link_since(v_amr, s.last_requested_at)
    returning s.email, s.created_at, s.last_requested_at, s.reason
  )
  insert into email_suppression_lifts
    (email, client_id, lifted_by, suppressed_at, last_requested_at, suppression_reason)
  select l.email, v_client, v_user, l.created_at, l.last_requested_at, l.reason
    from lifted l;
  get diagnostics v_lifted = row_count;

  if v_lifted > 0 then
    return query select 'lifted'::text, v_email;
    return;
  end if;

  -- Nothing was removed, so the row changed between the decision and the
  -- delete: it went, or a repeated request moved it past this session's link.
  -- The client row is held, so not by another lift for this client or by an
  -- edit of the address. Decide again and answer that, rather than a state
  -- from before the change.
  select d.o_state into v_state
    from fn_email_lift_decision(v_user, v_amr) d
   where d.o_client = v_client;
  return query select coalesce(v_state, 'not_client'), v_email;
end $$;

revoke all on function fn_lift_my_email_suppression() from public, anon, authenticated;
grant execute on function fn_lift_my_email_suppression() to authenticated;

comment on function fn_lift_my_email_suppression() is
  'Turns email back on for the calling client''s contact address when it is the address the account signs in with and this session began with a link sent to it and opened after the latest unsubscribe: removes the one-click suppression and records the lift in email_suppression_lifts. Answers lifted, or the reason it did not, with the address it was about (0054).';

-- ── 6. An erased client's lifts go with them ─────────────────────────────
-- A trigger, as 0049's `fn_forget_purged_push_subscriptions` is, rather than
-- another `create or replace` of `fn_purge_client`: a purge path written later
-- gets this without knowing the rule exists, and the purge is not rebuilt from
-- a body that could drop what a later migration added to it (the 0040 lesson).
--
-- Keyed on the client (the header says why not the account). AFTER, with the
-- WHEN clause reading the final row image, for 0049's reasons: a BEFORE
-- trigger sees the image only as it stands when it runs, and `update of
-- purged_at` is evaluated against the columns the statement names.
create function fn_forget_purged_email_lifts() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from email_suppression_lifts where client_id = new.id;
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
