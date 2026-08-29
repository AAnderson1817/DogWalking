-- 0039 — an invite link stops being a permanent key to somebody's house.
--
-- Review H4. `fn_claim_invite` (0003) is, in full:
--
--     update clients set auth_user_id = auth.uid(), status = 'active'
--      where invite_token = p_token and auth_user_id is null
--
-- No expiry. No revocation. No binding to who was invited. No record that
-- anyone tried. `fn_preview_invite` (0006) checks nothing either, so the
-- friendly "you have been invited by <business>" screen renders for a token
-- issued at any point in the past.
--
-- Whoever opens that link first, from any account, becomes that client: home
-- address, property access notes, the door code in the vault, pet medical
-- notes, every GPS trace terminating at the house, every photo, the billing
-- history, and the ability to book and cancel. Invite links live in email
-- forever. They get forwarded, quoted in replies, and left in shared household
-- inboxes. A link pasted into a group chat in month one is a live account
-- takeover in month eighteen.
--
-- The operator could not fix this even if they noticed. `invite_token` appears
-- in no UPDATE column grant (0004:85 grants `full_name, email, phone, status,
-- notes`), so no API role can rotate it, and no RPC did. The obvious
-- workaround also fails: the operator holds `grant delete on clients`, but
-- every child table references `clients` with `on delete restrict`, so once
-- the client has a pet, a property or a walk the row cannot be deleted either.
-- A pet owner saying "please cancel that invite, I forwarded it by mistake"
-- was told it is not possible.
--
-- ── Why claiming returns an outcome instead of raising ─────────────────────
--
-- This is the load-bearing structural decision, and the first draft got it
-- wrong in a way that is worth writing down, because the bug LOOKED correct
-- and passed a casual reading.
--
-- The natural shape is: log the attempt, then `raise exception` to refuse. It
-- does not work. A PL/pgSQL exception rolls the transaction back to the
-- caller's savepoint, which discards the audit row that was just written — so
-- every refusal logs NOTHING, and the only attempts on record are the ones
-- that succeeded. That is precisely inverted from what the finding asks for:
-- the interesting rows are the refusals. Measured, not reasoned about: the
-- first version wrote four attempts and one survived.
--
-- So refusals are RETURNED, not thrown. The refusal itself was never the
-- exception — it is the absence of the binding UPDATE, which is unconditional
-- on the outcome being 'claimed'. A caller that ignores the return value gets
-- no account bound; it just fails to tell anyone why.
--
-- ── Why claiming binds to the invited address ──────────────────────────────
--
-- Email confirmation currently proves nothing about identity here. The
-- claimant types their OWN address into `ClaimInvite.tsx` signup, so
-- confirmation verifies the address the claimant chose, not the address the
-- operator invited. Binding the claim to `clients.email` is what converts that
-- confirmation into evidence, and it is the only control that stops a
-- forwarded link from working for the person it was forwarded to.
--
-- It binds only when the operator actually recorded an email, because
-- `clients.email` is nullable and a client added without one must still be
-- able to claim. The failure mode when the operator typo'd the address is a
-- refusal naming the fix, and both fixes are one action: the operator corrects
-- the email, or issues a fresh invite. That is a worse day than before for a
-- small number of legitimate claims, and a much worse day for every forwarded
-- link, which is the trade this finding asks for.
--
-- Deliberately NOT added: a rate limit on token guessing. `invite_token` is a
-- v4 uuid behind PostgREST, so that is machinery against a threat the entropy
-- already answers, while doing nothing about the real one — a link that was
-- legitimately sent and then travelled.

-- ── 1. Lifecycle columns ───────────────────────────────────────────────────

alter table clients
  add column invite_expires_at timestamptz,
  add column invite_revoked_at timestamptz;

comment on column clients.invite_expires_at is
  'When this invite stops being claimable (review H4). Null means no expiry, which is only reachable for an already-claimed row.';
comment on column clients.invite_revoked_at is
  'Set by fn_revoke_invite when an operator withdraws an invite, e.g. after forwarding it by mistake (review H4).';

-- Backfill: expiry measured from when the invite was ISSUED, not from now.
--
-- `created_at` is the issue time, because `invite_token` defaults at insert.
-- The alternative — `now() + 14 days` — would hand a fresh fortnight to every
-- link already in the wild, which is to say it would extend the lifetime of
-- exactly the credentials this migration exists to bound. Rows older than the
-- window therefore land already expired, which is the honest outcome: those
-- are stale bearer tokens of unknown reach, and the operator reissues with one
-- button. Nothing is guessed, and nothing still legitimately in flight is cut
-- short.
update clients
   set invite_expires_at = created_at + interval '14 days'
 where auth_user_id is null;

