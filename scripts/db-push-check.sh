#!/usr/bin/env bash
# Would `supabase db push` apply these migrations to a real project? (review M5)
#
# `scripts/db-reset.sh` answers a weaker question than it looks like it does.
# It applies every migration with a bare `psql -f` loop, as the local cluster's
# bootstrap SUPERUSER, with each statement in its own implicit transaction. All
# three of those differ from a deploy, and each difference hides a class of
# failure that then only appears against the real project:
#
#   1. Privileges. A superuser skips every ownership and privilege check. Hosted
#      Supabase's `postgres` is not a superuser, so "it applied here" said
#      nothing about whether it is permitted there — which is why the runbook
#      has carried a "must be owner of table objects" recovery paragraph that
#      nobody could confirm or refute.
#
#   2. Transaction scope. `psql -f` commits statement by statement. A migration
#      applied as one unit is a stricter contract, and this repository has six
#      `alter type ... add value` statements: adding an enum value and USING it
#      in the same file passes a statement-at-a-time apply and fails outright as
#      one transaction ("unsafe use of new value"). Those are in their own
#      migrations today by hand, and nothing has been enforcing it.
#
#   3. Bookkeeping. `db push` decides what to apply from the leading digits of
#      each filename. A duplicate or unparseable version is skipped there and
#      invisible here, where the loop just takes the files in shell glob order.
#
# So this applies all of them from zero, as a non-superuser holding only the
# privileges enumerated in scripts/local-stack/platform-roles.sql, one
# transaction per file, recording each version — and refuses if any of that
# does not hold.
#
# ── What it deliberately does NOT do ─────────────────────────────────────
#
# It does not test behaviour. smoke.sql, materializer.sql and concurrency.sh
# already do, against the ordinary reset, and running them twice would double
# the slowest job in CI to re-prove what it already proves. This answers one
# question: would the schema APPLY, and under what privileges.
#
# Nor does it claim to reproduce hosted Supabase. The privilege set here was
# derived by taking privileges away until the migrations stopped applying, so
# "these migrations need this much" is proved by construction. "The project
# grants this much" is a checklist for the owner —
# docs/dev/db-push-requirements.md — and is the honest residue of M5.
#
# Env: LOCAL_DB_URL (same as db-reset.sh)
set -euo pipefail

cd "$(dirname "$0")/.."

DB_URL="${LOCAL_DB_URL:-postgresql://postgres@127.0.0.1:54322/postgres}"
ADMIN_URL="${DB_URL%/*}/template1"
CHECK_DB="sanpo_db_push_check"
CHECK_URL="${DB_URL%/*}/${CHECK_DB}"

# The deploy role connects to the same cluster, so the URL is LOCAL_DB_URL with
# the user swapped. Parsed rather than pattern-substituted because the two
# environments differ: a laptop cluster is usually `trust` and has no password
# in the URL at all, while CI's postgres service container demands one. The
# password below is not a secret — it exists only so the connection works under
# either auth method, and the role lives for the length of this script.
DEPLOY_PASSWORD="sanpo_local_check"  # keep in step with platform-roles.sql
DEPLOY_URL=$(python3 - "$CHECK_URL" "$DEPLOY_PASSWORD" <<'PY'
import sys, urllib.parse as u
p = u.urlsplit(sys.argv[1])
host = p.hostname or "127.0.0.1"
netloc = f"sb_deploy:{sys.argv[2]}@{host}" + (f":{p.port}" if p.port else "")
print(u.urlunsplit((p.scheme, netloc, p.path, p.query, p.fragment)))
PY
)

fail() { echo "FAIL: $*" >&2; exit 1; }

