-- 0032 — RLS had drifted from the schema, and the check that would notice it
-- was a hardcoded list (review M31).
--
-- `0004_security.sql` is the ONLY place RLS is ever enabled, and it iterates a
-- literal array of the 18 tables that existed in 0002. Three tables have been
-- added since:
--
--   plan_change_intents        (0015) — no RLS at all
--   vault_rate_limit_attempts  (0016) — no RLS at all
--   job_runs                   (0028) — enabled, never FORCED
--
-- No live exposure today: the grants hold (`revoke all … from public, anon,
-- authenticated`) and PostgREST cannot reach any of them. That is exactly what
-- makes it dangerous — the protection is a single `revoke` with no defence
-- behind it, so one future blanket `grant` fails open with nothing to catch
-- it, and invariant 7 has no automated enforcement whatsoever.
--
-- FORCE matters as well as ENABLE: without it RLS does not apply to the table
-- owner. Superusers bypass regardless, which is why the definer functions that
-- read these tables are unaffected — verified by running the smoke,
-- materializer and concurrency suites after this migration.

alter table plan_change_intents enable row level security;
alter table plan_change_intents force row level security;
alter table vault_rate_limit_attempts enable row level security;
alter table vault_rate_limit_attempts force row level security;
alter table job_runs force row level security;

-- Deliberately NO policies on any of the three. Deny-all is correct: all three
-- are reached only through SECURITY DEFINER functions and the service role,
-- neither of which consults RLS. A policy here would be a way in, not a fence.

-- ── v_my_operator runs as the CALLER (review M31) ────────────────────────
-- Without `security_invoker`, a view executes with its OWNER's privileges, so
-- RLS on `operators` is evaluated as postgres rather than as the signed-in
-- user — the view's own WHERE clause was the only thing scoping it. That
-- clause is correct, so this is defence in depth rather than a live hole, but
-- a view that silently ignores the RLS on its base table is precisely the
-- construct nobody re-reads. Postgres 15+.
alter view v_my_operator set (security_invoker = on);

-- ── The enforcement, which is the actual point ───────────────────────────
-- A hardcoded list cannot see a table added after it was written. This asserts
-- from the CATALOGUE, so a future table is covered by default and the only way
-- to opt out is to write the name here and say why.
do $$
declare
  missing text;
  exempt text[] := array[]::text[];  -- nothing is exempt today; add with a reason
begin
  select string_agg(c.relname, ', ' order by c.relname) into missing
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'r'
     and not (c.relrowsecurity and c.relforcerowsecurity)
     and not (c.relname = any (exempt));
  if missing is not null then
    raise exception '0032: RLS not enabled+forced on: %', missing;
  end if;

  if not exists (
    select 1 from pg_class where relname = 'v_my_operator'
       and reloptions::text like '%security_invoker=on%'
  ) then
    raise exception '0032: v_my_operator is not security_invoker';
  end if;

  raise notice '0032: RLS enabled and forced on every public table';
end $$;
