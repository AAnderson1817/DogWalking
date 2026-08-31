-- 0047 — an integrity record for the photos a walk report is made of.
--
-- `walk_photos` records where an object lives and nothing about what it is:
-- `storage_path` and no size, no digest (0002:324). So for any surviving
-- object there has never been a way to ask whether it is still the one that
-- was uploaded.
--
-- ── What this is NOT, stated first, because the existing documents get it
-- ── wrong and shipping under their framing would be the actual harm.
--
-- `docs/dev/disaster-recovery.md` §5 and review B3 both sell this as evidence
-- for a chargeback dispute. It cannot be that. The digest is computed by the
-- operator's own browser, over bytes the operator chose, and stored in a row
-- the operator may DELETE and re-insert at will — `authenticated` holds
-- `select, insert, delete` on this table (0004:328) under
-- `walk_photos_operator_delete ... using (operator_id = auth.uid())`. An
-- operator who wants a different photo on a report deletes the row, uploads
-- new bytes and inserts a new row whose digest matches perfectly.
--
-- So a MATCH proves nothing about authenticity, and a MISMATCH is not evidence
-- of anyone's misconduct. This detects STORAGE DIVERGENCE — an object replaced,
-- a faithless copy restored from a mirror, bit-rot — and nothing else. The
-- distinction matters because a mismatch reported as "tampering" is a false
-- accusation against a named person about a named house, and the most probable
-- cause of one is a bug of ours rather than misconduct of theirs.
--
-- ── And what it adds, given the platform already records something.
--
-- Supabase Storage keeps a server-side `size` and a content-derived `eTag` per
-- object in `storage.objects.metadata`, one join from `storage_path`. Nothing
-- in this repository has ever read it, and DR §5's claim that verification is
-- "impossible even in principle" is simply false. What the platform's copy
-- cannot do is answer this question, because it is REGENERATED: replace an
-- object and its metadata is rewritten to describe the new bytes. A row written
-- once and never updated is the only operand that still describes the past.
--
-- That property is enforced by the grant rather than asserted: there is no
-- UPDATE grant on `walk_photos` for any API role, so neither column can be
-- rewritten by the browser that wrote it. Verified on this schema:
--   has_table_privilege('authenticated','walk_photos','UPDATE') -> false
--
-- ── Nullable, and never backfilled.
--
-- Every row that exists today keeps a NULL digest, permanently. A digest can
-- only be computed from the bytes at the moment they are uploaded, and a value
-- reconstructed later would be indistinguishable from a real one — the rule
-- 0023 and 0029 already apply to payments and to notification delivery.
--
-- NULL is therefore a THIRD state, not a failure: "not recorded". Anything
-- reading these columns must report match / mismatch / not-recorded and never
-- collapse the last two, which is why `scripts/verify-photo-integrity.sh`
-- reports coverage as well as mismatches.
--
-- A second writer guarantees NULLs will keep appearing. `complete-walk` upserts
-- photo rows from the completion request, where it has paths and no bytes; it
-- cannot compute a digest and must not invent one. Its `ignoreDuplicates: true`
-- is load-bearing for integrity rather than merely for row counts — measured on
-- this schema:
--   after DO NOTHING replay: sha256=deadbeef  byte_size=123    -- preserved
--   after DO UPDATE  replay: sha256=(null)    byte_size=(null) -- erased
-- so a row the browser wrote first keeps its digest, and a row complete-walk
-- wins the race for has none and can never be filled.

alter table walk_photos
  -- Lower-case hex rather than bytea: every consumer is a shell script or a
  -- human comparing against `sha256sum` output, and the CHECK is what keeps
  -- the one representation honest. A digest of the wrong case, or a truncated
  -- one, is refused at write time rather than discovered at verification time.
  add column sha256 text
    constraint walk_photos_sha256_hex check (sha256 ~ '^[0-9a-f]{64}$'),
  -- Bytes of the object as uploaded. Cheap triage: a bucket listing answers it
  -- for thousands of rows without downloading anything, where the digest needs
  -- every object fetched. `> 0` because a zero-byte photo is a failed upload
  -- wearing a successful one's clothes.
  add column byte_size integer
    constraint walk_photos_byte_size_positive check (byte_size > 0);

comment on column walk_photos.sha256 is
  'SHA-256, lower-case hex, of the object bytes as uploaded. Written once by '
  'the browser at upload; NULL means not recorded, never "failed". Detects '
  'storage divergence, NOT tampering: the operator controls both operands.';
comment on column walk_photos.byte_size is
  'Size in bytes of the object as uploaded. Screens for divergence without '
  'downloading the object. NULL means not recorded.';

-- The table-level grant (0004:328) extends to columns added later, so nothing
-- here needs a new GRANT — and converting it to a column list would be the
-- `fix(client-columns)` trap, where a withheld column made `select("*")` fail
-- with a bare 42501 for every read of the table. `listWalkPhotos` uses a
-- wildcard and must keep working.
--
-- Asserted rather than assumed, because a migration that silently left the new
-- columns unreadable would break the photo strip on every walk.
do $$
begin
  if not has_column_privilege('authenticated', 'walk_photos', 'sha256', 'SELECT')
     or not has_column_privilege('authenticated', 'walk_photos', 'sha256', 'INSERT')
     or not has_column_privilege('authenticated', 'walk_photos', 'byte_size', 'SELECT')
     or not has_column_privilege('authenticated', 'walk_photos', 'byte_size', 'INSERT')
  then
    raise exception 'the new walk_photos integrity columns are not readable or '
      'writable by authenticated — the table grant is no longer table-level';
  end if;

  -- The other half of the same property: writable ONCE. If an UPDATE grant
  -- ever appears, the digest stops being a record of the past and this
  -- migration's whole argument goes with it.
  if has_column_privilege('authenticated', 'walk_photos', 'sha256', 'UPDATE') then
    raise exception 'authenticated can UPDATE walk_photos.sha256 — an integrity '
      'record that its own writer can rewrite records nothing';
  end if;
end $$;
