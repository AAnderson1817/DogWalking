# Production cutover — browser-only checklist

Takes PawTrail from the staging stack (test-mode Stripe) to a production
stack that can take real money. Everything runs from a browser. Budget a
morning; the DNS and Stripe-activation steps have external wait times.

Staging stays exactly as it is — it remains your test bed. Production is a
**separate** Supabase project, a **separate** Vercel project, and Stripe in
**live mode**, wired through the new `Deploy production (Supabase)` workflow.

## 0. What it costs to run

| Service | Plan | Why |
|---|---|---|
| Supabase | **Pro (~$25/mo)** | Free-tier projects pause after ~1 week of inactivity and have no daily backups — both disqualifying for production. |
| Vercel | Hobby (free) is fine to start | Upgrade only if you add teammates. |
| Resend | Free (100 emails/day) to start | Auth + notification email. |
| Stripe | Pay-per-transaction | No monthly fee. |
| Domain | ~$10–15/yr | Your registrar of choice. |

## 1. Domain

1. Buy the domain (e.g. `pawtrail.example`). You'll create two DNS records
   for Vercel (step 6) and a few TXT/CNAME records for Resend (step 5).
2. Decide the app hostname now — `app.yourdomain.com` is the usual choice —
   because Stripe, Supabase auth, and email templates all embed it.

## 2. Supabase: production project

1. supabase.com → **New project** — name it clearly (e.g. `pawtrail-prod`),
   pick the region closest to your clients (US Central customers → a US
   region), set a strong DB password, and choose the **Pro** plan.