-- Claimed rows keep a null expiry on purpose: the token is spent, the claim
-- already refuses on `auth_user_id is not null`, and inventing an expiry for a
-- finished invite would put a date in the column that never meant anything.

alter table clients
  alter column invite_expires_at set default (now() + interval '14 days');

-- ── 2. The claim log ───────────────────────────────────────────────────────
--
-- Scoped to attempts against a token that MATCHES a client. An unmatched token
-- has no tenant to file under, and uuid guessing is not the threat; what the
-- operator needs to answer is "who tried to claim my client's invite, when,
-- and did it work" — including the refusals, which is the half that makes an
-- attempt visible at all.
create type invite_claim_outcome as enum (
  'claimed',
  'not_found',
  'already_claimed',
  'expired',
  'revoked',
  'email_mismatch'
);

create table invite_claim_attempts (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references operators (id) on delete restrict,
  client_id uuid not null references clients (id) on delete restrict,
  -- The authenticated user who presented the token. Deliberately NOT a FK to
  -- auth.users: this row must outlive the account, or deleting the account
  -- erases the evidence that it was ever used.
  attempted_by uuid not null,
  -- What they signed up as. The whole point of the email_mismatch row is being
  -- able to see which address tried, so the operator can tell a typo from a
  -- forward.
  attempted_email text,
  outcome invite_claim_outcome not null,
  created_at timestamptz not null default now()
);

create index idx_invite_claim_attempts_client
  on invite_claim_attempts (client_id, created_at desc);

comment on table invite_claim_attempts is
  'Every attempt to claim an invite whose token matched a client, successful or not (review H4). Append-only: a forged or deleted row is worse than a missing one.';

alter table invite_claim_attempts enable row level security;
alter table invite_claim_attempts force row level security;

-- The operator reads their own; nobody writes through an API role. Rows are
-- written only by the definer function below, in the same transaction as the
-- claim it records.
create policy invite_claim_attempts_operator_select on invite_claim_attempts
  for select to authenticated
  using (operator_id = (select auth.uid()));

revoke all on invite_claim_attempts from public, anon, authenticated;
grant select on invite_claim_attempts to authenticated;

-- Same treatment as credit_ledger and credential_access_log: an audit trail
-- the audited party can edit is not one. INSERT is revoked too — a forged
-- 'claimed' row attributing an account takeover to a legitimate address is
-- worse than no row at all.
create function fn_block_invite_log_mutation() returns trigger
language plpgsql
as $$
begin
  raise exception 'invite_claim_attempts is append-only (review H4)';
end;
$$;

create trigger trg_invite_claim_attempts_immutable
  before update or delete on invite_claim_attempts
  for each row execute function fn_block_invite_log_mutation();

revoke all on function fn_block_invite_log_mutation() from public, anon, authenticated;

-- ── 3. Claiming ────────────────────────────────────────────────────────────
--
-- Return type changes from `uuid` to a row, so the function must be dropped
-- rather than replaced. The only caller is `claimInvite()` in `app/src/lib/api.ts`.
drop function if exists fn_claim_invite(uuid);

create function fn_claim_invite(p_token uuid)
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
  -- Not an outcome: an unauthenticated call is a programming error, there is
  -- no principal to attribute a log row to, and no product path reaches it.
  if auth.uid() is null then
    raise exception 'fn_claim_invite: authentication required';
  end if;

  -- Lock the row for the whole decision. Without this, two tabs presenting the
  -- same token can both read `auth_user_id is null` and the second write wins
  -- silently — the losing account believes it claimed and holds nothing.
  select * into v_client
    from clients
   where invite_token = p_token
   for update;

  -- No row: nothing to log against and no tenant to file it under. Callers
  -- cannot tell this from `already_claimed` by any means other than the
  -- outcome value, which they only receive while holding the token anyway.
  if v_client.id is null then
    return query select null::uuid, 'not_found'::invite_claim_outcome;
    return;
  end if;

  v_email := nullif(lower(trim(auth.jwt() ->> 'email')), '');

  -- Order matters only for what the person is told. Revoked is checked before
  -- expired because a revoked invite is a decision somebody made, and calling
  -- it "expired" would send them to ask for a reissue of something that was
  -- withdrawn on purpose.
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
           status = 'active'
     where id = v_client.id;
    return query select v_client.id, v_outcome;
    return;
  end if;

  -- A refused attempt returns the client id as NULL. The outcome is what the
  -- caller renders; the id would be a fact about somebody else's account.
  return query select null::uuid, v_outcome;
