# Local stack without Docker

The HANDOFF assumes `supabase start` (Docker). This repo also supports a
bare-metal fallback for environments where the Docker daemon is unavailable,
using the system PostgreSQL 16 server plus a compatibility shim.

## One-time setup
```sh
sudo scripts/db-start.sh          # initdb (first run) + start on 127.0.0.1:54322
export LOCAL_DB_URL="postgresql://postgres@127.0.0.1:54322/postgres"
```

## Per-reset
```sh
scripts/db-reset.sh               # drop/recreate + shim + migrations + seed.sql
```
`scripts/db-reset.sh` is the stand-in for `supabase db reset`: it applies
`scripts/local-stack/shim.sql` (roles `anon`/`authenticated`/`service_role`,
`auth` schema with `auth.uid()/role()/jwt()`, `storage` schema, Supabase
default privileges) before the project migrations, so migrations and tests
behave identically to the real platform. The shim is never applied to a real
Supabase project — the platform provides all of it.

## Validation gates on this stack
- DB reset gate: `scripts/db-reset.sh` (instead of `supabase db reset`).
- Smoke gate unchanged: `psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/smoke.sql`.
- Edge typecheck: `DENO_CERT` may be needed behind a TLS-intercepting proxy:
  `DENO_CERT=$SSL_CERT_FILE deno check supabase/functions/**/index.ts`.
- `supabase functions serve` and Studio are unavailable without Docker; edge
  functions are exercised through the `deno test` suite instead.

## Persona simulation in SQL tests
`supabase/tests/smoke.sql` simulates PostgREST personas with
`SET LOCAL SESSION AUTHORIZATION <role>` plus
`set_config('request.jwt.claims', '{"sub":"…","role":"…"}', true)` inside a
transaction that rolls back — `session_user` genuinely changes, so the
definer functions' service-session checks are exercised for real.
