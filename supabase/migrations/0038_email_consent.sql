-- 0038 — a person who never asked for this email can stop it.
--
-- Review M29. `clients.email` is typed by the operator into the Roster form
-- and is never reconciled with anything. There is no consent record, no
-- opt-out, no unsubscribe link, and the Resend payload carries no headers at
-- all — so no `List-Unsubscribe` pair either.
--
-- One typo therefore sends a stranger a recurring feed of `walk_complete`
-- notifications: when a named person's house is empty, several times a week,
-- with no way to make it stop and nobody to tell. The `low_credit` body goes
-- further and states the client's credit balance in the message itself.
--
-- ── Suppression is keyed on the ADDRESS, not the client ──────────────────
--
-- This is the whole design decision. The wrong recipient has no relationship
-- to any row here: they are not the client, they did not claim an invite, and
-- the operator may not realise the address is wrong. Suppressing "this client"
-- would let the same address start receiving again the moment the operator
-- corrects and re-enters it, or adds the person again as a second client.
-- Suppressing the ADDRESS is what actually holds.
--
-- ── Why the platform is the sender that has to care ─────────────────────
--
-- These are transactional messages, and one solo operator will never approach
-- Gmail's bulk-sender thresholds. But every operator sends from ONE shared
-- identity — `notifications@sanpocare.com` — so the reputation, the complaint
-- rate and the volume are the platform's, aggregated. Sanpo is the bulk
-- sender even when no operator is.

-- ── 1. The token that makes an unauthenticated one-click possible ────────
-- A recipient who is not a client cannot sign in, so the unsubscribe link
-- cannot require a session. A per-client random token is unguessable, is
-- carried only in mail already addressed to that person, and can be rotated
-- by re-issuing it without touching anything else.
alter table clients
  add column unsubscribe_token uuid not null default gen_random_uuid();

create unique index uq_clients_unsubscribe_token on clients (unsubscribe_token);

comment on column clients.unsubscribe_token is
  'Unguessable token carried in the List-Unsubscribe URL, so a recipient with no account can still opt out (review M29). Withheld from the API roles by column privilege.';

-- The token is a bearer credential for "stop emailing this address", and
-- `listClients()` selects `*` — so without this it would be shipped to the
-- browser for every client on the roster, where one XSS could mass-unsubscribe
-- an operator's entire book from the proof-of-service emails their clients
-- rely on.
--
-- A column-level REVOKE is NOT enough on its own: `0004` grants table-level
-- SELECT on clients, which covers every column including ones added later, and
-- a column REVOKE against a table-level grant is a no-op. (Confirmed by
-- writing the REVOKE first and watching the smoke assertion still read the
-- token as `authenticated`.) So the table grant goes and an explicit column
-- list replaces it — the same shape invariant 2 uses for the vault ciphertext,
-- which is why `access_credentials` never had a table-level SELECT either.
--
-- This is fail-closed for future columns: a column added to `clients` will not
-- be selectable until it is granted here. That is the safe direction, and the
-- smoke suite names it explicitly so the failure is a sentence rather than a
-- 42501 from PostgREST.
revoke select on clients from anon, authenticated;
grant select (
  id, operator_id, auth_user_id, full_name, email, phone, status, notes,
  invite_token, stripe_customer_id, plan_id, subscription_status,
  stripe_subscription_id, credit_balance, created_at, updated_at,
  current_period_end
) on clients to authenticated;

-- ── 2. Suppression ───────────────────────────────────────────────────────
create table email_suppressions (
  id uuid primary key default gen_random_uuid(),
  -- Lowercased at the door rather than compared case-insensitively at every
  -- read: one canonical form means the unique index below is the whole rule.
  email text not null check (email = lower(email) and position('@' in email) > 1),
  -- Null means every operator. One-click sets it null: a stranger asking to
  -- stop is not asking to stop from one business they have never heard of.
  operator_id uuid null references operators (id) on delete cascade,
  -- Null means every type. A typed row is a preference ("no walk_complete");
  -- a null row is a stop.
  notification_type notification_type null,
  reason text not null,
  created_at timestamptz not null default now()
);

