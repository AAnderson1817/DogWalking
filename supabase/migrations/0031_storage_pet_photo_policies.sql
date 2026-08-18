-- 0031 — the client pet-photo policies referenced the wrong `name` column.
--
-- Found by writing the storage tests review H20 asked for. Both client
-- pet-photo policies read:
--
--     exists (select 1 from pets p
--              where p.id::text = (storage.foldername(name))[2] ...)
--
-- `name` is unqualified, and `pets` HAS a `name` column — the pet's name. So
-- Postgres resolved it to `p.name`, and the policy has been asking whether the
-- second path segment of the string "Luna" is a pet id. It never is.
--
-- Confirmed against the installed catalogue rather than the source: pg_policies
-- renders the predicate as `storage.foldername(p.name)`, while the sibling
-- walk-photo policy renders as `storage.foldername(objects.name)` — correct
-- only because `walks` happens to have no `name` column to shadow it. The two
-- policies are written identically and mean different things.
--
-- Same shape as `fn_book_walk` filtering a `service_types.active` column that
-- never existed (review B1): a column reference resolved at execution time, so
-- the migration installed cleanly and the defect waited for a caller.
--
-- IMPACT. Permissive policies grant; a broken one denies. So this is not a
-- breach — it is a total functionality failure that has been live since 0008:
-- a client has never been able to see or upload a pet photo. And it means the
-- cross-tenant write hole 0012 closed was closed in a predicate that granted
-- nothing anyway, which is why nobody noticed either.
--
-- The fix qualifies the column explicitly. `storage.objects.name` rather than
-- a bare `name`, everywhere, so no future table with a `name` column can
-- silently capture it again.

-- ── Client reads their own pets' photos ──────────────────────────────────
drop policy if exists storage_client_pet_photos on storage.objects;
create policy storage_client_pet_photos on storage.objects
  for select to authenticated
  using (
    bucket_id = 'pet-photos'
    and exists (
      select 1 from pets p
       where p.id::text = (storage.foldername(storage.objects.name))[2]
         and p.client_id = my_client_id()
         -- Segment 1 is checked on read as well as on write. The pet already
         -- pins the tenant, so this is defence in depth rather than the
         -- boundary — but it makes the read and write predicates identical,
         -- and a pair that must agree is safer written the same way twice
         -- than written two ways that happen to agree today.
         and p.operator_id::text = (storage.foldername(storage.objects.name))[1]
    )
  );

-- ── Client uploads a photo of their own pet, in that pet's operator folder ─
-- Keeps 0012's segment-1 tenant check, which is the half that was deliberate.
drop policy if exists storage_client_pet_photos_insert on storage.objects;
create policy storage_client_pet_photos_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'pet-photos'
    and exists (
      select 1 from pets p
       where p.id::text = (storage.foldername(storage.objects.name))[2]
         and p.client_id = my_client_id()
         and p.operator_id::text = (storage.foldername(storage.objects.name))[1]
    )
  );

-- Assert the fix rather than trust it: re-read the installed predicates and
-- refuse the migration if either still resolves the column to `pets`. An
-- inert policy that deployed cleanly is exactly the failure being fixed here,
-- and this file would otherwise be indistinguishable from the one before it.
do $$
declare bad text;
begin
  select string_agg(policyname, ', ' order by policyname) into bad
    from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname in ('storage_client_pet_photos', 'storage_client_pet_photos_insert')
     and coalesce(qual, '') || coalesce(with_check, '') like '%foldername(p.name)%';
  if bad is not null then
    raise exception '0031: policy still reads pets.name: %', bad;
  end if;

  -- And that they exist at all: `drop policy if exists` followed by a create
  -- that silently did not run would leave the client with no access and no
  -- error.
  if (select count(*) from pg_policies
       where schemaname = 'storage' and tablename = 'objects'
         and policyname in ('storage_client_pet_photos', 'storage_client_pet_photos_insert')) <> 2 then
    raise exception '0031: both client pet-photo policies must exist';
  end if;
  raise notice '0031: client pet-photo policies now read storage.objects.name';
end $$;
