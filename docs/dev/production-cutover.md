# Production cutover — browser-only checklist

Takes Sanpo from the staging stack (test-mode Stripe) to a production
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
3. **Generate a fresh vault key** (do NOT reuse staging's), on your own
   machine, **not in the SQL Editor**:

   ```
   openssl rand -base64 32
   ```

   The previous instruction here was `select encode(gen_random_bytes(32),
   'base64')` in the Supabase SQL Editor. That sends the key over the network
   into the very database it is supposed to be independent of, and leaves it
   in the editor's query history and saved snippets — `_lib/crypto.ts` says
   "never in the DB" and that step contradicted it (review B2).

   Then, in this order:

   a. **Escrow it first.** Put it in your password manager, labelled with the
      project. GitHub will never show it to you again, and you cannot rotate
      without the outgoing key.
   b. Set it as the `VAULT_MASTER_KEY` environment secret.
   c. Set `VAULT_MASTER_KEY_PREVIOUS` to the literal string `none`. It is an
      explicit tombstone: absent could equally mean a mis-typed secret name.

   Losing the key is no longer terminal *provided (a) actually happened* —
   that copy is the whole of your recovery story. `docs/dev/vault-key-rotation.md`
   covers rotating it.
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
   | `SUPABASE_SERVICE_ROLE_KEY` | the **prod** service_role key (Settings → API). **Required** — the production deploy refuses to run without it, because it is the only way to confirm `VAULT_MASTER_KEY` actually opens this project's door codes. |
   | `STRIPE_SECRET_KEY` | **live** key `sk_live_…` (step 4) |
   | `STRIPE_WEBHOOK_SECRET` | **live** `whsec_…` (step 4) |
   | `VAULT_MASTER_KEY` | the fresh key from step 2 |
   | `VAULT_MASTER_KEY_PREVIOUS` | the literal `none` (see step 2) |
   | `APP_BASE_URL` | `https://app.yourdomain.com` |
   | `RESEND_API_KEY` | from step 5 |
   | `NOTIFY_FROM_EMAIL` | e.g. `Sanpo <notifications@sanpocare.com>` |

## 4. Stripe: live mode (this is the income switch)

> **Read this first — who takes the money changed (review B5).**
> Operators are the **merchant of record**, not Sanpo. Every client payment is
> a direct charge on the *operator's own* Stripe account via Connect Standard:
> their business on the client's card statement, their bank account, their
> chargeback liability, their Stripe fees. Sanpo is never in the flow of
> funds, which is also why none of this is money transmission.
>
> So the platform account below is **not** where client money lands. It exists
> to create connected accounts, mint onboarding links, and verify webhooks.
> As the founder you are also operator #1: you will connect your own account
> through the app (Money → Connect Stripe) exactly as any other operator does.

1. **Activate the account** (Stripe dashboard banner): business details,
   your identity, and the bank account. Stripe may take minutes to a day to
   verify. Requirements to have ready: legal name/address, SSN or EIN, bank
   routing + account number, and a business website URL (your Vercel domain
   works; see the legal note in step 8).
1a. **Enable Connect**: Stripe dashboard → Connect → Get started → platform
   profile. Choose **Standard** accounts. This is the setting that makes
   operators the merchant of record; Express and Custom would make Sanpo one.
2. Toggle **out of Test mode**. Product catalogue → recreate each plan as a
   Product with a recurring USD Price. Live mode does NOT copy test-mode
   products. Note every live `price_…` id.

   **Create these on the operator's connected account, not the platform
   account.** Prices are per-account objects: a `price_…` from the platform
   account simply does not exist from the connected account's point of view,
   and checkout would fail on an id that looks perfectly valid.
   `plans.stripe_price_id` is already per-operator (`plans.operator_id`), so
   the schema needs nothing — only the ids must come from the right account.
3. Developers → Webhooks → Add endpoint:
   `https://<PROD_PROJECT_REF>.supabase.co/functions/v1/stripe-webhook`
   — and set **Listen to events on: Connected accounts**. This is the part
   that is easy to get wrong: an account endpoint receives none of the events
   that matter, because every payment happens on a connected account. The
   handler ignores any event without an `account`, so a misconfigured endpoint
   fails *silently and completely* — nothing is billed and nothing errors.

   Events: `checkout.session.completed`, `invoice.paid`,
   `invoice.payment_failed`, `invoice.upcoming`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `account.updated`, `charge.refunded`, `charge.dispute.created`,
   `charge.dispute.funds_withdrawn`, `credit_note.created`, `invoice.voided`.

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
   link, invite) with Sanpo-branded text. Plain but branded beats
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
5. Settings → Git: set the production branch to **`release/production`** —
   **not** `main`.

   This one field is the whole of the frontend gate, so it is worth being
   precise about why. `release/production` is a ref that nothing but the
   `frontend` job in `deploy-production.yml` ever advances, and that job runs
   only after the migrations and edge functions for the same commit have
   deployed successfully. So:

   - a red commit cannot reach users, because the workflow refuses to start;
   - the frontend cannot get **ahead of its database**, which is the failure
     that actually matters. `app/src/lib/api.ts` is a direct PostgREST/RPC
     client, so "the frontend is stateless" does not mean
     "schema-independent" — a frontend shipped before its migrations means a
     client opening the portal to a screen that errors because the RPC it
     calls does not exist yet.

   The reverse order is safe: migrations are append-only and additive, so new
   schema under an old frontend keeps working. That asymmetry is why
   database-first is a rule rather than a preference.

   Until this field is changed the production frontend still deploys on every
   push to `main`, ungated — which is what review H16 was about. The
   workflow's last step polls `APP_BASE_URL/version.json` and **fails the
   deploy** if the commit it just released is not the one being served, so a
   forgotten setting here surfaces as a red deploy rather than a silent
   divergence.

   `main` still gets Vercel preview deployments, which is useful in itself: a
   build of the tip that nobody is relying on.

   **To roll the frontend back**, use Vercel's instant rollback (Deployments →
   ⋯ → Promote to Production) rather than forcing the ref backwards. It needs
   no rebuild, and the workflow deliberately does not force-push — a rejected
   push means the commit is not a descendant of what is live, which should
   never happen by accident.

