-- 0040 — a client's data can be exported, and destroyed.
--
-- Review H5. There was no way — in the UI, in the API layer, or as a database
-- routine — to delete or export a client, property, pet, walk, GPS trace,
-- photo or credential. No retention job of any kind. `archived` appears only in
-- read paths; no code ever set it. A client who left kept their address, their
-- encrypted door code, every GPS trace terminating at their house, and every
-- photo, indefinitely. A deletion or portability request could not be honoured
-- through any product path.
--
-- ── What the FK graph actually permits ─────────────────────────────────────
--
-- The review assumed a purge could delete children in dependency order. It
-- cannot, and the reason decides the whole shape of this migration. Read off
-- `pg_constraint` rather than from the schema file:
--
--   credit_ledger.walk_id  -> walks   ON DELETE RESTRICT
--   payments.walk_id       -> walks   ON DELETE RESTRICT
--
-- The financial ledger points AT walks, and the ledger must survive — it is
-- the tax record, and invariant 1 makes it append-only. So **walks cannot be
-- deleted.** And then:
--
--   walks.property_id -> properties   ON DELETE RESTRICT, and NOT NULL
--
-- so a property referenced by a surviving walk can neither be deleted nor
-- detached. **Properties cannot be deleted either.**
--
-- That is why this is not a cascade. Three tables are REDACTED in place —
-- clients, walks, properties — and everything else is destroyed outright.
-- Redaction is not a weaker form of deletion here; it is the only form the
-- referential graph allows without dismantling the ledger, and what remains
-- afterwards carries no personal data: a walk keeps its date, duration and
-- price, and a property keeps the fact that it existed.
--
-- ── The rule ───────────────────────────────────────────────────────────────
--
-- The credentials and the GPS traces MUST be destroyable. The financial ledger
-- must NOT be. Everything here follows from those two sentences.
--
-- Destroyed: walk_gps_points, walk_photos, walk_pets, schedule_pets,
-- recurring_schedules, plan_change_intents, notifications,
-- invite_claim_attempts, pets (the medical and medication notes).
--
-- Redacted: clients to a tombstone, walks.notes, properties' address and
-- access notes, and access_credentials' ciphertext — the SECRET is destroyed
-- while the row stays, because credential_access_log restricts on it and that
-- table is immutable by design (see the note at the credential step below).
--
-- Kept whole: credit_ledger, payments, credential_access_log.
--
-- ── Storage is a two-phase problem ─────────────────────────────────────────
--
-- SQL cannot delete an object from a Supabase bucket. Deleting the
-- `storage.objects` row removes the metadata and leaves the file, so a purge
-- that only touched SQL would destroy the POINTER to a photo of somebody's
-- house and leave the photo.
--
-- So `fn_purge_client` runs first and RETURNS the storage paths it is about to
-- orphan, keeping the `walk_photos` and `pets.photo_path` rows that name them.
-- The caller — the operator's own browser, which already holds a delete policy
-- scoped to its own folder (0004 `storage_operator_delete`) — removes the
-- objects, then calls `fn_purge_client_photos` to drop the rows.
--
-- The rows ARE the work queue, which is the pattern the vault rewrap in 0021
-- settled on: no journal, idempotent, resumable. If the browser dies between
-- the two calls, re-running the first returns the same paths. The one thing
-- that must never happen — a file left in the bucket with nothing in the
-- database naming it — is structurally impossible, because the row is deleted
-- only after the object is gone.

-- ── 1. Tombstone marker ────────────────────────────────────────────────────

alter table clients add column purged_at timestamptz;

comment on column clients.purged_at is
  'Set when the client''s personal data was destroyed (review H5). The row survives because credit_ledger and payments reference it; everything identifying is gone.';

grant select (purged_at) on clients to authenticated;

