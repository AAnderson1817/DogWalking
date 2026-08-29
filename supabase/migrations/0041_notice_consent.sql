-- 0041 — a record of what somebody was told, and when.
--
-- Review H6. There was no privacy notice, no terms, and no consent record
-- anywhere in the product. A case-insensitive grep for
-- `privacy|terms of|consent|by continuing` across `app/src` returned
-- `rollover_policy` and one code comment.
--
-- The order of collection is what makes that serious. The operator creates the
-- client (name, email, phone, notes), then the property (a residential
-- address), then the pets (medical and medication notes), then the access
-- credential (the door code) — all before the data subject has an account or
-- has been told anything at all. Five services receive that data (Supabase,
-- Stripe, Resend, Mapbox, Vercel) and none was disclosed.
--
-- ── A timestamp alone is not a consent record ──────────────────────────────
--
-- This is the whole design decision. `notice_accepted_at` on its own says that
-- somebody agreed to something, and nothing about WHAT — because the document
-- can change underneath it. So each acceptance stores the document VERSION,
-- and `app/scripts/legal-version.test.ts` hashes the document text and fails
-- if it changed without the version changing. The guard is what makes the
-- stored version evidence rather than decoration; without it these columns are
-- a more elaborate way of storing nothing.
--
-- ── Why the client's acceptance is written by the claim ────────────────────
--
-- The moment a client accepts is the moment they claim their invite: it is the
-- first point at which they exist as a person the system can ask. Recording it
-- in `fn_claim_invite` makes the acceptance and the account binding one
-- transaction, so a claimed account with no consent record is not a state that
-- can occur. A separate write immediately afterwards could fail on its own and
-- leave exactly that.

-- ── 1. Columns ─────────────────────────────────────────────────────────────

alter table clients
  add column notice_accepted_at timestamptz,
  add column notice_version text;

alter table operators
  add column terms_accepted_at timestamptz,
  add column terms_version text;

comment on column clients.notice_version is
  'Which version of the privacy notice this client was shown when they claimed (review H6). The text for a version is pinned by app/scripts/legal-version.test.ts.';
comment on column operators.terms_version is
  'Which version of the terms this operator accepted at signup (review H6).';

-- 0038 made `clients` SELECT fail-closed with an explicit column list, so a
-- new column is invisible to the API roles until granted. `operators` still
-- carries a table-level SELECT and INSERT grant, so its two columns need no
-- grant to be readable, and are writable at signup as part of the row.
grant select (notice_accepted_at, notice_version) on clients to authenticated;

-- Deliberately no UPDATE grant on the client's two columns. The acceptance is
-- written by the claim, in the definer function below. An operator being able
-- to stamp "this client accepted the notice" on a client's row would make the
-- record worthless in the one direction that matters.
--
-- The operator's own two columns are covered by the existing table-level
-- INSERT (0004:67) and are deliberately NOT added to the UPDATE grant list, so
-- they are set once at signup and not revised afterwards.

-- ── 2. The claim records the acceptance ────────────────────────────────────
--
-- Signature gains a defaulted parameter rather than becoming a second
-- function: an overload plus a default is ambiguous to resolve, and every
-- existing caller that passes one argument keeps working.
drop function if exists fn_claim_invite(uuid);

create function fn_claim_invite(p_token uuid, p_notice_version text default null)
returns table (client_id uuid, outcome invite_claim_outcome)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client  clients%rowtype;
  v_email   text;
  v_outcome invite_claim_outcome;