## 7. Deploy the backend

1. GitHub → Actions → **"Deploy production (Supabase)"** → Run workflow →
   type `deploy-production` in the confirm box → tick **sync_secrets** →
   run → approve the environment gate when it pauses.
   The gate refuses to run unless CI is green on that exact commit.
2. Post-deploy dashboard wiring (one-time, same as staging):
   - **Cron**: nothing to create — migration `0028` schedules it. If `db push`
     fails with *"pg_cron is not installed"*, enable it once at Database →
     Extensions → `pg_cron` and re-run.

     Confirm before you go further, because this job generates every walk on
     every calendar and a silent failure is invisible for 14 days:
     ```sql
     select jobname, schedule, active from cron.job;   -- sanpo-nightly, 0 3 * * *
     select * from fn_job_health();                     -- stale = true until it first runs
     ```
     Then, after 03:00 UTC the following morning, `fn_job_health()` must read
     `stale = false`. Until it does, nothing is generating walks.
   - **Health check**: add `production` to the `schedule:` block of
     `.github/workflows/job-health.yml` (it currently only runs against
     staging, because production did not exist when it was written). Without
     this the production job is unwatched.
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
  shows them running after 24 h. Daily is a **24-hour RPO on the money
  tables** — a bad write at 4pm costs a full day of walk debits, cycle grants
  and overage charges, reconcilable against Stripe only by hand. Storage
  objects are not covered at any tier. `docs/dev/disaster-recovery.md` has
  what to do when the database is wrong, what each tier actually protects,
  and the rehearsal that turns the recovery estimates into measurements.
  Read it before the first paying client, not after.
- **Money watch**: Stripe → Payments and the in-app Billing Console are
  your two views of the same truth; the `payments` table reconciles them.
- **Deploys**: one workflow ships all three halves, in this order —
  migrations → edge functions → frontend. Nothing reaches production until
  you dispatch that workflow, type the confirmation phrase and approve the
  environment gate. Migrations stay append-only — same discipline as ever.

  This line used to read *"frontend ships on every green main push
  (Vercel)"*, and two things about that were wrong (review H16): Vercel has
  no knowledge of GitHub Actions, so nothing consulted CI and there was no
  "green" about it; and shipping the frontend independently of the database
  let it get ahead of the schema it calls. Both are fixed by the Vercel
  production branch being `release/production` — see §6.
- **Staging first**: every future change follows the path it followed
  today — main → CI → staging deploy (migrations → functions → frontend) →
  staging smoke → then, when you choose, the production workflow, which
  ships the same three in the same order. Staging rehearses production's
  ordering because both frontends are released from a `release/*` ref rather
  than from `main`.
