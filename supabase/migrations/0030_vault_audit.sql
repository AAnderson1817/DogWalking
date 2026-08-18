-- 0030 — the vault stops leaving the key out, and the audit trail starts
--        answering the question it exists to answer (review H3)
--
-- Two related gaps in the flagship feature.
--
-- 1. THE HINT WAS NOT PROTECTED. `key_location_hint` was an ordinary column
--    with SELECT, INSERT and UPDATE granted to `authenticated`, rendered
--    inline in the credential list with no re-auth, no audit row and no rate
--    limit. Its placeholder text was verbatim "Left of the porch, behind the
--    planter" — the field actively coached a means of entry into an
--    unencrypted column, sitting beside `properties.address_line1`, equally
--    ungated. One `GET /rest/v1/properties` plus one
--    `GET /rest/v1/access_credentials` with a borrowed session returned, for
--    every client: full residential address, entry method, and where the key
--    is hidden. For a `key_on_file` or `lockbox` client, AES-GCM was
--    protecting the less useful half of the secret.
--
-- 2. THE LOG RECORDED ONE EVENT OUT OF FOUR. `credential_access_log` was
--    written in exactly one place — inside `fn_read_credential`, on a
--    successful reveal. Creating, rotating and revoking wrote nothing; a
--    failed re-auth wrote nothing. There was no IP, user agent or walk
--    reference, and unlike `credit_ledger` the log had no mutation-block
--    trigger, so the operator whose reads it records could edit it.
--
--    In the scenario the product implicitly promises to handle — a client is
--    burgled and the walker is a suspect — the log said "opened 14:02, purpose
--    'pre-walk entry'", where the purpose was typed by the suspect. It
--    exonerated nobody. And when a client asked "who changed my garage code on
--    the 14th", the answer was a `rotated_at` that the next rotation
--    overwrote.
--
-- The audit scope was authorised by spec 03/04, so this is a product decision
-- being reversed rather than an implementation slip. Both specs change in the
-- same commit.


-- ── 1. The hint goes away entirely ───────────────────────────────────────
-- Not encrypted-in-place: dropped. The field was incoherent as designed.
-- `label` already exists to tell credentials apart in a list ("Front door"),
-- and the SECRET field's own placeholder already reads "Code, key location,
-- alarm sequence…" — so key location was always in scope for the encrypted
-- column. Encrypting the hint too would mean a second ciphertext column, a
-- second reveal path, a second audit event and a UI where the operator has to
-- decide which of two encrypted fields "behind the planter" belongs in.
--
-- Nothing real is lost. `deploy-production.yml` has zero workflow runs
-- (checked against the Actions API, not remembered), so no production project
-- has ever existed, and staging holds only `seed.sql` fixture data. Carrying a
-- deprecated plaintext column forever to serve data that does not exist is the
-- same trade #34 refused when it declined a dual-mode Stripe fallback.
--
-- The count is reported rather than assumed: if this ever runs somewhere with
-- real content, the deploy log records exactly how much plaintext it destroyed.
do $$
declare
  v_count int;
begin
  select count(*) into v_count from access_credentials where key_location_hint is not null;
  if v_count > 0 then
    raise notice
      '0030: dropping key_location_hint with % non-null row(s). Those values were '
      'UNENCRYPTED and client-readable; their content belongs in the encrypted '
      'secret. No production project has ever been deployed, so this is fixture '
      'data.', v_count;
  end if;
end $$;

revoke select (key_location_hint) on access_credentials from authenticated;
revoke insert (key_location_hint) on access_credentials from authenticated;
revoke update (key_location_hint) on access_credentials from authenticated;
alter table access_credentials drop column if exists key_location_hint;


-- ── 2. What kind of event this was ───────────────────────────────────────
-- New type, so it can be created and used in the same transaction (the
-- 0022/0025 restriction is on ALTER TYPE ... ADD VALUE).
create type credential_action as enum (
  'read',
  'create',
  'rotate',
  'revoke',
  'reauth_failed'
);

alter table credential_access_log
  add column if not exists action credential_action not null default 'read',
  -- inet, not text: a malformed value is rejected at write time rather than
  -- discovered when somebody tries to search by subnet during an incident.
  add column if not exists ip inet,
  add column if not exists user_agent text,
  -- Which visit this reveal was for. The purpose can then be derived from
  -- something the system knows, instead of resting entirely on a sentence the
  -- person under suspicion typed.
  add column if not exists walk_id uuid references walks (id) on delete restrict;

comment on column credential_access_log.accessed_by is
  'The authenticated user. For an operator persona this equals operator_id by '
  'construction (fn_read_credential rejects any other case), so it carries no '
  'information today — it is kept for the moment a second persona can read a '
  'credential at all.';