end;
$$;

revoke all on function fn_claim_invite(uuid) from public, anon;
grant execute on function fn_claim_invite(uuid) to authenticated, service_role;

-- ── 4. Preview ─────────────────────────────────────────────────────────────
--
-- The preview must refuse for the same reasons the claim does, or /claim/:token
-- renders "Amelia — invited by Old Town Dog Care", collects a signup, and only
-- then says the link is dead. Worse, that screen names a real client and a real
-- business to the holder of a revoked link.
--
-- `already_claimed` stays a returned field rather than an empty result: the
-- screen has always used it to say "this is already set up, sign in instead",
-- which is a more useful dead end than silence.
create or replace function fn_preview_invite(p_token uuid)
returns table (full_name text, business_name text, already_claimed boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'fn_preview_invite: authentication required';
  end if;
  return query
    select c.full_name, o.business_name, (c.auth_user_id is not null)
      from clients c
      join operators o on o.id = c.operator_id
     where c.invite_token = p_token
       and c.invite_revoked_at is null
       and (c.auth_user_id is not null
            or c.invite_expires_at is null
            or c.invite_expires_at > now());
end;
$$;

-- ── 5. Reissue and withdraw ────────────────────────────────────────────────

create function fn_rotate_invite(p_client uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token uuid;
begin
  -- The caller check IS the safety property. Without it this is a cross-tenant
  -- invite generator: any authenticated user could mint a live token for any
  -- client in the system and then claim it themselves.
  update clients
     set invite_token = gen_random_uuid(),
         invite_expires_at = now() + interval '14 days',
         invite_revoked_at = null
   where id = p_client
     and operator_id = (select auth.uid())
     and auth_user_id is null
  returning invite_token into v_token;

  if v_token is null then
    -- One message for "not yours", "no such client" and "already claimed".
    -- Splitting them would make this an existence oracle over every client id
    -- in the product, and an operator looking at their own roster already
    -- knows which case they are in.
    raise exception 'fn_rotate_invite: no unclaimed invite for this client';
  end if;

  return v_token;
end;
$$;

create function fn_revoke_invite(p_client uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  update clients
     set invite_revoked_at = now()
   where id = p_client
     and operator_id = (select auth.uid())
     and auth_user_id is null
  returning id into v_id;

  if v_id is null then
    raise exception 'fn_revoke_invite: no unclaimed invite for this client';
  end if;
end;
$$;

revoke all on function fn_rotate_invite(uuid) from public, anon;
revoke all on function fn_revoke_invite(uuid) from public, anon;
grant execute on function fn_rotate_invite(uuid) to authenticated, service_role;
grant execute on function fn_revoke_invite(uuid) to authenticated, service_role;

-- ── 6. Column grants ───────────────────────────────────────────────────────
--
-- 0038 replaced the table-level SELECT on `clients` with an explicit column
-- list, which makes new columns fail CLOSED: without this the Roster would
-- fetch a client and simply not receive the two fields that say whether its
-- invite still works, with no error to notice.
grant select (invite_expires_at, invite_revoked_at) on clients to authenticated;

-- Deliberately no UPDATE grant on either column, and still none on
-- `invite_token`. Every transition goes through the functions above, which is
-- what keeps "who may reissue an invite" a single answer.

-- ── 7. Refuse if it did not take ───────────────────────────────────────────
--
-- Same posture as 0028 and 0031: a migration that applies cleanly and installs
-- nothing is the failure mode this repository keeps paying for. These assert
-- the OUTCOME rather than trusting the statements above to have had an effect.
do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'invite_claim_attempts'
  ) then
    raise exception '0039: invite_claim_attempts has no RLS policy — refusing';
  end if;

  if exists (
    select 1 from information_schema.column_privileges
     where table_name = 'clients'
       and column_name in ('invite_token', 'invite_expires_at', 'invite_revoked_at')
       and privilege_type = 'UPDATE'
       and grantee in ('authenticated', 'anon')
  ) then
    raise exception '0039: an API role can write invite lifecycle columns directly — refusing';
  end if;

  if exists (
    select 1 from clients
     where auth_user_id is null and invite_expires_at is null
  ) then
    raise exception '0039: an unclaimed invite was left with no expiry — refusing';
  end if;
end;
$$;
