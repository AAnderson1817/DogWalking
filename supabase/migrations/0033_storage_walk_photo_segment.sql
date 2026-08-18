-- 0033 — the walk-photo read policy trusted only the second path segment.
--
-- Review L1, and the third of the three policies in this family. `0012` fixed
-- exactly this pattern on the client pet-photo INSERT policy; `0031` fixed the
-- client pet-photo SELECT policy while fixing its dead `pets.name` binding.
-- This is the one left.
--
-- Path convention: {operator_id}/{entity_id}/{uuid}.jpg. The policy asked only
-- whether segment 2 was one of the caller's walks, and never whose folder the
-- object was actually in. So:
--
--   1. operator B uploads `{B}/{walk_belonging_to_A}/x.jpg`
--   2. `storage_operator_insert` allows it — segment 1 IS B's own uid
--   3. operator A's client reads it, because segment 2 is their walk
--
-- The direction is what makes it easy to miss. Nothing of A's leaks OUT; B
-- injects arbitrary images INTO the proof of service A's client receives. For
-- a product whose central promise is photographic evidence that a visit
-- happened, a stranger being able to add pictures to it is a trust failure
-- rather than a privacy one, which is why it does not look like a data breach.
--
-- Rated "low" in the review. Fixed here anyway because it is one predicate,
-- it completes a family where two of three were already done, and a half-fixed
-- pattern is the kind a later reader assumes is finished.

drop policy if exists storage_client_select_walk_photos on storage.objects;
create policy storage_client_select_walk_photos on storage.objects
  for select to authenticated
  using (
    bucket_id = 'walk-photos'
    and exists (
      select 1 from walks w
       where w.id::text = (storage.foldername(storage.objects.name))[2]
         and w.client_id = my_client_id()
         -- The half that was missing. Segment 1 must be the walk's OWN
         -- operator, so an object in anyone else's folder is not this walk's
         -- evidence no matter what its second segment claims.
         and w.operator_id::text = (storage.foldername(storage.objects.name))[1]
    )
  );

-- Qualified `storage.objects.name` for the same reason as 0031: `walks` has no
-- `name` column today, so a bare reference happens to resolve correctly — and
-- that is luck, not design. Adding one later would silently break this policy
-- exactly as `pets.name` broke the other two.
do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'storage' and policyname = 'storage_client_select_walk_photos'
       and qual like '%foldername(objects.name))[1]%'
  ) then
    raise exception '0033: the walk-photo read policy does not check the operator segment';
  end if;
  raise notice '0033: walk-photo reads are scoped to the walk''s own operator folder';
end $$;
