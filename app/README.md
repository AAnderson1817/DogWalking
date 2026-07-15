# PawTrail web app

PawTrail is a React/Vite progressive web app for dog-walking operators and client portals. The frontend lives in `app/` and talks to Supabase for auth, row-level-security-protected data, realtime walk updates, edge functions, and Postgres-backed workflows.

## Stack

- React 19, React Router, TypeScript, Vite, Vitest, and Oxlint.
- Supabase Auth, Realtime, Postgres migrations, and Edge Functions under `../supabase`.
- Mapbox GL for live route maps when `VITE_MAPBOX_TOKEN` is configured; otherwise the app falls back to the built-in SVG route renderer.
- A production-only service worker (`public/sw.js`) precaches the app shell and Vite entry assets, while lazy chunks such as Mapbox stay on demand.

## Repository layout

```text
app/
  public/sw.js             # service worker template stamped by vite.config.ts after builds
  src/components/          # shared UI, shell, sheets, vault and notification components
  src/hooks/               # realtime/walk hooks
  src/lib/                 # Supabase API client, env access, GPS batching/outbox, generated DB types
  src/screens/             # operator and client portal routes
  vite.config.ts           # Vite config and service-worker asset stamping plugin
supabase/
  functions/               # Deno Edge Functions for billing, vault, webhooks, notifications
  migrations/              # ordered SQL migrations and security/consistency functions
  seed.sql                 # local seed data
  tests/                   # SQL smoke/materializer suites
scripts/
  db-start.sh              # local Postgres helper for environments without Supabase CLI/Docker
  db-reset.sh              # applies shim, migrations, and seed to LOCAL_DB_URL
  gen-types.py             # refreshes generated Supabase typings
```

## Prerequisites

- Node.js 22 and npm.
- Supabase CLI for full local Supabase development, or Postgres plus `psql` for the lightweight local database scripts.
- Deno 2 for Edge Function typechecking and tests.
- Optional: Mapbox token for map tiles, Stripe test keys for billing flows, and Resend API key for notification email testing.

## Environment

Create `app/.env.local` for browser-visible Vite variables:

```bash
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<local-or-project-anon-key>
VITE_MAPBOX_TOKEN=<optional-mapbox-token>
```

Required server-side Edge Function secrets vary by feature:

```bash
SUPABASE_URL=<project-url>
SUPABASE_ANON_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
STRIPE_SECRET_KEY=<stripe-secret-key>
STRIPE_WEBHOOK_SECRET=<stripe-webhook-signing-secret>
VAULT_MASTER_KEY=<32-byte-base64-or-hex-key-material>
APP_BASE_URL=http://localhost:5173
RESEND_API_KEY=<optional-resend-key>
NOTIFY_FROM_EMAIL="PawTrail <notifications@example.com>"
```

Never commit real secrets. Use Supabase project secrets for deployed Edge Functions and `.env.local` only for local development.

## Local setup

Install frontend dependencies:

```bash
npm ci --prefix app
```

Start a local Supabase stack when available:

```bash
supabase start
```

If Docker/Supabase CLI is unavailable, use the lightweight Postgres helper and apply migrations directly:

```bash
./scripts/db-start.sh
export LOCAL_DB_URL="postgresql://postgres@127.0.0.1:54322/postgres"
./scripts/db-reset.sh
```

Then start the Vite dev server:

```bash
npm run dev --prefix app
```

The app is served by Vite, and production-only service-worker caching is intentionally disabled in dev.

## Common commands

Run from the repository root unless noted otherwise:

```bash
npm run lint --prefix app              # Oxlint; warnings fail
npm run test --prefix app -- --run     # Vitest unit tests
npm run build --prefix app             # TypeScript build + Vite production build
npm run preview --prefix app           # Preview the production build
npm run test:e2e --prefix app          # Playwright critical-flow tests (requires E2E_* env)
npx tsc --noEmit -p app                # TypeScript-only check
```

Edge Function checks:

```bash
deno check supabase/functions/*/index.ts
deno test ./supabase/functions/_tests/
```