-- `purpose` was NOT NULL with a non-empty check, which only makes sense for a
-- read: a revoke has no purpose and a failed re-auth has no credential the
-- caller was entitled to name. Required for reads, optional otherwise.
alter table credential_access_log alter column purpose drop not null;

do $$
begin
  if exists (select 1 from pg_constraint
              where conname = 'credential_access_log_purpose_check') then
    alter table credential_access_log drop constraint credential_access_log_purpose_check;
  end if;
end $$;

alter table credential_access_log
  add constraint credential_access_log_purpose_required_for_read
  check (action <> 'read' or (purpose is not null and length(trim(purpose)) > 0));

create index if not exists idx_credential_access_log_action
  on credential_access_log (credential_id, accessed_at desc);


-- ── 3. The log becomes immortal, like the ledger ──────────────────────────
-- It had no mutation block at all, so the operator whose reads it records
-- could rewrite or delete them through PostgREST — an audit trail its own
-- subject can edit is not one. Same shape as fn_ledger_block_mutation (0003).
create or replace function fn_credential_log_block_mutation() returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'credential_access_log is append-only';
end;
$$;

drop trigger if exists trg_credential_access_log_immutable on credential_access_log;
create trigger trg_credential_access_log_immutable
  before update or delete on credential_access_log
  for each row execute function fn_credential_log_block_mutation();

-- And no write path for the API roles: every row comes from a definer function
-- below. Without this an operator could forge a 'read' row attributing an entry
-- to a time they were elsewhere, which is worse than a missing trail.
revoke insert, update, delete on credential_access_log from authenticated;


