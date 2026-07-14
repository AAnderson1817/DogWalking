# Staging setup — browser-only checklist

Everything here runs from a browser (GitHub, Supabase, Stripe, Vercel
dashboards) — no local tooling required. Do the steps in order; ~30–45 min.

## 1. GitHub: branch + secrets

1. Merge `claude/new-session-x3hexs` into a `main` branch (repo → branches →
   New branch `main` from it, then Settings → General → Default branch →
   `main`). The deploy workflow triggers on pushes to `main`; CI runs on
   every branch.
2. Repo → Settings → Environments → New environment `staging` (the deploy
   jobs reference it, which also gives you an audit trail and optional
   approval gates).
3. Repo → Settings → Secrets and variables → Actions → add:

   | Secret | Where to get it |
   |---|---|
   | `SUPABASE_ACCESS_TOKEN` | supabase.com → Account → Access Tokens |
   | `SUPABASE_PROJECT_REF` | project Settings → General (after step 2) |
   | `SUPABASE_DB_PASSWORD` | chosen when creating the project |
   | `STRIPE_SECRET_KEY` | Stripe → Developers → API keys (TEST mode `sk_test_…`) |
   | `STRIPE_WEBHOOK_SECRET` | step 4 below (`whsec_…`) |
   | `VAULT_MASTER_KEY` | step 3 below |
   | `APP_BASE_URL` | your Vercel URL (step 6; set a placeholder first) |
   | `RESEND_API_KEY` (optional) | resend.com — skip for now; email silently no-ops |

## 2. Supabase: create the project

1. supabase.com → New project (choose region, set a strong DB password —
   that's `SUPABASE_DB_PASSWORD`).
2. Note the Project Ref, the anon key and the URL (Settings → API).
3. Auth → URL Configuration: set the Site URL to the Vercel URL later
   (step 6). For first testing, Auth → Providers → Email → consider turning
   OFF "Confirm email" so operator/client signups complete instantly.

## 3. Generate the vault key (no terminal needed)

Project → SQL Editor → run:

```sql
select encode(gen_random_bytes(32), 'base64');
```

Copy the output into the `VAULT_MASTER_KEY` GitHub secret. Never store it
anywhere else; rotating it later makes existing vault blobs unreadable
(re-encryption tooling is on the backlog).

## 4. Stripe (test mode)

1. Stripe dashboard, toggle **Test mode**.
2. Product catalogue → create one Product per plan with a recurring Price
   (USD, weekly/monthly to match). Note each `price_…` id.
3. Developers → Webhooks → Add endpoint:
   `https://<PROJECT_REF>.supabase.co/functions/v1/stripe-webhook`
   with events: `checkout.session.completed`, `invoice.paid`,
   `invoice.payment_failed`, `invoice.upcoming`,
   `customer.subscription.updated`, `customer.subscription.deleted`.
   Copy the signing secret (`whsec_…`) into the `STRIPE_WEBHOOK_SECRET`
   GitHub secret.
4. Settings → Billing → Customer portal → activate it (used by
   `/portal/billing`).

## 5. Deploy

1. GitHub → Actions → "Deploy staging (Supabase)" → Run workflow →
   tick **sync secrets** → run. This pushes migrations 0001–0009, deploys
   all eight edge functions, and sets the edge secrets.
   - If `db push` fails on the storage policies ("must be owner of table
     objects"), create just those policies via the SQL Editor (copy them
     from `0004_security.sql` / `0008_portal.sql`) and re-run.
2. Post-deploy dashboard wiring (one-time):
   - **Cron**: Integrations → Cron → New job → schedule `0 3 * * *` →
     type "Supabase Edge Function" → `materialize-walks` (this also runs
     the daily credit-expiry sweep). Method POST, timeout `8000` ms (cold
     starts exceed the 1000 default), one HTTP header:
     `Authorization` = `Bearer <service_role key>` (Settings → API).
     Cron marks a run "successful" once the HTTP call is *dispatched* —
     verify the actual response in SQL Editor:
     `select status_code, content::text from net._http_response order by id desc limit 3;`
     — expect `200` and `{"ok":true,...}`.
   - **Email webhook** (only when Resend is configured): Database →
     Webhooks → new webhook on `notifications` INSERT → Edge Function
     `send-notification`, auth header with the service role key.
3. Seed business data: Table editor → `plans` → add your plans with the
   Stripe `price_…` ids in `stripe_price_id`. (Do NOT run `seed.sql` on
   staging — it's dev fixture data.)

## 6. Frontend on Vercel

1. vercel.com → Add New Project → import the GitHub repo.
2. Root Directory: `app` (framework auto-detects Vite; `app/vercel.json`
   already handles SPA rewrites).
3. Environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
   (from step 2), optional `VITE_MAPBOX_TOKEN`.
4. Deploy → copy the URL → update the `APP_BASE_URL` GitHub secret and the
   Supabase Auth Site URL → re-run the deploy workflow with sync secrets
   (checkout/billing-portal redirects and magic links depend on it).

## 7. First-run verification (in the deployed app)

1. Sign up → Onboard → Dashboard loads; `operators` row + two seeded
   service types in the Table editor.
2. Roster → add a client → open the invite link in a private window →
   claim → portal loads.
3. ClientDetail → Plan & credits → Launch Stripe checkout → card
   `4242 4242 4242 4242` → webhook fires: `stripe_events` row,
   `subscription_status = active`, cycle credits granted in the ledger.
4. Book a walk in the portal, run it from the operator phone (real GPS!),
   end it → report card, debit in the ledger, walk_complete notification.
5. Overage: drain credits (Adjust), complete another walk → off-session
   charge appears in Stripe test payments.
6. Stripe → Webhooks → the endpoint shows all deliveries 200. Re-deliver
   one → response says `duplicate` and no double grant (idempotency).