-- ── 2. Export, before destroy ──────────────────────────────────────────────
--
-- Portability is the half of H5 that is not destructive, and it must come
-- first in the product flow: an operator asked to delete a client should be
-- able to hand them their data on the way out.
--
-- Returns one JSON document. Deliberately EXCLUDES the vault ciphertext: it is
-- unreadable without the master key (invariant 2), so exporting it would ship
-- an opaque blob that is useless to the recipient and a liability in an inbox.
-- The credential's label and entry method are included — that is the part that
-- is about them.
create function fn_export_client_data(p_client uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_client clients%rowtype;
  v_out    jsonb;
begin
  select * into v_client from clients
   where id = p_client and operator_id = (select auth.uid());
  if v_client.id is null then
    raise exception 'fn_export_client_data: no such client';
  end if;

  select jsonb_build_object(
    'exported_at', now(),
    'client', jsonb_build_object(
      'full_name', v_client.full_name,
      'email', v_client.email,
      'phone', v_client.phone,
      'status', v_client.status,
      'credit_balance', v_client.credit_balance,
      'created_at', v_client.created_at
    ),
    'properties', coalesce((
      select jsonb_agg(jsonb_build_object(
        'label', p.label, 'address_line1', p.address_line1,
        'address_line2', p.address_line2, 'city', p.city, 'postcode', p.postcode,
        'access_notes', p.access_notes_public))
        from properties p where p.client_id = p_client), '[]'::jsonb),
    'pets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', pe.name, 'breed', pe.breed, 'size', pe.size,
        'temperament', pe.temperament, 'medical_notes', pe.medical_notes,
        'feeding_notes', pe.feeding_notes, 'medication_notes', pe.medication_notes,
        'vet_name', pe.vet_name, 'vet_phone', pe.vet_phone))
        from pets pe where pe.client_id = p_client), '[]'::jsonb),
    'walks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'scheduled_date', w.scheduled_date, 'status', w.status,
        'started_at', w.started_at, 'ended_at', w.ended_at,
        'distance_m', w.distance_m, 'notes', w.notes))
        from walks w where w.client_id = p_client), '[]'::jsonb),
    'entry_credentials', coalesce((
      select jsonb_agg(jsonb_build_object(
        'label', ac.label, 'entry_method', ac.entry_method,
        'created_at', ac.created_at, 'revoked_at', ac.revoked_at))
        from access_credentials ac
        join properties p2 on p2.id = ac.property_id
       where p2.client_id = p_client), '[]'::jsonb),
    'ledger', coalesce((
      select jsonb_agg(jsonb_build_object(
        'created_at', cl.created_at, 'entry_type', cl.entry_type,
        'amount', cl.amount, 'balance_after', cl.balance_after, 'note', cl.note))
        from credit_ledger cl where cl.client_id = p_client), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'created_at', pa.created_at, 'amount_pence', pa.amount_pence,
        'currency', pa.currency, 'status', pa.status, 'type', pa.type))
        from payments pa where pa.client_id = p_client), '[]'::jsonb)
  ) into v_out;

  return v_out;
end;
$$;

-- ── 3. Purge, phase one ────────────────────────────────────────────────────