# ── 1. the filename -> version contract ──────────────────────────────────
# `db push` derives a version from the leading digits and applies in version
# order. Two files sharing a version means one of them is silently never
# applied on a project that has already seen the other.
echo "== migration filename contract =="
prev=""
shopt -s nullglob
migrations=(supabase/migrations/*.sql)
[ ${#migrations[@]} -gt 0 ] || fail "no migrations found"
for m in "${migrations[@]}"; do
  base=$(basename "$m")
  [[ "$base" =~ ^([0-9]+)_[a-z0-9_]+\.sql$ ]] \
    || fail "$base does not match <digits>_<lower_snake>.sql, so its version is not what db push will derive"
  version="${BASH_REMATCH[1]}"
  if [ -n "$prev" ] && [[ ! "$version" > "$prev" ]]; then
    fail "$base has version $version, which does not sort after $prev — glob order and version order have diverged"
  fi
  prev="$version"
done
echo "  ${#migrations[@]} migrations, versions unique and ascending: OK"

# ── 2. a project that has never seen any of them ─────────────────────────
echo "== provisioning a scratch project =="
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q <<SQL
select pg_terminate_backend(pid) from pg_stat_activity
  where datname = '${CHECK_DB}' and pid <> pg_backend_pid();
drop database if exists ${CHECK_DB};
create database ${CHECK_DB};
SQL
psql "$CHECK_URL" -v ON_ERROR_STOP=1 -q -f scripts/local-stack/shim.sql
psql "$CHECK_URL" -v ON_ERROR_STOP=1 -q -f scripts/local-stack/platform-roles.sql

psql "$CHECK_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  name text
);
grant usage on schema supabase_migrations to sb_deploy;
grant select, insert on supabase_migrations.schema_migrations to sb_deploy;
SQL

# Refuse to run the whole check as a superuser, which would silently restore
# the exact blindness it exists to remove.
super=$(psql "$DEPLOY_URL" -tAX -c "select rolsuper from pg_roles where rolname = current_user")
[ "$super" = "f" ] || fail "the deploy role is a superuser ($super) — this check would prove nothing"

# ── 3. apply, as the deploy role, one transaction per file ───────────────
echo "== applying as sb_deploy (non-superuser), one transaction per migration =="
tmp=$(mktemp)
for m in "${migrations[@]}"; do
  base=$(basename "$m")
  [[ "$base" =~ ^([0-9]+)_ ]] && version="${BASH_REMATCH[1]}"

  # An escape hatch, because a statement that genuinely cannot run inside a
  # transaction block (create index concurrently, say) is a legitimate thing to
  # need — and without a way to say so, the first person who needs one deletes
  # this check instead. Declaring it is a decision, and it is visible in the
  # migration and in this log.
  if head -1 "$m" | grep -q '^-- db-push: no-transaction$'; then
    echo "  $base (declared no-transaction)"
    cat "$m" > "$tmp"
  else
    { echo "begin;"; cat "$m"; printf '\n'; echo "commit;"; } > "$tmp"
  fi
  if ! out=$(psql "$DEPLOY_URL" -v ON_ERROR_STOP=1 -q -f "$tmp" 2>&1); then
    echo "$out" >&2
    fail "$base did not apply. If this is 'permission denied' or 'must be owner', the deploy role needs a privilege that scripts/local-stack/platform-roles.sql does not grant — add it there AND to docs/dev/db-push-requirements.md, because the real project will need it too. If it is 'unsafe use of new value', the migration adds an enum value and uses it in the same file: split it."
  fi
  psql "$DEPLOY_URL" -v ON_ERROR_STOP=1 -q \
    -c "insert into supabase_migrations.schema_migrations (version, name) values ('$version', '$base')"
done
applied=$(psql "$CHECK_URL" -tAX -c "select count(*) from supabase_migrations.schema_migrations")
[ "$applied" = "${#migrations[@]}" ] \
  || fail "recorded $applied versions for ${#migrations[@]} migrations"
echo "  ${#migrations[@]} migrations applied and recorded: OK"

# ── 4. the BYPASSRLS dependency, demonstrated ────────────────────────────
# 0004 forces row level security on every tenant table. FORCE means the owner
# is subject to its own policies, and a SECURITY DEFINER function runs as its
# owner — so the whole definer layer depends on the deploying role holding
# BYPASSRLS. A superuser has it implicitly, which is why no test in this
# repository has ever been able to see the dependency.
#
# Shown, not asserted: a throwaway FORCE-RLS table and a definer function over
# it, owned by sb_deploy, counted with and without the attribute.
echo "== the definer layer's BYPASSRLS dependency =="
psql "$CHECK_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
do $outer$
declare
  v_with bigint;
  v_without bigint;
  v_forced int;
  v_definers int;
begin
  set local role sb_deploy;
  create table rls_dependency_probe (id int primary key, owner_id uuid);
  alter table rls_dependency_probe enable row level security;
  alter table rls_dependency_probe force row level security;
  create policy p on rls_dependency_probe for select
    using (owner_id = '00000000-0000-4000-8000-000000000001');
  insert into rls_dependency_probe values (1, '00000000-0000-4000-8000-000000000002');
  create function fn_rls_dependency_probe() returns bigint
    language sql security definer set search_path = public
    as $fn$ select count(*) from rls_dependency_probe $fn$;
  reset role;

  select fn_rls_dependency_probe() into v_with;
  alter role sb_deploy nobypassrls;
  select fn_rls_dependency_probe() into v_without;
  alter role sb_deploy bypassrls;

  if v_with <> 1 then
    raise exception 'FAIL: a definer function whose owner HAS bypassrls read % rows, expected 1', v_with;
  end if;
  if v_without <> 0 then
    raise exception 'FAIL: a definer function whose owner LACKS bypassrls read % rows, expected 0 — the dependency this check documents does not behave as described, so the requirement list is wrong', v_without;
  end if;

  drop function fn_rls_dependency_probe();
  drop table rls_dependency_probe;

  select count(*) into v_forced
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relforcerowsecurity;
  select count(*) into v_definers
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef;

  if v_forced = 0 then
    raise exception 'FAIL: no table in public has FORCE row level security — either 0004 stopped applying it, or this check is looking in the wrong place';
  end if;

  raise notice 'demonstrated: definer owner with bypassrls reads 1 row, without reads 0';
  raise notice '% tables carry FORCE row level security; % SECURITY DEFINER functions run as their owner', v_forced, v_definers;
  raise notice 'therefore the role running `supabase db push` MUST hold BYPASSRLS';
end
$outer$;
SQL

# ── every object the sender reaches must be granted, not inherited ───────
#
# This database is the one place that can ask the question. Objects here are
# created by sb_deploy, which holds no ALTER DEFAULT PRIVILEGES, so a table or
# function is reachable by service_role only if a migration said so out loud.
# A real project carries Supabase's default ACL — `grant all on tables to
# ... service_role` for anything postgres creates in public — so an omitted
# grant works there and is invisible everywhere else, including in smoke,
# which cannot tell an explicit grant from an inherited one (both read as
# `service_role=arwdDxt/postgres`).
#
# That is not hypothetical: `push_subscriptions`, `fn_note_push_failure`,
# `vault_canary` and `fn_unsubscribe_by_token` were each measured unreachable
# here while this script still exited 0.
#
# The object list is DERIVED from the edge functions rather than enumerated,
# so a table or RPC added to a handler is covered without anyone remembering
# to add it. Deriving it is also what makes the check honest about its own
# blind spot: a `.from()` built from a variable is invisible to this grep and
# to any other, which is why the sender-side rule stays a code review concern
# too. Names are matched against pg_class/pg_proc, so a grep that captures
# something that is not an object simply matches nothing rather than failing.
SENDER_TABLES=$(grep -rhoE '\.from\("[a-z_]+"\)' supabase/functions/ \
  | sed -E 's/\.from\("(.*)"\)/\1/' | sort -u | paste -sd, || true)
SENDER_FNS=$(grep -rhoE '\.rpc\("[a-z_]+"' supabase/functions/ \
  | sed -E 's/\.rpc\("(.*)"/\1/' | sort -u | paste -sd, || true)

if [ -z "$SENDER_TABLES" ] || [ -z "$SENDER_FNS" ]; then
  echo "FAIL: derived no sender objects from supabase/functions — the grep stopped matching," >&2
  echo "      so this check would pass by looking at nothing." >&2
  exit 1
fi

psql "$CHECK_URL" -v ON_ERROR_STOP=1 -q <<SQL
do \$$
declare
  v_missing text;
  v_tables  int;
  v_fns     int;
begin
  select string_agg(x.what, E'\n  ' order by x.what), count(*) filter (where x.kind = 't'),
         count(*) filter (where x.kind = 'f')
    into v_missing, v_tables, v_fns
  from (
    select 't' as kind, 'table    ' || c.relname as what
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and c.relname = any(string_to_array('${SENDER_TABLES}', ','))
       and not has_table_privilege('service_role', c.oid, 'select')
    union all
    select 'f', 'function ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any(string_to_array('${SENDER_FNS}', ','))
       and not has_function_privilege('service_role', p.oid, 'execute')
  ) x;

  if v_missing is not null then
    raise exception E'FAIL: % table(s) and % function(s) the edge functions reach are not granted to service_role.\nThey work only on a project carrying the platform default ACL, which 0004 says not to rely on:\n  %', v_tables, v_fns, v_missing;
  end if;

  raise notice 'every object the edge functions reach is explicitly granted to service_role';
end
\$$;
SQL

cat <<'EOF'

== what the role running `supabase db push` must hold ==
  * NOT a superuser (this is how hosted Supabase is configured)
  * BYPASSRLS                      -- or the definer layer reads nothing
  * owner of schema public
  * member of anon, authenticated, service_role
  * member of the role owning storage.objects   (supabase_storage_admin)
  * member of the role owning realtime.messages (supabase_realtime_admin)
  * REFERENCES on auth.users
  * USAGE on auth, storage, realtime, cron
  * privileges on cron.job         -- cron.schedule() inserts as the caller
  * pgcrypto already installed
Proved here for these migrations; NOT proved for any real project.
Check it against one with docs/dev/db-push-requirements.md before the first
production deploy.

DB PUSH CHECK PASS
EOF