-- `NULLS NOT DISTINCT` (Postgres 15+), because NULL is never equal to NULL and
-- a plain unique index would accept the same global suppression twice — and
-- both columns are null in the common case.
--
-- Not a `coalesce(...)` expression index, which was the first attempt: the
-- enum-to-text cast is STABLE rather than IMMUTABLE, so Postgres refuses it
-- outright ("functions in index expression must be marked IMMUTABLE"). This
-- says the same thing declaratively and needs no sentinel values.
create unique index uq_email_suppressions
  on email_suppressions (email, operator_id, notification_type)
  nulls not distinct;

create index idx_email_suppressions_email on email_suppressions (email);

alter table email_suppressions enable row level security;
alter table email_suppressions force row level security;
-- No policies and no API grants. This table is written by the definer function
-- below and read by the sender through the service role; an operator being
-- able to DELETE a suppression is the one thing that would make it worthless.
--
-- Deliberately not a tenant table (invariant 7 does not apply): a suppression
-- with an operator_id of null is the normal case and belongs to nobody.
revoke all on email_suppressions from public, anon, authenticated;
grant select, insert, delete on email_suppressions to service_role;

comment on table email_suppressions is
  'Addresses that must not be emailed, keyed on the address rather than the client — the wrong recipient of a mistyped address has no client row of their own (review M29).';

-- ── 3. Opting out ────────────────────────────────────────────────────────
create function fn_unsubscribe_by_token(p_token uuid)
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
  on conflict do nothing;

  return query select true, v_email;
end $$;

revoke all on function fn_unsubscribe_by_token(uuid) from public, anon, authenticated;

comment on function fn_unsubscribe_by_token(uuid) is
  'Suppresses every future email to the address behind an unsubscribe token. Answers identically for an unknown token, so the endpoint is not a guessing oracle (review M29).';

-- ── 4. The question the sender asks ──────────────────────────────────────
create function fn_email_suppressed(p_email text, p_operator uuid, p_type notification_type)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from email_suppressions s
     where s.email = lower(p_email)
       and (s.operator_id is null or s.operator_id = p_operator)
       and (s.notification_type is null or s.notification_type = p_type)
  );
$$;

revoke all on function fn_email_suppressed(text, uuid, notification_type) from public, anon, authenticated;
grant execute on function fn_email_suppressed(text, uuid, notification_type) to service_role;

-- ── 5. Stop putting the balance in the message ───────────────────────────
-- The client-facing `low_credit` body stated the credit balance, and that body
-- is rendered verbatim into the email. Combined with a mistyped address it
-- hands a stranger an account detail alongside the schedule, and mail is the
-- least private channel this product has. The portal is one tap away and is
-- behind a session, so the number lives there.
--
-- The OPERATOR-facing row is untouched: it reaches the bell, it is the
-- operator's own business data, and the count is the point of the alert.
--
-- Copied from the installed definition (`pg_get_functiondef`) with exactly one
-- line changed. My first draft of this migration rewrote the body from memory
-- and silently dropped the `fn_is_service_session()` guard, turned the
-- unknown-client `raise` into a return, and changed the return type from
-- boolean to void — which `create or replace` would have refused, but the
-- missing guard would have deployed cleanly.
create or replace function fn_notify_low_credit(p_client uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
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

  insert into notifications (operator_id, client_id, type, title, body)
  values
    (v_client.operator_id, p_client, 'low_credit', 'You are low on walk credits',
     'Open your portal to see your balance and top up before your next walk.'),
    (v_client.operator_id, null, 'low_credit', format('%s is low on credits', v_client.full_name),
     format('%s has %s credit(s) remaining.', v_client.full_name, v_client.credit_balance));

  return true;
end;
$$;

revoke all on function fn_notify_low_credit(uuid) from public, anon, authenticated;
