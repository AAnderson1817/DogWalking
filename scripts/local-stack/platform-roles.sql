-- What the PLATFORM provides, and what the role running `supabase db push`
-- must therefore already hold (review M5). Applied on top of shim.sql by
-- scripts/db-push-check.sh, and by nothing else.
--
-- shim.sql answers "do the objects a migration references exist?". This file
-- answers a different and harder question: "is the role applying them ALLOWED
-- to?" CI has never been able to ask it, because `scripts/db-reset.sh`
-- connects as the local cluster's bootstrap superuser and a superuser skips
-- every ownership and privilege check there is. Hosted Supabase's `postgres`
-- is not a superuser. So a migration can be green here for the single reason
-- that nothing checked, and fail on the deploy that matters.
--
-- ── This is a MODEL, and here is its boundary ─────────────────────────────
--
-- Every line below is a requirement DISCOVERED by removing privileges until
-- the migrations stopped applying — not a transcription of hosted Supabase's
-- role graph, which cannot be read from this repository. So:
--
--   * "these migrations need exactly this much" is proved, by construction:
--     db-push-check.sh applies all of them under precisely this set.
--   * "hosted Supabase grants exactly this much" is NOT proved. It is the
--     checklist in docs/dev/db-push-requirements.md, to be run against the
--     real project once, before the first production `db push`.
--
-- Keeping those two apart is the whole point. The previous state of the world
-- was a runbook paragraph about a "must be owner of table objects" failure
-- that nobody could confirm or refute.

-- ── Start from nothing ───────────────────────────────────────────────────
-- Roles are CLUSTER-wide, not per-database, so dropping and recreating the
-- check's database does not reset them. Without this, a privilege deleted from
-- this file would still be in effect on any machine that had run the previous
-- version — the check would keep passing on a grant it no longer makes, which
-- is precisely the "green for a reason nobody chose" failure it exists to
-- remove. Caught by sabotaging a grant and watching the check stay green.
--
-- `drop owned by` covers privileges and ownership in THIS database, which was
-- created moments ago and is empty of anything these roles could hold. The
-- shared API roles (anon, authenticated, service_role) are shim.sql's and are
-- deliberately left alone: db-reset.sh depends on them.
do $$
declare r text;
begin
  foreach r in array array['sb_deploy', 'supabase_storage_admin', 'supabase_realtime_admin'] loop
    if exists (select from pg_roles where rolname = r) then
      execute format('drop owned by %I', r);
      begin
        execute format('drop role %I', r);
      exception when dependent_objects_still_exist then
        -- `drop owned by` reaches only the CURRENT database. Another database
        -- on this cluster is holding the role — in practice a scratch copy of
        -- this check left behind by an interrupted run.
        raise exception 'cannot reset role % — another database on this cluster still holds objects it owns (%). Drop that database and re-run; leaving the role in place would let this check keep passing on privileges the repository no longer grants.', r, sqlerrm;
      end;
    end if;
  end loop;
end
$$;

-- ── Roles the platform owns ──────────────────────────────────────────────
-- On hosted Supabase `storage.objects` is owned by supabase_storage_admin and
-- `realtime.messages` by supabase_realtime_admin — NOT by the role running
-- migrations. That matters because `create policy` requires ownership, and
-- five migrations create policies on those two tables.
create role supabase_storage_admin nologin;
create role supabase_realtime_admin nologin;

alter table storage.objects owner to supabase_storage_admin;
alter table storage.buckets owner to supabase_storage_admin;
alter table realtime.messages owner to supabase_realtime_admin;

-- ── Extensions the platform pre-installs ─────────────────────────────────
-- 0001 opens with `create extension if not exists pgcrypto`. A non-superuser
-- cannot create an extension, and does not have to: `IF NOT EXISTS` returns
-- before the privilege check when the extension is already there, which on
-- hosted Supabase it always is. Installing it here as the superuser is what
-- makes that line a no-op rather than the first thing that fails.
create extension if not exists pgcrypto;

-- ── The role `supabase db push` connects as ──────────────────────────────
-- Named sb_deploy because the local cluster's `postgres` IS the superuser and
-- cannot be made to stand in for a hosted role that is not one.
-- The password is not a secret and is not meant to be one: this role exists
-- for the length of one check, on a throwaway database, and the connection has
-- to work whether the local cluster is `trust` (a laptop) or password-only
-- (CI's postgres service container).
--
-- It is duplicated in db-push-check.sh's DEPLOY_PASSWORD, because this file is
-- plain SQL and cannot read a shell variable. Changing one without the other
-- fails loudly and immediately — the first `psql` as sb_deploy is refused —
-- rather than silently weakening anything, but change both.
create role sb_deploy login nosuperuser createrole createdb password 'sanpo_local_check';

-- BYPASSRLS is the requirement with the sharpest consequence, and it is not
-- about applying migrations at all — every migration applies without it. It is
-- about whether the schema WORKS afterwards.
--
-- 0004 puts `force row level security` on every tenant table. FORCE means the
-- table's own owner is subject to its policies, and a SECURITY DEFINER
-- function executes as its owner. So without BYPASSRLS, the ~50 definer
-- functions this project runs on — the entire credit engine, the vault, the
-- materializer — read zero rows from tables they own, and write nothing.
--
-- Locally that has always been invisible: superusers bypass RLS unconditionally,
-- so CI has been exercising the one configuration in which the question cannot
-- come up. db-push-check.sh DEMONSTRATES the mechanism rather than trusting
-- this comment: it builds a throwaway FORCE-RLS table and definer function
-- owned by sb_deploy and shows the count go 1 -> 0 when the attribute is
-- removed.
alter role sb_deploy bypassrls;

-- ── Membership ───────────────────────────────────────────────────────────
-- anon/authenticated/service_role: migrations GRANT to these, and granting
-- requires either being a member or holding the privilege with grant option.
-- The two admin roles: ownership of the platform tables the policies sit on.
-- Membership suffices for an ownership check — Postgres tests ownership with
-- has_privs_of_role, not role identity — which is why `db push` can create a
-- policy on a table it does not literally own.
grant anon, authenticated, service_role to sb_deploy;
grant supabase_storage_admin, supabase_realtime_admin to sb_deploy;

-- ── Schema-level ─────────────────────────────────────────────────────────
-- Everything this project creates lives in `public`, so the deploy role owns
-- it, as on hosted.
alter schema public owner to sb_deploy;

-- Foreign keys to auth.users need REFERENCES on it — nothing more. The
-- migrations never select from auth.users at apply time; 0035's read of
-- encrypted_password is inside a function body, resolved at execution.
grant references on auth.users to sb_deploy;

grant usage on schema auth, storage, realtime, cron to sb_deploy;

-- pg_cron's tables. 0028 calls cron.schedule(), which inserts into cron.job as
-- the CALLING role — it is not a definer function — so usage on the schema
-- alone leaves it with permission denied for table job.
grant all privileges on all tables in schema cron to sb_deploy;
