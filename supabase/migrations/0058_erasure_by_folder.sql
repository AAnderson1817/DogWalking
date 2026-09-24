-- 0058 — an erasure deletes every photo in the client's folders, and says
-- whether it has finished.
--
-- An erasure is two phases (0040). `fn_purge_client` redacts the record and
-- hands the browser the storage objects to delete; `fn_purge_client_photos`
-- then drops the rows that were keeping track of them. Four defects lived in
-- how the first phase chose those objects and how anyone learned that the
-- second had run.
--
-- 1. It never finished for a client whose pet had a photo. The paths came back
--    bare and the browser guessed the bucket from their shape, sending every
--    pet photo to walk-photos, where there was nothing to delete; the second
--    phase never ran. Each path now starts with the bucket that holds it.
--
-- 2. It named only the photos a row still pointed at. Replacing a pet's photo
--    uploads a new object and overwrites `pets.photo_path`, and nothing has
--    ever deleted the old one; a walk photo whose row failed to insert after
--    its upload has no row at all. Both survived every erasure, while the
--    privacy notice said photos are destroyed. Every uploader writes
--    `{operator}/{walk or pet}/{file}`, the layout the storage policies read
--    (0004, 0031, 0033), so the client's photos are exactly the objects in the
--    folders of their walks and their pets. The first phase now reads those
--    folders from `storage.objects` instead of reading paths off the rows.
--
-- 3. Nothing could tell the browser that the objects were really gone. It
--    took `exists()` answering false as proof, but Storage answers a HEAD it
--    refuses (an expired token, a missing bucket) with the same 400 it uses
--    for "not found", so a retry could drop the rows over objects still
--    there. The database can see `storage.objects` itself: the second phase
--    now refuses while any object remains in those folders, and
--    `fn_purge_client_status` answers whether the erasure has finished.
--
-- 4. After a reload an unfinished erasure looked finished. `purged_at` is set
--    by the first phase, the screen read it as "erased" and hid the button,
--    and the pets rows — names, medical and medication notes, vet details —
--    waited for a second phase nobody could start again. The first phase now
--    redacts the pets rows and deletes the photo rows itself, so an unfinished
--    erasure leaves only photos. The screen asks `fn_purge_client_status`,
--    and a retry keeps the original `purged_at`.
--
-- A folder stays findable for good. A pet's id is its folder's only name, so
-- its redacted row is never deleted: the storage policy lets a walker write
-- anywhere in their own folder, so a photo can land in an erased client's pet
-- folder after the erasure — or during it — and the next status check must
-- still find it. Walk rows survive an erasure anyway (they carry the billing
-- record). Both are tombstones, as the client, property and credential rows
-- already are: a row holding no personal data, kept because something else
-- needs its id.
--
-- And a pet's tombstone stays one. An edit sheet left open in another tab
-- while the erasure ran would otherwise save the pet's name and medical notes
-- straight back into it, and the status, which counts photos, would still
-- read finished. A trigger refuses that save, a new pet for an erased client,
-- and the deletion of an erased client's pet (the last section below).
--
-- What this cannot find: a photo in the folder of a pet or walk whose row was
-- deleted outside the product. Nothing in the app deletes either, and an
-- object names no client, so there is nothing to attribute it by.
--
-- ── Reading storage.objects ──────────────────────────────────────────────
-- These functions run as their owner, the role migrations run as. On hosted
-- Supabase `storage.objects` belongs to supabase_storage_admin, and this
-- project already needs membership of that role to create the policies in
-- 0031 and 0033 (db-push-check.sh models it). The table has row security on;
-- the owner reads past it with BYPASSRLS, which the definer functions over
-- FORCE-RLS tables already rely on (db-push-requirements.md). Both are checked
-- below rather than assumed: a purge that cannot see the photos would report
-- every erasure finished.
--
-- Rebuilt from the live `fn_purge_client` (0057's body, verified identical)
-- and the live `fn_purge_client_photos` (0040's, via 0055), with the changes
-- above and nothing else.

-- ── The client's photos: every object in the folders of their walks and pets
create function fn_client_photo_objects(p_client uuid)
returns table(bucket text, name text)
language sql
stable
set search_path = public, pg_temp
as $function$
  -- A walk photo's first folder is the walker and its second the walk; a pet
  -- photo's the walker, then the pet. The second folder is matched by
  -- equality, so the planner can join once over the bucket instead of once
  -- per walk. A third segment is required: a file sitting directly in the
  -- walker's folder and named after a walk is not inside that walk's folder,
  -- which is how the policies' `storage.foldername(name)[2]` reads it too.
  select o.bucket_id, o.name
    from clients c
    join walks w on w.client_id = c.id
    join storage.objects o
      on o.bucket_id = 'walk-photos'
     and starts_with(o.name, c.operator_id::text || '/')
     and split_part(o.name, '/', 2) = w.id::text
     and split_part(o.name, '/', 3) <> ''
   where c.id = p_client
  union all
  select o.bucket_id, o.name
    from clients c
    join pets pe on pe.client_id = c.id
    join storage.objects o
      on o.bucket_id = 'pet-photos'
     and starts_with(o.name, c.operator_id::text || '/')
     and split_part(o.name, '/', 2) = pe.id::text
     and split_part(o.name, '/', 3) <> ''
   where c.id = p_client
$function$;

-- Only ever called by the three functions below, as their owner.
revoke all on function fn_client_photo_objects(uuid) from public, anon, authenticated;

-- ── Phase 1 ──────────────────────────────────────────────────────────────
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

  -- The photo rows go now (0058): the walks that name their folders survive
  -- the erasure. A pet's row is its folder's only name, so it stays for good,
  -- redacted: a photo that lands in that folder later is still found.
  delete from walk_photos wph
   using walks w where wph.walk_id = w.id and w.client_id = p_client;

  update pets
     set name = 'Removed', breed = null, size = null, temperament = null,
         medical_notes = null, feeding_notes = null, medication_notes = null,
         vet_name = null, vet_phone = null, photo_path = null,
         is_reactive = false, is_escape_risk = false, active = false
   where client_id = p_client;

  -- The tombstone moves ABOVE the attempt delete. `purged_at` is what
  -- authorises that delete, so writing it afterwards leaves the purge raising.
  -- A retry keeps the date the erasure began (0058).
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
         purged_at = coalesce(purged_at, now())
   where id = p_client;

  -- `attempted_email` is the personal data here — the address somebody used to
  -- try this invite. It goes with the rest of the record.
  delete from invite_claim_attempts where client_id = p_client;

  -- Every object in the client's folders, each starting with the bucket that
  -- holds it (0058). All of them are in this walker's folder, which the
  -- storage policies let them delete.
  return query
    select po.bucket || '/' || po.name from fn_client_photo_objects(p_client) po;
end;
$function$;

-- ── Phase 2 ──────────────────────────────────────────────────────────────
create or replace function fn_purge_client_photos(p_client uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_op   uuid := (select auth.uid());
  v_left int;
  v_n    int := 0;
begin
  if not exists (
    select 1 from clients where id = p_client and operator_id = v_op
  ) then
    raise exception 'fn_purge_client_photos: no such client';
  end if;
  if not exists (select 1 from clients where id = p_client and purged_at is not null) then
    raise exception 'fn_purge_client_photos: this client has not been erased';
  end if;

  -- Nothing is finished while a photo remains (0058).
  select count(*) into v_left from fn_client_photo_objects(p_client);
  if v_left > 0 then
    raise exception 'fn_purge_client_photos: % photo(s) are still in storage', v_left;
  end if;

  -- The first phase deleted the photo rows; these are any written since, by
  -- an upload that finished after it. The pets rows are not deleted: each is
  -- its folder's only name (0058).
  with gone as (
    delete from walk_photos wp
     using walks w
     where wp.walk_id = w.id and w.client_id = p_client
    returning 1
  ) select count(*) into v_n from gone;

  return v_n;
end;
$function$;

-- ── Has the erasure finished? ────────────────────────────────────────────
-- Read-only, so the screen can ask on load. `photos_left` is what storage
-- still holds in the client's folders; `finished` also needs every photo row
-- gone, which a photo row written after the first phase is not.
create function fn_purge_client_status(p_client uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_purged boolean;
  v_left   int;
begin
  select purged_at is not null into v_purged
    from clients where id = p_client and operator_id = (select auth.uid());
  if v_purged is null then
    raise exception 'fn_purge_client_status: no such client';
  end if;

  select count(*) into v_left from fn_client_photo_objects(p_client);

  return jsonb_build_object(
    'erased', v_purged,
    'photos_left', v_left,
    'finished', v_purged and v_left = 0
                and not exists (select 1 from walk_photos wp join walks w on w.id = wp.walk_id
                                 where w.client_id = p_client));
end;
$function$;

revoke all on function fn_purge_client_status(uuid) from public, anon, authenticated;
grant execute on function fn_purge_client_status(uuid) to authenticated;

-- ── Erasures that stopped before their second phase ─────────────────────
-- Every erasure of a client whose pet had a photo stopped after its first
-- phase (defect 1), and that phase did not touch the pets, so those clients'
-- pets still carry their names, medical notes and vet details, and their photo
-- rows are still there. Bring each erased client to where the first phase
-- now leaves one. Their photos cannot be deleted from SQL; the screen's status
-- check finds them and offers "Finish erasing". Only staging can hold such a
-- client: production has never run.
update pets p
   set name = 'Removed', breed = null, size = null, temperament = null,
       medical_notes = null, feeding_notes = null, medication_notes = null,
       vet_name = null, vet_phone = null, photo_path = null,
       is_reactive = false, is_escape_risk = false, active = false
  from clients c
 where p.client_id = c.id and c.purged_at is not null;

delete from walk_photos wph
 using walks w, clients c
 where wph.walk_id = w.id and w.client_id = c.id and c.purged_at is not null;

-- ── A pet's tombstone stays one ──────────────────────────────────────────
-- The operator policy on pets reads only `operator_id`, so nothing in the
-- database stopped a save from a tab opened before the erasure (Codex on PR
-- #106). An erased client's pet does not change, no pet arrives at an erased
-- client, and an erased client's pet is never deleted: its row is its photo
-- folder's only name.
--
-- "Does not change" rather than "must look redacted": comparing the whole row
-- keeps one definition of the tombstone, the purge's own, instead of a second
-- copy here that a column added later could slip past. The purge redacts the
-- pets before it sets `purged_at`, so its first pass is untouched by this, and
-- a retry writes back what is already there. The repair above is the one
-- statement that turns an erased client's pet into a tombstone after the
-- fact, which is why this is created after it.
--
-- A pet arriving at an erased client reads the client FOR KEY SHARE, as 0057's
-- notices do: the purge holds that row FOR UPDATE until it commits, so a pet
-- added while an erasure is in flight waits for it and then sees it. A change
-- to an erased client's pet needs no lock of its own. The purge's redaction
-- locks each pet row, a save racing it waits on that row, and the read below
-- is a new statement, so it sees the committed erasure. Taking the client
-- lock there would also invert the purge's order, client then pets.
create function fn_guard_erased_pet()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_erased boolean;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select purged_at is not null into v_erased from clients where id = old.client_id;
    if v_erased then
      if tg_op = 'DELETE' then
        raise exception 'pets: % belongs to an erased client, and its row is the only name of its photo folder', old.id;
      end if;
      if (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
        raise exception 'pets: % belongs to an erased client, so it stays as the erasure left it', old.id;
      end if;
      return new;
    end if;
    if tg_op = 'DELETE' then
      return old;
    end if;
  end if;

  if tg_op = 'INSERT' or new.client_id is distinct from old.client_id then
    select purged_at is not null into v_erased
      from clients where id = new.client_id
       for key share;
    if v_erased then
      raise exception 'pets: client % has been erased', new.client_id;
    end if;
  end if;
  return new;
end;
$function$;

-- Never called directly, and EXECUTE is checked when the trigger is created,
-- not when it fires (0053).
revoke all on function fn_guard_erased_pet() from public, anon, authenticated;

-- No `OF` column list: it is evaluated against the columns a statement names,
-- and this must see every change (the 0046 lesson, as 0057 applies it).
create trigger trg_pets_erased
  before insert or update or delete on pets
  for each row execute function fn_guard_erased_pet();

-- ── Refuse if the owner cannot see the photos ────────────────────────────
do $$
declare
  v_owner oid := (select relowner from pg_class where oid = 'storage.objects'::regclass);
  v_forced boolean := (select relforcerowsecurity from pg_class where oid = 'storage.objects'::regclass);
begin
  if not has_table_privilege(current_user, 'storage.objects', 'select') then
    raise exception '0058: % cannot read storage.objects, so no erasure could find a photo — refusing', current_user;
  end if;
  if not (select rolsuper or rolbypassrls from pg_roles where rolname = current_user)
     and not (pg_has_role(current_user, v_owner, 'usage') and not v_forced) then
    raise exception '0058: row security on storage.objects would hide every photo from % — refusing', current_user;
  end if;
  if has_function_privilege('authenticated', 'fn_client_photo_objects(uuid)', 'execute')
     or has_function_privilege('anon', 'fn_purge_client_status(uuid)', 'execute') then
    raise exception '0058: an API role can call what it should not — refusing';
  end if;
end $$;
