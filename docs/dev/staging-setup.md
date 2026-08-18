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
   | `SUPABASE_SERVICE_ROLE_KEY` | project Settings → API → `service_role`. Without it the deploy's `Verify the vault key opens this project` step warns and passes, so nothing confirms `VAULT_MASTER_KEY` can actually read this project's credentials (`docs/dev/vault-key-rotation.md`). |
   | `STRIPE_SECRET_KEY` | Stripe → Developers → API keys (TEST mode `sk_test_…`) |
   | `STRIPE_WEBHOOK_SECRET` | step 4 below (`whsec_…`) |
   | `VAULT_MASTER_KEY` | step 3 below |
   | `VAULT_MASTER_KEY_PREVIOUS` | the literal `none` until you first rotate (step 3) |
   | `APP_BASE_URL` | your Vercel URL (step 6; set a placeholder first) |
   | `RESEND_API_KEY` (optional) | resend.com — skip for now; email silently no-ops |

   `SUPABASE_SERVICE_ROLE_KEY` is what lets the deploy verify that the vault
   key can actually read this project's credentials before anyone stands at a
   door with it. Without it the deploy still succeeds but prints a warning and
   skips the check — which is the state this repo was in before the key had
   any identity at all. Treat it like the vault key: it bypasses every RLS
   policy in the database.

## 2. Supabase: create the project