-- ── 4. One place that writes a log row ────────────────────────────────────
create or replace function fn_log_credential_action(
  p_credential uuid,
  p_operator uuid,
  p_action credential_action,
  p_purpose text default null,
  p_ip text default null,
  p_user_agent text default null,
  p_walk uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not fn_is_service_session() then
    raise exception 'fn_log_credential_action: service role required';
  end if;

  insert into credential_access_log
    (operator_id, credential_id, accessed_by, action, purpose, ip, user_agent, walk_id)
  values
    (p_operator, p_credential, p_operator, p_action, p_purpose,
     -- A malformed forwarded-for header must not fail the vault operation it is
     -- describing: record the row without an IP rather than lose the row.
     case when p_ip is null then null
          else (select case when p_ip ~ '^[0-9a-fA-F:.]+$' then p_ip::inet else null end)
     end,
     left(p_user_agent, 400), p_walk)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function fn_log_credential_action(uuid, uuid, credential_action, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function fn_log_credential_action(uuid, uuid, credential_action, text, text, text, uuid)
  to service_role;


-- ── 5. Writes and their log rows, in one transaction ─────────────────────
-- The point of a definer function here is atomicity: a credential cannot be
-- created, rotated or revoked without the audit row landing with it. Two
-- separate statements from the edge function could half-succeed, and the half
-- that survives would be the one that changes the door.
create or replace function fn_write_credential(
  p_id uuid,
  p_operator uuid,
  p_property uuid,
  p_entry_method entry_method,
  p_ciphertext bytea,
  p_label text,
  p_ip text default null,
  p_user_agent text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  if not fn_is_service_session() then
    raise exception 'fn_write_credential: service role required';
  end if;
  if not exists (select 1 from properties
                  where id = p_property and operator_id = p_operator) then
    raise exception 'fn_write_credential: property does not belong to this operator';
  end if;

  insert into access_credentials
    (id, operator_id, property_id, entry_method, ciphertext, label)
  values (p_id, p_operator, p_property, p_entry_method, p_ciphertext, p_label);

  perform fn_log_credential_action(p_id, p_operator, 'create', null, p_ip, p_user_agent, null);
  return p_id;
end;
$$;

create or replace function fn_rotate_credential(
  p_id uuid,
  p_operator uuid,
  p_ciphertext bytea,
  p_entry_method entry_method default null,
  p_label text default null,
  p_ip text default null,
  p_user_agent text default null
) returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rotated timestamptz;
begin
  if not fn_is_service_session() then
    raise exception 'fn_rotate_credential: service role required';
  end if;

  update access_credentials
     set ciphertext = p_ciphertext,
         entry_method = coalesce(p_entry_method, entry_method),
         label = coalesce(p_label, label),
         rotated_at = now()
   where id = p_id and operator_id = p_operator and revoked_at is null
  returning rotated_at into v_rotated;

  if v_rotated is null then
    raise exception 'fn_rotate_credential: no live credential % for this operator', p_id;
  end if;

  -- This is the row that answers "who changed my garage code on the 14th".
  -- Before it, a rotation left only `rotated_at`, which the NEXT rotation
  -- overwrote — so the history of a door's codes was exactly one entry long.
  perform fn_log_credential_action(p_id, p_operator, 'rotate', null, p_ip, p_user_agent, null);
  return v_rotated;
end;
$$;

create or replace function fn_revoke_credential(
  p_id uuid,
  p_operator uuid,
  p_ip text default null,
  p_user_agent text default null
) returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_revoked timestamptz;
begin
  if not fn_is_service_session() then
    raise exception 'fn_revoke_credential: service role required';
  end if;

  update access_credentials
     set revoked_at = now()
   where id = p_id and operator_id = p_operator and revoked_at is null
  returning revoked_at into v_revoked;

  if v_revoked is null then
    raise exception 'fn_revoke_credential: no live credential % for this operator', p_id;
  end if;

  perform fn_log_credential_action(p_id, p_operator, 'revoke', null, p_ip, p_user_agent, null);
  return v_revoked;
end;
$$;

revoke all on function fn_write_credential(uuid, uuid, uuid, entry_method, bytea, text, text, text)
  from public, anon, authenticated;
grant execute on function fn_write_credential(uuid, uuid, uuid, entry_method, bytea, text, text, text)
  to service_role;
revoke all on function fn_rotate_credential(uuid, uuid, bytea, entry_method, text, text, text)
  from public, anon, authenticated;
grant execute on function fn_rotate_credential(uuid, uuid, bytea, entry_method, text, text, text)
  to service_role;
revoke all on function fn_revoke_credential(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function fn_revoke_credential(uuid, uuid, text, text) to service_role;


-- ── 6. fn_read_credential logs through the same path ─────────────────────
-- Body from 0003:462-494, with the inline insert replaced by the shared
-- logger so every event has one writer, plus the IP / user agent / walk that
-- the row had no columns for. The tenancy and revocation asserts are
-- unchanged.
create or replace function fn_read_credential(
  p_credential uuid,
  p_purpose text,
  p_operator uuid,
  p_ip text default null,
  p_user_agent text default null,
  p_walk uuid default null
)
returns table (ciphertext bytea, label text, entry_method entry_method)
language plpgsql
security definer
set search_path = public
as $$
declare
  cred record;
begin
  if not fn_is_service_session() then
    raise exception 'fn_read_credential: service role required';
  end if;
  if p_purpose is null or length(trim(p_purpose)) = 0 then
    raise exception 'fn_read_credential: purpose is required';
  end if;

  select * into cred from access_credentials ac where ac.id = p_credential;
  if not found then
    raise exception 'fn_read_credential: unknown credential %', p_credential;
  end if;
  if cred.operator_id <> p_operator then
    raise exception 'fn_read_credential: credential belongs to a different operator';
  end if;
  if cred.revoked_at is not null then
    raise exception 'fn_read_credential: credential has been revoked';
  end if;
  if p_walk is not null and not exists (
    select 1 from walks w
     where w.id = p_walk
       and w.operator_id = p_operator
       and w.property_id = cred.property_id
  ) then
    -- A walk reference that does not match this operator AND this property
    -- would make the trail worse than empty: it would attribute an entry to a
    -- visit that was somewhere else.
    raise exception 'fn_read_credential: walk % is not a visit to this property', p_walk;
  end if;

  perform fn_log_credential_action(
    cred.id, cred.operator_id, 'read', p_purpose, p_ip, p_user_agent, p_walk);

  return query select cred.ciphertext, cred.label, cred.entry_method;
end;
$$;

revoke all on function fn_read_credential(uuid, text, uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function fn_read_credential(uuid, text, uuid, text, text, uuid) to service_role;

-- The 3-argument version is dropped, not left as an overload. Two functions
-- differing only by trailing optional arguments is exactly the shape a caller
-- gets wrong, and the old one is the version that records nothing about who or
-- where.
drop function if exists fn_read_credential(uuid, text, uuid);


-- ── 7. The client can read their own door's trail ────────────────────────
-- The person whose door it is had no read path at all, which is the half of
-- H3 that makes the trail unable to answer the question it exists for. A
-- client seeing "your walker opened the lockbox at 14:02 for Tuesday's visit"
-- is the product's best technical asset doing visible work.
--
-- SELECT only, scoped through property → client. The mutation block above and
-- the revoked INSERT/UPDATE/DELETE mean this cannot become a write path.
create policy credential_access_log_client_select on credential_access_log
  for select to authenticated
  using (exists (
    select 1
      from access_credentials ac
      join properties p on p.id = ac.property_id
      join clients c on c.id = p.client_id
     where ac.id = credential_access_log.credential_id
       and c.auth_user_id = auth.uid()
  ));

-- Clients read their own properties' credential METADATA too, so the trail has
-- something to name. Deliberately NOT the ciphertext column, which stays
-- revoked from every API role (invariant 2).
create policy access_credentials_client_select on access_credentials
  for select to authenticated
  using (exists (
    select 1 from properties p
      join clients c on c.id = p.client_id
     where p.id = access_credentials.property_id
       and c.auth_user_id = auth.uid()
  ));
