#!/usr/bin/env bash
# Local stand-in for `supabase db reset` on machines without Docker.
# Recreates the pawtrail database on the local cluster, applies the
# Supabase-compatibility shim, then all migrations in order, then seed.sql.
#
# Requires: a Postgres 16 server on 127.0.0.1:54322 (scripts/db-start.sh)
# and LOCAL_DB_URL exported, e.g.
#   export LOCAL_DB_URL="postgresql://postgres@127.0.0.1:54322/postgres"
set -euo pipefail

cd "$(dirname "$0")/.."

DB_URL="${LOCAL_DB_URL:-postgresql://postgres@127.0.0.1:54322/postgres}"
ADMIN_URL="${DB_URL%/*}/template1"
DB_NAME="${DB_URL##*/}"

echo "== dropping and recreating ${DB_NAME} =="
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q <<SQL
select pg_terminate_backend(pid) from pg_stat_activity
  where datname = '${DB_NAME}' and pid <> pg_backend_pid();
drop database if exists ${DB_NAME};
create database ${DB_NAME};
SQL

echo "== applying supabase shim =="
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f scripts/local-stack/shim.sql

shopt -s nullglob
migrations=(supabase/migrations/*.sql)
for m in "${migrations[@]}"; do
  echo "== applying $(basename "$m") =="
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$m"
done

if [[ -f supabase/seed.sql ]]; then
  echo "== applying seed.sql =="
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f supabase/seed.sql
fi

echo "== db reset complete =="