1. supabase.com → New project (choose region, set a strong DB password —
   that's `SUPABASE_DB_PASSWORD`).
2. Note the Project Ref, the anon key and the URL (Settings → API).
3. Auth → URL Configuration: set the Site URL to the Vercel URL later
   (step 6). For first testing, Auth → Providers → Email → consider turning
   OFF "Confirm email" so operator/client signups complete instantly.

## 3. Generate the vault key (browser only)

**Not in the SQL Editor.** The key is supposed to be independent of the
database; generating it there sends it over the network into that database and
leaves it in query history and saved snippets. This page promises a
browser-only setup, so use the browser's own CSPRNG — devtools console (F12) on
any page:

```js
btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
```

If you have a terminal, `openssl rand -base64 32` is equivalent. Either way it
never leaves your machine. Not on a shared or kiosk machine; clear the console
afterwards.

Then, in this order:

1. **Escrow it first** — put it in your password manager, labelled `staging`.
   GitHub will not show it to you again, and the outgoing key is required to
   rotate.
2. Set it as the `VAULT_MASTER_KEY` GitHub secret.
3. Set `VAULT_MASTER_KEY_PREVIOUS` to the literal string `none`.

Rotation is now supported — `docs/dev/vault-key-rotation.md`. The old warning
here ("rotating it later makes existing vault blobs unreadable") is no longer
true, because every blob records which key wrote it and two keys can be loaded
at once.

## 4. Stripe (test mode)

1. Stripe dashboard, toggle **Test mode**.
1a. **Connect → Get started**, and choose **Standard** accounts. Operators are
   the merchant of record (review B5) — client payments are direct charges on
   the operator's own account, never the platform's. Without this, nothing in
   the app can take a payment at all.
2. Product catalogue → create one Product per plan with a recurring Price
   (USD, weekly/monthly to match). Note each `price_…` id.

   Create these **on the connected account**, not the platform account.
   Prices are per-account objects, so a platform `price_…` does not exist from
   the connected account's point of view and checkout fails on an id that
   looks entirely valid.
3. Developers → Webhooks → Add endpoint:
   `https://<PROJECT_REF>.supabase.co/functions/v1/stripe-webhook`
   and set **Listen to events on: Connected accounts**.

   > This is the easy one to get wrong. An *account* endpoint receives none of
   > the events that matter, because every payment happens on a connected
   > account — and the handler ignores any event without an `account`, so a
   > misconfigured endpoint fails silently and completely: nothing is billed
   > and nothing errors.

   Events: `checkout.session.completed`, `invoice.paid`,
   `invoice.payment_failed`, `invoice.upcoming`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `account.updated`, `charge.refunded`, `charge.dispute.created`,
   `charge.dispute.funds_withdrawn`, `credit_note.created`, `invoice.voided`.

   Copy the signing secret (`whsec_…`) into the `STRIPE_WEBHOOK_SECRET`
   GitHub secret.
4. Settings → Billing → Customer portal → activate it (used by
   `/portal/billing`).

## 5. Deploy

1. GitHub → Actions → "Deploy staging (Supabase)" → Run workflow →
   tick **sync secrets** → run. This pushes all migrations (0001–0012),
   deploys all nine edge functions, and sets the edge secrets.
   - If `db push` fails on the storage policies ("must be owner of table
     objects"), create just those policies via the SQL Editor (copy them
     from `0004_security.sql` / `0008_portal.sql`) and re-run.
2. Post-deploy dashboard wiring (one-time):
   - **Cron**: nothing to do. Migration `0028` schedules it
     (`sanpo-nightly`, `0 3 * * *`, calling `fn_run_nightly_jobs()`).
     This used to be a hand-typed dashboard entry with a pasted service-role
     header, which no restore recreated and nothing asserted the existence of
     (review H15).

     If `db push` fails on `0028` with *"pg_cron is not installed"*, enable it
     once at Database → Extensions → `pg_cron`, then re-run the deploy. The
     migration asserts rather than skipping, so a deploy cannot report success
     having scheduled nothing.

     Verify in the SQL Editor:
     ```sql
     select jobname, schedule, command, active from cron.job;
     select job_name, ok, detail, error from job_runs order by started_at desc limit 5;
     select * from fn_job_health();          -- stale = false
     ```
     There is no `net._http_response` to check any more, because there is no
     HTTP hop: the job calls the SQL directly and either commits or does not.
     `cron.job_run_details` carries the real outcome, which the dashboard
     cron never did — it marked a run "successful" once the call was
     *dispatched*, so a 500 looked exactly like a good night.
   - **Log retention**: nothing to do on staging, but know what you have.
     Edge functions now emit one structured JSON line per 5xx
     (`{level,fn,request_id,status,code,message,cause,context}` — review H14),
     and platform log retention is the default for your plan. There is no drain
     and no error monitor, so failures are *reconstructable* but nobody is told.
     Search by `context.walk_id` or `request_id` in Logs → Edge Functions.
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
5. Settings → Git: set the production branch to **`release/staging`** — not
   `main`.

   Staging gets the same gate as production, and not only for symmetry. This
   runbook's posture is that every future change follows the path it followed
   today: main → CI → staging deploy → staging smoke → then production. If
   staging's frontend deploys straight off a push while its database waits for
   the workflow, staging never rehearses the ordering production uses — and
   rehearsal is the entire point of staging.

   `release/staging` is advanced only by the `frontend` job in
   `deploy-staging.yml`, after that commit's migrations and edge functions have
   deployed. Until you change this field the staging frontend keeps deploying
   on push, and the workflow's last step will say so as a **warning** rather
   than failing the deploy (the same staging-warns / production-refuses split
   the vault-key check uses, for the same reason: a dashboard field only you
   can set should not turn every staging deploy red).

## 7. First-run verification (in the deployed app)

1. Sign up → Onboard → Dashboard loads; `operators` row + two seeded
   service types in the Table editor.
1a. **Money → Connect Stripe** → complete Stripe's onboarding → return to the
   app. The panel should disappear on its own once `account.updated` lands
   (the panel re-checks on window focus). Until it does, no checkout and no
   overage can be taken — that is the intended behaviour, not a bug: clients
   pay the operator directly, so the money needs somewhere to land.
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

## 8. Troubleshooting

### `supabase link` fails with `{"message":"Unauthorized"}`

**`SUPABASE_ACCESS_TOKEN` has almost certainly expired.** Supabase personal
access tokens are issued with an expiry — a 15-day one lapsed on 2026-08-12
and broke staging deploys silently for two weeks, because nothing fails until
the next push to `main` and nobody watches a workflow they did not expect to
break.

The failure looks like a code or migration problem and is not. It happens in
the `Apply migrations` job before any migration runs, so **the database is
untouched** and there is nothing to clean up or roll back. `deploy-functions`
and `sync-secrets` both `needs: migrate`, so a dead token stops the whole
deploy at the first step.

Fix:

1. supabase.com → Account → Access Tokens → **Generate new token**. It is
   shown once.
2. Repo → Settings → **Environments → `staging` → Environment secrets** →
   update `SUPABASE_ACCESS_TOKEN`. The deploy jobs declare
   `environment: staging`, so an environment secret wins over a repository
   secret of the same name — check both places if you are unsure which
   exists.
3. Re-run the failed deploy (Actions → the run → **Re-run all jobs**) or
   dispatch `Deploy staging (Supabase)` manually. Secrets are read at run
   time, so no new commit is needed.

If the token is fresh and it still fails: confirm `SUPABASE_PROJECT_REF`
matches the current project (Settings → General — it is also the subdomain in
the project URL), and that the account that minted the token is a member of
the project's organisation. A ref pointing at a deleted or moved project
returns the same 401.

The `Link project` step names this cause in its own failure annotation, so a
future occurrence should not need re-diagnosing from scratch.

### Note on renewal

Set a reminder for whatever expiry you chose. Nothing warns you before a
token lapses, and the first symptom is a red deploy on an unrelated commit —
which invites blaming that commit's changes.
