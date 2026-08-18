-- 0021 — the vault master key had one copy, no identity, and no rotation path.
--
-- Review 2026-08 finding B2 (issue #11). The stored blob was
-- `iv(12) ‖ tag(16) ‖ ct` with no version and no key id, so nothing recorded
-- which key wrote a row. Two keys could therefore never coexist, and rotation
-- was not merely difficult — it was structurally impossible. The key existed
-- only as a GitHub environment secret that cannot be read back, so losing it
-- meant every stored door code became permanently unreadable, and the cutover
-- runbook said exactly that.
--
-- The edge function now writes a v2 blob:
--
--   version(1) ‖ key_id(8) ‖ iv(12) ‖ ct‖tag
--
-- where key_id is HKDF-derived from the master key, so it cannot disagree with
-- the key it names. This migration gives the database the three things the
-- rotation needs and nothing more:
--
--   1. key_id on access_credentials, so "which rows are still on the old key"
--      is a query rather than a decrypt-everything scan;
--   2. a canary, so a wrong key is detected at deploy time instead of at a
--      client's front door;
--   3. a compare-and-swap rewrap primitive and an honest census, so the
--      rotation is resumable and its completion gate cannot fail open.
--
-- Deliberately NOT here: any re-encryption logic. The key lives only in the
-- edge function, so only the edge function can decrypt and re-encrypt. SQL's
-- job is to hand out work and to accept results safely.

-- ── 1. key_id — derived from the blob, never asserted ────────────────────
-- A GENERATED column, not an ordinary one. It reads the key id out of the
-- ciphertext itself, so it cannot drift from the blob, cannot be forged, and
-- cannot be left stale by a writer that forgot to set it. Postgres refuses to
-- update it at all, for every role, which is a stronger guarantee than any
-- grant or trigger could give.
--
-- It also needs no default and no backfill: existing rows get the right answer
-- automatically. The two pre-v2 fixtures (seed.sql and smoke.sql) are not
-- valid AES-GCM under any key, and this correctly labels them with whatever
-- their bytes say rather than tagging them with a real key id — so the census
-- below reports them as unreadable instead of quietly claiming they are fine.
alter table access_credentials
  add column key_id text
  generated always as (
    case
      when octet_length(ciphertext) >= 37 and get_byte(ciphertext, 0) = 2
      then encode(substring(ciphertext from 2 for 8), 'hex')
    end
  ) stored;

comment on column access_credentials.key_id is
  'v2 blob key id, derived from the ciphertext. NULL means the row is not a '
  'readable v2 blob. Generated: it can never disagree with the bytes it '
  'describes.';

create index idx_access_credentials_key_id on access_credentials (key_id);

-- NOT granted to authenticated. The 10-column SELECT grant in 0004 is closed,
-- and a generated column cannot be inserted or updated by anyone, so there is
-- nothing to revoke — but state it, because "we did not add a grant" is
-- otherwise invisible to a reviewer diffing this file.
revoke all (key_id) on access_credentials from authenticated, anon;

-- ── 2. The canary ────────────────────────────────────────────────────────
-- One row per project holding a known plaintext encrypted under the current
-- key. The deploy verifies it through the LIVE function, which tests the
-- property that actually matters — the key running in the deployed isolate can
-- decrypt data written by the key we think is current — rather than comparing
-- secret bytes, which would only test that two strings match.
--
-- This is also the per-environment key pin. It lives in each project's own
-- database, so staging and production pin different keys with no shared file
-- to disagree about, and nothing to keep in sync by hand.
create table vault_canary (
  id boolean primary key default true check (id),
  ciphertext bytea not null,
  key_id text generated always as (
    case
      when octet_length(ciphertext) >= 37 and get_byte(ciphertext, 0) = 2
      then encode(substring(ciphertext from 2 for 8), 'hex')
    end
  ) stored,
  updated_at timestamptz not null default now()
);

comment on table vault_canary is
  'Single-row key pin: a known plaintext under the current vault key. The '
  'deploy decrypts it through the live function; failure means the deployed '
  'key cannot read this project''s data.';

alter table vault_canary enable row level security;
alter table vault_canary force row level security;
-- No policies and no grants: service_role only, via the edge function.
revoke all on vault_canary from public, anon, authenticated;

-- ── 3. Census ────────────────────────────────────────────────────────────
-- Every number the rotation reports comes from here, and it is deliberately
-- NOT a single count. A gate written as `count(*) where key_id <> current = 0`
-- is satisfied both by "everything is rewrapped" and by "I cannot see any
-- rows" — so a permissions mistake, a search_path surprise or an empty
-- database would green-light retiring the old key and destroy every secret.
--
-- Returning total, on_primary, on_other and unreadable makes the arithmetic
-- checkable: the caller asserts total = on_primary + on_other + unreadable AND
-- on_other = 0, which "I see nothing" cannot satisfy unless the table really
-- is empty.
create or replace function fn_vault_census(p_key_id text)
returns table (total bigint, on_primary bigint, on_other bigint, unreadable bigint)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*) as total,
    count(*) filter (where key_id = p_key_id) as on_primary,
    count(*) filter (where key_id is not null and key_id <> p_key_id) as on_other,
    count(*) filter (where key_id is null) as unreadable
  from access_credentials
  where revoked_at is null;
