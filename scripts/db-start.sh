#!/usr/bin/env bash
# Boot the local Postgres cluster used in place of `supabase start` on
# machines without Docker. Defaults to the Supabase-configured major version
# so local smoke tests match production and CI. Idempotent: safe to run if
# already up.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_MAJOR="$(awk -F= '/^[[:space:]]*major_version[[:space:]]*=/{ gsub(/[[:space:]]/, "", $2); print $2; exit }' "$ROOT/supabase/config.toml")"
PG_MAJOR="${PG_MAJOR:-${CONFIG_MAJOR:-17}}"
PG_MAJOR="${PG_MAJOR//[[:space:]]/}"
PGBIN="${PGBIN:-/usr/lib/postgresql/${PG_MAJOR}/bin}"
PGDATA="${PGDATA:-/home/pguser/pgdata-${PG_MAJOR}}"
PGRUN="${PGRUN:-/home/pguser/pgrun}"

if [[ ! -x "$PGBIN/initdb" || ! -x "$PGBIN/pg_ctl" ]]; then
  cat >&2 <<MSG
Postgres ${PG_MAJOR} binaries were not found at ${PGBIN}.
Install Postgres ${PG_MAJOR}, set PG_MAJOR to an installed major version, or set
PGBIN to a directory containing initdb and pg_ctl.
MSG
  exit 1
fi

if ! id pguser >/dev/null 2>&1; then
  useradd -m -s /bin/bash pguser
fi
mkdir -p "$PGDATA" "$PGRUN"
chown -R pguser:pguser /home/pguser

if [[ ! -f "$PGDATA/PG_VERSION" ]]; then
  sudo -u pguser "$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust -E UTF8
fi

if ! sudo -u pguser "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
  sudo -u pguser "$PGBIN/pg_ctl" -D "$PGDATA" \
    -o "-p 54322 -k $PGRUN -c listen_addresses=127.0.0.1" \
    -l "/home/pguser/pg-${PG_MAJOR}.log" start
fi

echo "postgres ${PG_MAJOR} ready on 127.0.0.1:54322"
echo 'export LOCAL_DB_URL="postgresql://postgres@127.0.0.1:54322/postgres"'