2. Note the Project Ref, URL, and anon key (Settings → API).
3. **Generate a fresh vault key** (do NOT reuse staging's): SQL Editor →
   `select encode(gen_random_bytes(32), 'base64');` — this becomes the
   production `VAULT_MASTER_KEY`. Store it only in the GitHub environment
   secret; if it's lost, every stored door code becomes unreadable.
4. Auth → URL Configuration → Site URL = `https://app.yourdomain.com`
   (finalize after step 6, but set it as soon as you know the hostname).
5. Auth → Providers → Email: leave **"Confirm email" ON** for production.
6. Auth → Rate limits: review after SMTP is wired (step 5) — with custom
   SMTP you can raise the email rate limits well above the built-in 2/hour.

## 3. GitHub: `production` environment

1. Repo → Settings → Environments → **New environment: `production`**.
2. **Protection rules → Required reviewers → add yourself.** This means
   every production deploy pauses for your explicit click — the cheapest
   safety net you will ever configure.
3. Add these **environment secrets** (same names staging uses, but with the
   production project's values):

   | Secret | Value |
   |---|---|
   | `SUPABASE_ACCESS_TOKEN` | same personal token as staging (account-level) |
   | `SUPABASE_PROJECT_REF` | the **prod** project ref (step 2) |
   | `SUPABASE_DB_PASSWORD` | the **prod** DB password |
   | `STRIPE_SECRET_KEY` | **live** key `sk_live_…` (step 4) |
   | `STRIPE_WEBHOOK_SECRET` | **live** `whsec_…` (step 4) |
   | `VAULT_MASTER_KEY` | the fresh key from step 2 |
   | `APP_BASE_URL` | `https://app.yourdomain.com` |
   | `RESEND_API_KEY` | from step 5 |
   | `NOTIFY_FROM_EMAIL` | e.g. `PawTrail <walks@yourdomain.com>` |

## 4. Stripe: live mode (this is the income switch)

1. **Activate the account** (Stripe dashboard banner): business details,
   your identity, and the **bank account payouts land in**. Stripe may take
   minutes to a day to verify. Requirements to have ready: legal
   name/address, SSN or EIN, bank routing + account number, and a business
   website URL (your Vercel domain works; see the legal note in step 8).
2. Toggle **out of Test mode**. Product catalogue → recreate each plan as a
   Product with a recurring USD Price. Live mode does NOT copy test-mode
   products. Note every live `price_…` id.
3. Developers → Webhooks → Add endpoint:
   `https://<PROD_PROJECT_REF>.supabase.co/functions/v1/stripe-webhook`
   with the same six events as staging (`checkout.session.completed`,
   `invoice.paid`, `invoice.payment_failed`, `invoice.upcoming`,
   `customer.subscription.updated`, `customer.subscription.deleted`).
   Copy the live signing secret into the `STRIPE_WEBHOOK_SECRET`
   environment secret.
4. Settings → Billing → **Customer portal → activate** (live mode has its
   own toggle; `/portal/billing` depends on it).
5. Settings → Branding: upload the logo/colors — this is what clients see
   on checkout and receipts.

## 5. Resend: real email

Email is load-bearing in production twice over: **auth** (invite/magic-link
emails — Supabase's built-in mailer is rate-limited to a handful per hour
and will silently strand client invites) and **notifications** (the
`send-notification` edge function no-ops without a key).

1. resend.com → Domains → add `yourdomain.com` → create the DNS records it
   shows (SPF, DKIM, MX for the bounce subdomain) at your registrar → wait
   for "Verified".
2. API Keys → create one → it becomes both the `RESEND_API_KEY` GitHub
   secret and the SMTP password below.
3. **Wire Supabase auth to it**: Supabase (prod project) → Auth → SMTP
   Settings → enable custom SMTP:
   - Host `smtp.resend.com`, port `465`, user `resend`,
     password = the API key, sender = `walks@yourdomain.com`.
   - Then raise Auth → Rate limits → emails to something sane (e.g. 30/hr).
4. Auth → Email Templates: replace the default copy (confirm signup, magic
   link, invite) with PawTrail-branded text. Plain but branded beats
   default-Supabase in client trust.

## 6. Vercel: production frontend

1. vercel.com → **Add New Project** → import the same GitHub repo again —
   this is a second Vercel project (e.g. `pawtrail-prod`); the existing one
   stays as staging.
2. Root Directory `app`, framework auto-detects Vite.
3. Environment variables (Production):
   - `VITE_SUPABASE_URL` = prod project URL
   - `VITE_SUPABASE_ANON_KEY` = prod anon key
   - `VITE_MAPBOX_TOKEN` = (optional) a Mapbox token — worth setting up for
     production; the SVG fallback works but real tiles sell the live-walk
     feature.
4. Settings → Domains → add `app.yourdomain.com` → create the DNS records
   it shows. Wait for the cert to issue.
5. Settings → Git: set the production branch to `main`. Every push to main
   now updates the production **frontend** automatically — that's safe,
   because the frontend is stateless; the DATABASE only changes via the
   approval-gated workflow.

## 7. Deploy the backend

1. GitHub → Actions → **"Deploy production (Supabase)"** → Run workflow →
   type `deploy-production` in the confirm box → tick **sync_secrets** →
   run → approve the environment gate when it pauses.
   The gate refuses to run unless CI is green on that exact commit.
2. Post-deploy dashboard wiring (one-time, same as staging):
   - **Cron**: Integrations → Cron → New job → `0 3 * * *` → Edge Function
     `materialize-walks`, method POST, timeout `8000` ms, header
     `Authorization: Bearer <prod service_role key>`. Verify with
     `select status_code from net._http_response order by id desc limit 3;`
     after it first fires (expect 200).
   - **Email webhook**: Database → Webhooks → on `notifications` INSERT →
     Edge Function `send-notification`, service-role auth header.
3. Seed the business: Table editor → `plans` → create your real plans with
   the **live** `price_…` ids in `stripe_price_id`. Never run `seed.sql`
   here.

## 8. Legal & storefront (Stripe cares, and so do clients)

- Put a **terms of service** and **privacy policy** somewhere linkable
  (even simple pages on the root domain). Stripe's live-mode review looks
  for them, card networks require an identifiable business, and you're
  storing clients' names, addresses, and door codes — say so, plainly.
- Set a support email (e.g. `help@yourdomain.com` forwarding to you) and
  put it in Stripe's public business details — it appears on card
  statements and receipts.

## 9. Go-live verification (with your own real card)

Run the whole loop once as a real customer before inviting anyone:

1. Sign up as the operator at `https://app.yourdomain.com` → onboard →
   dashboard loads. Confirm the confirmation email arrived (proves SMTP).
2. Create a real plan → invite yourself (second email address) → claim the
   invite from a phone → portal loads (proves the invite email + claim).
3. Subscribe with a **real card** → webhook fires → `stripe_events` row,
   `subscription_status = active`, credits granted in the ledger.
4. Book a walk from the portal → walk it with the operator phone (GPS!) →
   complete → report card + notification email arrive.
5. Drain credits → complete another walk → the **live overage charge**
   appears in Stripe payments.
6. Stripe → the webhook endpoint shows all deliveries 200.
7. **Refund yourself** from the Stripe dashboard (the subscription payment
   and the overage) and cancel the test subscription. Total cost of this
   rehearsal: $0 plus Stripe's non-refundable processing fee (~a dollar).
8. Only now: invite the first paying client.

## 10. Ongoing operations

- **Backups**: Supabase Pro does daily backups; check Settings → Backups
  shows them running after 24 h.
- **Money watch**: Stripe → Payments and the in-app Billing Console are
  your two views of the same truth; the `payments` table reconciles them.
- **Deploys**: frontend ships on every green main push (Vercel); the
  database/functions ship only when you run the production workflow and
  approve it. Migrations stay append-only — same discipline as ever.
- **Staging first**: every future change follows the path it followed
  today — main → CI → staging deploy → staging smoke → then, when you
  choose, the production workflow.