create function fn_purge_client(p_client uuid)
returns table (storage_path text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_op uuid := (select auth.uid());
begin
  -- The caller check is the safety property: without it this is a
  -- cross-tenant data bomb callable by any authenticated user.
  if not exists (
    select 1 from clients where id = p_client and operator_id = v_op
  ) then
    raise exception 'fn_purge_client: no such client';
  end if;

  -- Lock walks before clients. 0037 made that the one permitted order,
  -- because fn_refund_cancelled_debit is a BEFORE UPDATE trigger on walks and
  -- therefore always holds the walk tuple before it reaches for the client.
  -- A purge that took them the other way round would reintroduce the deadlock
  -- that migration exists to remove.
  perform 1 from walks where client_id = p_client order by id for update;
  perform 1 from clients where id = p_client for update;

  -- Destroy, innermost first.
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

  -- ── The credential is redacted, not deleted, and the trail survives ─────
  --
  -- The first version of this deleted `credential_access_log` and then the
  -- credential rows. It raised `credential_access_log is append-only` for
  -- every real client — because `fn_write_credential` writes a `create` audit
  -- row for every credential, `credential_access_log.credential_id` is
  -- RESTRICT, and 0030 made that table immutable with an unconditional
  -- trigger. So the purge worked only for a credential that had never been
  -- written through the product. The smoke fixture inserted one directly,
  -- which is exactly why the test did not catch it.
  --
  -- Deleting the trail would also be wrong on purpose, not just impossible.
  -- H3 built it so that a real intrusion is visible; letting a purge erase it
  -- hands the audited party a way to erase their own reads by purging the
  -- client they read from. The row is undeletable BY DESIGN.
  --
  -- **The destroyable thing is the secret, not the row.** The ciphertext is
  -- overwritten with a sentinel that is not a v2 blob, so the `key_id`
  -- generated column (0021) evaluates to NULL — "not a readable v2 blob",
  -- which is precisely what this row now is. 37 zero bytes rather than an
  -- empty string: `key_id` reads `get_byte(ciphertext, 0)` beside an
  -- `octet_length >= 37` guard, and a sentinel that satisfies the length test
  -- while failing the version test cannot depend on AND short-circuiting.
  update access_credentials ac
     set ciphertext = repeat('\000', 37)::bytea,
         label = null,
         revoked_at = coalesce(ac.revoked_at, now())
    from properties p
   where ac.property_id = p.id and p.client_id = p_client;

  -- Redact what the ledger pins in place. `walks.notes` is free text written
  -- during the visit; the rest of the row is date, duration and price.
  update walks set notes = null where client_id = p_client;

  -- properties cannot be deleted (walks.property_id is NOT NULL and RESTRICT)
  -- so the address and the access notes are removed from the surviving shell.
  update properties
     set address_line1 = null, address_line2 = null, city = null,
         postcode = null, access_notes_public = null,
         lat = null, lng = null, label = 'Removed'
   where client_id = p_client;

  -- The tombstone. full_name, invite_token and unsubscribe_token are NOT NULL,
  -- so they are replaced rather than nulled — the tokens with fresh random
  -- values, so the old ones stop resolving to anything.
  update clients
     set full_name = 'Deleted client',
         email = null,
         phone = null,
         notes = null,
         auth_user_id = null,
         invite_token = gen_random_uuid(),
         unsubscribe_token = gen_random_uuid(),
         invite_revoked_at = now(),
         status = 'archived',
         purged_at = now()
   where id = p_client;

  -- Pets are deleted last: walk_pets and schedule_pets both restricted on
  -- pet_id and had to go first.
  --
  -- Their photo paths are returned rather than deleted, along with the walk
  -- photos, because the objects they name still exist in the bucket. The rows
  -- are the work queue.
  return query
    select wp.storage_path from walk_photos wp
      join walks w on w.id = wp.walk_id
     where w.client_id = p_client
    union
    select pe.photo_path from pets pe
     where pe.client_id = p_client and pe.photo_path is not null;
end;
$$;

-- ── 4. Purge, phase two ────────────────────────────────────────────────────
--
-- Called after the storage objects are gone. Separate so that the row naming
-- an object is never deleted before the object itself — the failure this
-- ordering exists to prevent is a photo of somebody's house left in a bucket
-- with nothing in the database pointing at it.
create function fn_purge_client_photos(p_client uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_op uuid := (select auth.uid());
  v_n  int := 0;
  v_m  int := 0;
begin
  if not exists (
    select 1 from clients where id = p_client and operator_id = v_op
  ) then
    raise exception 'fn_purge_client_photos: no such client';
  end if;

  with gone as (
    delete from walk_photos wp
     using walks w
     where wp.walk_id = w.id and w.client_id = p_client
    returning 1
  ) select count(*) into v_n from gone;

  delete from pets where client_id = p_client;
  get diagnostics v_m = row_count;

  return v_n + v_m;
end;
$$;

revoke all on function fn_export_client_data(uuid) from public, anon;
revoke all on function fn_purge_client(uuid) from public, anon;
revoke all on function fn_purge_client_photos(uuid) from public, anon;
grant execute on function fn_export_client_data(uuid) to authenticated, service_role;
grant execute on function fn_purge_client(uuid) to authenticated, service_role;
grant execute on function fn_purge_client_photos(uuid) to authenticated, service_role;

-- ── 5. Retention sweep ─────────────────────────────────────────────────────
--
-- GPS traces are the most sensitive time-series here: a route terminating at a
-- named person's front door, several times a week. They have no use after the
-- walk report has been seen, and keeping them forever is a liability that
-- grows on its own.
--
-- The window is a per-operator setting rather than a constant, because the
-- right answer is a business decision and a constant would make it ours. The
-- default is 365 days: long enough that a dispute about a visit last season
-- can still be answered with the route, short enough that "indefinitely" stops
-- being the policy. Zero disables the sweep, which is a choice an operator can
-- defend to their own clients; it is not the default.
alter table operators
  add column gps_retention_days int not null default 365
    check (gps_retention_days >= 0 and gps_retention_days <= 3650);

grant update (gps_retention_days) on operators to authenticated;

comment on column operators.gps_retention_days is
  'Days a walk''s GPS trace is kept before the nightly sweep drops it (review H5). 0 disables the sweep.';

create function fn_sweep_gps_retention()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  if not fn_is_service_session() then
    raise exception 'fn_sweep_gps_retention: service role only';
  end if;

  -- Only completed walks. A walk still in progress, or abandoned and awaiting
  -- an operator (0036), must keep its points however old `started_at` is —
  -- deleting the trace of a walk nobody has finished destroys the only record
  -- of what happened on it.
  with gone as (
    delete from walk_gps_points wg
     using walks w, clients c, operators o
     where wg.walk_id = w.id
       and w.client_id = c.id
       and c.operator_id = o.id
       and o.gps_retention_days > 0
       and w.status = 'completed'
       and w.scheduled_date < current_date - o.gps_retention_days
    returning 1
  ) select count(*) into v_n from gone;

  return v_n;
end;
$$;

revoke all on function fn_sweep_gps_retention() from public, anon, authenticated;
grant execute on function fn_sweep_gps_retention() to service_role;

-- ── 6. Refuse if it did not take ───────────────────────────────────────────
do $$
begin
  if exists (
    select 1 from information_schema.routine_privileges
     where routine_name = 'fn_sweep_gps_retention'
       and grantee in ('authenticated', 'anon')
  ) then
    raise exception '0040: an API role can run the retention sweep — refusing';
  end if;

  if not exists (
    select 1 from information_schema.column_privileges
     where table_name = 'operators' and column_name = 'gps_retention_days'
       and privilege_type = 'UPDATE' and grantee = 'authenticated'
  ) then
    raise exception '0040: the operator cannot set their own retention window — refusing';
  end if;
end;
$$;

-- ── 7. Put the sweep on the nightly job ────────────────────────────────────
--
-- A retention sweep nothing schedules is decoration. This is the same shape as
-- the two advisory sweeps already here (0028 expiry, 0036 abandoned walks):
-- a failure must not cost the operator a calendar, but it must not be SILENT
-- either — a permanently failing sweep reading identically to a quiet night is
-- the exact defect 0028 was written to remove.
--
-- Based on the 0036 body, not 0028's. Replacing this function from an older
-- copy silently drops whatever later migrations added to it — the first draft
-- of this section did precisely that, deleting 0029's email-backlog reporting
-- and 0036's abandoned-walk sweep, and the existing smoke assertions caught it.
-- A `create or replace` is a whole-body rewrite; the only safe source is the
-- most recent definition.
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
  v_stale_walks int := 0;
  v_stale_error text;
  v_gps int := 0;
  v_gps_error text;
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

  begin
    v_stale_walks := fn_sweep_abandoned_walks();
  exception when others then
    v_stale_error := sqlerrm;
    v_ok := false;
  end;

  begin
    v_gps := fn_sweep_gps_retention();
  exception when others then
    v_gps_error := sqlerrm;
    v_ok := false;
  end;

  v_abandoned := fn_expire_notification_backlog();
  select count(*) into v_backlog from fn_notification_backlog();

  update job_runs
     set finished_at = clock_timestamp(),
         ok = v_ok,
         -- All three, not `coalesce`: sweeps must not hide behind each other.
         error = nullif(concat_ws(' | ', v_expiry_error, v_stale_error, v_gps_error), ''),
         detail = jsonb_build_object(
           'created', v_created,
           'expired_clients', v_expired,
           'horizon_days', p_horizon_days,
           'emails_abandoned', v_abandoned,
           'email_backlog', v_backlog,
           'walks_flagged_abandoned', v_stale_walks,
           'gps_points_dropped', v_gps)
   where id = v_run;

  return jsonb_build_object(
    'run_id', v_run,
    'created', v_created,
    'expired_clients', v_expired,
    'expiry_error', v_expiry_error,
    'emails_abandoned', v_abandoned,
    'email_backlog', v_backlog,
    'walks_flagged_abandoned', v_stale_walks,
    'stale_walk_error', v_stale_error,
    'gps_points_dropped', v_gps,
    'gps_error', v_gps_error);
end;
$$;

revoke all on function fn_run_nightly_jobs(int) from public, anon, authenticated;
grant execute on function fn_run_nightly_jobs(int) to service_role;
