-- 0042 — the purge works for a client who actually claimed, and a wrong claim
-- can be undone.
--
-- Two defects in 0039–0041, found by probing the case neither test covered.
--
-- ── 1. The purge cannot run for any client who ever claimed ────────────────
--
-- 0039 made `invite_claim_attempts` append-only with an unconditional
-- `before update or delete` trigger. 0040's `fn_purge_client` then does
-- `delete from invite_claim_attempts where client_id = p_client`. Every client
-- who claimed their invite has at least one `claimed` row, so the purge raises
-- `invite_claim_attempts is append-only` and erases NOTHING.
--
-- It passed because the H5 fixture's client was created `invited` and never
-- claimed, so the delete was a no-op against an empty set. This is the same
-- defect as the `credential_access_log` one fixed while writing 0040 — the
-- audit table introduced two migrations earlier blocking the purge that came
-- after it — and it was made a second time, in the same function, for the same
-- reason: the fixture did not produce the row that triggers it.
--
-- The fix is not to weaken the trigger to nothing. It is to say precisely when
-- an attempt row may go: **only once its client has been purged.** The purge
-- stamps `purged_at` first, and the trigger then permits the delete for that
-- client and nobody else. So erasing claim attempts is only reachable by
-- erasing the client, which is itself destructive, operator-scoped and
-- deliberate — and an operator cannot quietly delete one inconvenient row.
--
-- UPDATE stays blocked unconditionally. There is no legitimate reason to
-- rewrite an attempt, and a forged `claimed` row attributing a takeover to a
-- legitimate address is the thing the table exists to prevent.
--
-- ── 2. A wrong claim cannot be undone ──────────────────────────────────────
--
-- H4's own scenario is a link that travelled: "a link pasted into a group chat
-- in month one is a live account takeover in month eighteen." 0039 bounds
-- FUTURE instances — expiry, revocation, reissue, email binding — and offers
-- nothing once one has happened. Measured against the shipped code:
--
--   fn_revoke_invite  -> refuses: `no unclaimed invite for this client`
--   fn_rotate_invite  -> refuses: same, both require auth_user_id is null
--   delete from clients -> refused by properties_client_id_fkey
--   fn_purge_client   -> raised (defect 1), and is the wrong tool anyway:
--                        it destroys the client's record to evict a stranger
--
-- So the operator's only route was the service role — an owner action, for a
-- per-tenant incident, and `owner-actions.md` has never mentioned invites.
-- CLAUDE.md calls escalating a routine decision to the owner a failure mode.
--
-- Binding to `clients.email` (0039) narrows this a great deal: a forwarded
-- link is refused for anyone but the invited address. It does NOT close it —
-- binding is skipped when the operator recorded no email, which is exactly the
-- phone-only client the binding was made optional for.
--
-- `fn_unbind_invite` severs the account and reissues in one transaction, so
-- there is no window where the client is unclaimed with a live old token.

-- ── The trigger learns one exception ───────────────────────────────────────

create or replace function fn_block_invite_log_mutation() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- An attempt row may be deleted only as part of erasing its client, and only
  -- after the erasure has been stamped. Checking the CLIENT rather than
  -- trusting the caller means this cannot be reached by an UPDATE-then-DELETE
  -- from anywhere else: `purged_at` is written by fn_purge_client, which is
  -- operator-scoped and carries no API-role write grant.
  if tg_op = 'DELETE' and exists (
    select 1 from clients
     where id = old.client_id and purged_at is not null
  ) then
    return old;
  end if;
  raise exception 'invite_claim_attempts is append-only (review H4)';
end;
$$;

revoke all on function fn_block_invite_log_mutation() from public, anon, authenticated;

-- ── The purge stamps first, then deletes the attempts ──────────────────────
--
-- Ordering is now load-bearing: the tombstone must land before the attempt
-- rows are removed, or the trigger's exception does not apply and the purge
-- raises exactly as it does today.
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
  delete from notifications where client_id = p_client;

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
$$;

-- ── Undoing a wrong claim ──────────────────────────────────────────────────

create function fn_unbind_invite(p_client uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token uuid;
  v_prev  uuid;
begin
  -- Severing and reissuing in ONE statement is the point. Two statements leave
  -- a window in which the client is unclaimed and the OLD token is still live,
  -- so whoever holds it can simply claim again.
  update clients
     set auth_user_id = null,
         status = 'invited',
         invite_token = gen_random_uuid(),
         invite_expires_at = now() + interval '14 days',
         invite_revoked_at = null,
         -- The consent record belonged to whoever claimed. It is not evidence
         -- about the real client and must not be inherited by them.
         notice_accepted_at = null,
         notice_version = null
   where id = p_client
     and operator_id = (select auth.uid())
     and auth_user_id is not null
     and purged_at is null
  returning invite_token, auth_user_id into v_token, v_prev;

  if v_token is null then
    -- One message for "not yours", "no such client", "not claimed" and
    -- "already purged": splitting them makes this an existence oracle over
    -- every client id, and the operator looking at their own roster knows
    -- which case they are in.
    raise exception 'fn_unbind_invite: no claimed invite to release for this client';
  end if;

  return v_token;
end;
$$;

revoke all on function fn_unbind_invite(uuid) from public, anon;
grant execute on function fn_unbind_invite(uuid) to authenticated, service_role;

-- ── Refuse if it did not take ──────────────────────────────────────────────
do $$
begin
  if to_regprocedure('fn_unbind_invite(uuid)') is null then
    raise exception '0042: fn_unbind_invite was not installed — refusing';
  end if;

  -- The trigger must still exist. A `create or replace` of its function cannot
  -- drop it, but asserting the outcome rather than trusting the statement is
  -- the posture the rest of these migrations take.
  if not exists (
    select 1 from pg_trigger
     where tgname = 'trg_invite_claim_attempts_immutable' and not tgisinternal
  ) then
    raise exception '0042: the invite log lost its immutability trigger — refusing';
  end if;
end;
$$;