$$;

revoke all on function fn_vault_census(text) from public, anon, authenticated;
grant execute on function fn_vault_census(text) to service_role;

-- ── 4. Rewrap work queue ─────────────────────────────────────────────────
-- Hands out a batch of rows that are not yet on the current key. The work
-- queue IS the data — there is no journal, no cursor and no checkpoint to get
-- out of step with reality, so an interrupted rewrap resumes simply by being
-- run again, and a row already done is not selected a second time.
--
-- Rows whose key_id is null (not a readable v2 blob) are returned too: the
-- caller must be able to see them to report them. It must not silently skip
-- them, and it must not mark them permanently dead either — a row encrypted
-- under a key nobody supplied today becomes readable the moment that key is
-- supplied, and a journal that recorded it as terminal would have thrown that
-- recoverability away.
create or replace function fn_vault_rewrap_batch(p_key_id text, p_limit int default 50)
returns table (id uuid, operator_id uuid, ciphertext bytea, key_id text)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.operator_id, c.ciphertext, c.key_id
    from access_credentials c
   where c.revoked_at is null
     and (c.key_id is distinct from p_key_id)
   order by c.created_at
   limit greatest(1, least(p_limit, 500));
$$;

revoke all on function fn_vault_rewrap_batch(text, int) from public, anon, authenticated;
grant execute on function fn_vault_rewrap_batch(text, int) to service_role;

-- ── 5. Rewrap apply — compare and swap ───────────────────────────────────
-- Writes a re-encrypted blob only if the row still holds the ciphertext the
-- caller decrypted. That single condition makes the whole rotation safe
-- without locks:
--
--   * two rewrap runs racing the same row — the loser's update matches nothing
--     and returns false; it does not clobber the winner;
--   * an operator rotating a credential mid-rewrap — the row's ciphertext has
--     changed, so the stale re-encryption is refused rather than overwriting a
--     newer secret with an older one;
--   * a lost HTTP response — the update already committed, and the row is
--     simply not selected by the next batch.
--
-- It also refuses to write a blob that is not a v2 blob under the expected new
-- key, so a bug in the caller cannot store something unreadable.
create or replace function fn_vault_rewrap_apply(
  p_id uuid,
  p_expect_ciphertext bytea,
  p_new_ciphertext bytea,
  p_expect_key_id text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_key_id text;
begin
  if p_new_ciphertext is null or octet_length(p_new_ciphertext) < 37
     or get_byte(p_new_ciphertext, 0) <> 2 then
    raise exception 'fn_vault_rewrap_apply: replacement is not a v2 blob';
  end if;

  v_new_key_id := encode(substring(p_new_ciphertext from 2 for 8), 'hex');
  if v_new_key_id <> p_expect_key_id then
    raise exception 'fn_vault_rewrap_apply: replacement is under key %, expected %',
      v_new_key_id, p_expect_key_id;
  end if;

  update access_credentials
     set ciphertext = p_new_ciphertext,
         updated_at = now()
   where id = p_id
     and ciphertext = p_expect_ciphertext;

  return found;
end;
$$;

revoke all on function fn_vault_rewrap_apply(uuid, bytea, bytea, text)
  from public, anon, authenticated;
grant execute on function fn_vault_rewrap_apply(uuid, bytea, bytea, text) to service_role;

-- ── 6. Canary upsert ─────────────────────────────────────────────────────
-- Replaces the pin with a blob under the current key. Same v2 assertion as
-- above: the pin must be readable, or it is not a pin.
create or replace function fn_vault_set_canary(p_ciphertext bytea)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key_id text;
begin
  if p_ciphertext is null or octet_length(p_ciphertext) < 37
     or get_byte(p_ciphertext, 0) <> 2 then
    raise exception 'fn_vault_set_canary: not a v2 blob';
  end if;
  v_key_id := encode(substring(p_ciphertext from 2 for 8), 'hex');

  insert into vault_canary (id, ciphertext, updated_at)
  values (true, p_ciphertext, now())
  on conflict (id) do update
    set ciphertext = excluded.ciphertext,
        updated_at = now();

  return v_key_id;
end;
$$;

revoke all on function fn_vault_set_canary(bytea) from public, anon, authenticated;
grant execute on function fn_vault_set_canary(bytea) to service_role;
