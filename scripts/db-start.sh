#!/usr/bin/env bash
# Boot the local Postgres 16 cluster used in place of `supabase start`
# on machines without Docker. Idempotent: safe to run if already up.
set -euo pipefail

PGBIN=/usr/lib/postgresql/16/bin
PGDATA=/home/pguser/pgdata
PGRUN=/home/pguser/pgrun

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
    -l /home/pguser/pg.log start
fi

echo "postgres ready on 127.0.0.1:54322"
echo 'export LOCAL_DB_URL="postgresql://postgres@127.0.0.1:54322/postgres"'