begin
  if auth.uid() is null then
    raise exception 'fn_claim_invite: authentication required';
  end if;

  select * into v_client
    from clients
   where invite_token = p_token
   for update;

  if v_client.id is null then
    return query select null::uuid, 'not_found'::invite_claim_outcome;
    return;
  end if;

  v_email := nullif(lower(trim(auth.jwt() ->> 'email')), '');

  if v_client.auth_user_id is not null then
    v_outcome := 'already_claimed';
  elsif v_client.invite_revoked_at is not null then
    v_outcome := 'revoked';
  elsif v_client.invite_expires_at is not null
        and v_client.invite_expires_at <= now() then
    v_outcome := 'expired';
  elsif v_client.email is not null
        and lower(trim(v_client.email)) is distinct from v_email then
    v_outcome := 'email_mismatch';
  else
    v_outcome := 'claimed';
  end if;

  insert into invite_claim_attempts
    (operator_id, client_id, attempted_by, attempted_email, outcome)
  values (v_client.operator_id, v_client.id, auth.uid(), v_email, v_outcome);

  if v_outcome = 'claimed' then
    update clients
       set auth_user_id = auth.uid(),
           status = 'active',
           -- Only stamped when a version was actually supplied. A null here
           -- means the claim came from a caller that showed no notice, and
           -- recording `now()` with no version would assert an acceptance
           -- nobody can look up.
           notice_accepted_at = case
             when p_notice_version is not null then now() else null end,
           notice_version = p_notice_version
     where id = v_client.id;
    return query select v_client.id, v_outcome;
    return;
  end if;

  return query select null::uuid, v_outcome;
end;
$$;

revoke all on function fn_claim_invite(uuid, text) from public, anon;
grant execute on function fn_claim_invite(uuid, text) to authenticated, service_role;

-- ── 3. The purge takes the consent record with it ──────────────────────────
--
-- 0040's tombstone predates these columns. A purged client keeping
-- `notice_version` is harmless, but keeping `notice_accepted_at` alongside a
-- nulled identity is a dangling fact about a person who has been erased — and
-- the whole point of the tombstone is that what remains is financial, not
-- personal.
create or replace function fn_purge_client(p_client uuid)
returns table (storage_path text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_op uuid := (select auth.uid());
begin
  if not exists (
    select 1 from clients where id = p_client and operator_id = v_op
  ) then
    raise exception 'fn_purge_client: no such client';
  end if;

  -- Walks before clients (0037): fn_refund_cancelled_debit is a BEFORE UPDATE
  -- trigger on walks and always holds the walk tuple before reaching for the
  -- client, so this is the one order a purge cannot deadlock against.
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
  delete from notifications where client_id = p_client;
  delete from invite_claim_attempts where client_id = p_client;

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

  return query
    select wp.storage_path from walk_photos wp
      join walks w on w.id = wp.walk_id
     where w.client_id = p_client
    union
    select pe.photo_path from pets pe
     where pe.client_id = p_client and pe.photo_path is not null;
end;
$$;

-- ── 4. Refuse if it did not take ───────────────────────────────────────────
do $$
begin
  if exists (
    select 1 from information_schema.column_privileges
     where table_name = 'clients'
       and column_name in ('notice_accepted_at', 'notice_version')
       and privilege_type = 'UPDATE'
       and grantee in ('authenticated', 'anon')
  ) then
    raise exception '0041: an operator can stamp a client''s consent directly — refusing';
  end if;

  if to_regprocedure('fn_claim_invite(uuid, text)') is null then
    raise exception '0041: fn_claim_invite did not gain the notice-version argument — refusing';
  end if;
end;
$$;

-- ── 5. The client can see the retention window that applies to them ────────
--
-- `v_my_operator` is the client's only read of their operator. The privacy
-- notice tells them route traces are deleted on a schedule; without this the
-- portal cannot say WHICH schedule, and a notice that describes a policy the
-- product cannot show is the kind of half-true this finding is about.
--
-- `security_invoker` is carried forward from 0032 — without it the view runs
-- as its owner and the `auth.uid()` predicates inside it stop scoping anything.
create or replace view v_my_operator
  with (security_invoker = true) as
  select o.id, o.display_name, o.business_name, o.cancellation_cutoff_hours,
         o.gps_retention_days
    from operators o
   where o.id = auth.uid()
      or o.id = (select operator_id from clients where auth_user_id = auth.uid());

grant select on v_my_operator to authenticated, service_role;