Database checks after applying migrations:

```bash
psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/smoke.sql
psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/materializer.sql
```

## End-to-end tests

Playwright coverage for signup/invite, booking, concurrent walk completion, billing, and offline walk recovery lives in `e2e/critical-flows.spec.mjs`. The tests are designed for disposable staging fixtures and skip fixture-specific assertions unless the relevant environment variables are present:

```bash
E2E_BASE_URL=https://staging.example.com \
E2E_OPERATOR_EMAIL=operator@example.com \
E2E_OPERATOR_PASSWORD=<password> \
E2E_CLIENT_EMAIL=client@example.com \
E2E_CLIENT_PASSWORD=<password> \
E2E_INVITE_URL=https://staging.example.com/claim/<token> \
E2E_WALK_URL=https://staging.example.com/walks/<walk-id>/live \
npm run test:e2e --prefix app
```

Install the Chromium browser bundle before first use with `npm run test:e2e:install --prefix app`.

## Architecture notes

### Authentication and tenancy

Supabase Auth identifies operators and client-portal users. Application tables carry tenant identifiers, RLS policies restrict ordinary access, and database triggers/functions enforce cross-table tenant consistency for walks, clients, pets, properties, service types, schedules, and related billing data.

### Walk capture and offline recovery

Walk mode batches GPS points in memory, persists batches through the IndexedDB-backed outbox, and drains that outbox to Supabase. `GpsBatcher.flush()` and `end()` are awaitable so final route segments are durably enqueued before a walk completes, and `GpsOutbox.drain()` deduplicates concurrent callers.

### Billing and plan changes

Billing operations run through Supabase Edge Functions. Plan changes create durable `plan_change_intents` before Stripe subscription updates, use stable Stripe idempotency keys, and are finalized from Stripe webhooks through database RPCs. Overage charging records claim rows and reuses per-claim idempotency keys when retrying ambiguous attempts.

### Credential vault

The credential vault encrypts sensitive client credentials in Edge Functions using `VAULT_MASTER_KEY`. Rate limiting is enforced through Postgres so limits are shared across Edge Function isolates instead of relying on process memory.

### Service worker and assets

The production build stamps `public/sw.js` with the build version and Vite manifest-derived entry assets. The service worker precaches the shell routes and initial CSS/JS only; lazy chunks are fetched when their screens need them.

## Deployment

1. Run the frontend, Edge Function, and database checks listed above.
2. Apply database migrations to the target Supabase project in order.
3. Configure Edge Function secrets in Supabase.
4. Deploy Edge Functions under `supabase/functions/`.
5. Build and deploy `app/dist/` to the hosting provider.
6. Run staging smoke tests before promoting to production.

GitHub Actions currently contains CI for frontend checks, Edge Function Deno checks/tests, database migration smoke tests, staging deploy, and staging smoke validation.

## Recovery playbooks

### Failed or partial plan change

- Inspect `plan_change_intents` for pending intents and compare the Stripe subscription status/price to the intended plan.
- Replay or resend the relevant `customer.subscription.updated` webhook from Stripe when Stripe succeeded but the local intent is still pending.
- Do not manually update `clients.plan_id` without reconciling the intent and credit ledger effects.

### GPS points not appearing after a walk

- Ask the walker to reopen the app while online so the outbox can drain.
- Check browser storage for queued GPS outbox batches and inspect network errors to Supabase.
- Verify the walk has not been archived or blocked by tenant-consistency guards.

### Vault access unexpectedly blocked

- Confirm the operator is authenticated and using the correct tenant.
- Check the shared vault rate-limit table/RPC state before assuming a function-isolate issue.
- Wait for the configured window to expire or clear only the specific user/IP test rows in non-production environments.

### Service worker serving stale UI

- Build output changes stamp a new cache version into `sw.js`.
- Have the user close all tabs and reopen, or unregister the service worker in browser dev tools for emergency local recovery.
- Confirm the deployed `sw.js` and hashed entry assets come from the same build artifact.
