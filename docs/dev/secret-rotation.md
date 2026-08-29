# Rotating a secret

Review L9. Every secret this system holds, where each copy of it lives, the
order to replace them in, what is broken in between, and how to confirm it
worked.

Rotation is the first thing you do after a suspected leak, which is exactly
when nobody wants to be discovering the second copy of a key by watching
something break. So this file is an inventory first and a procedure second.

**The vault master key is not in here.** It has its own runbook —
`docs/dev/vault-key-rotation.md` — because it is the only secret whose rotation
is a data migration: every ciphertext has to be rewrapped, and getting it wrong
destroys door codes rather than denying access to them. Read that one instead.

---

## Two corrections to the review that raised this

The finding said rotating the service-role key "silently takes down walk
creation and every notification email at once", from "two dashboard
integrations each embed a hand-pasted copy". Both halves have since changed,
and the change is the reason this file is short:

- **Walk creation no longer depends on it.** The nightly cron used to be a
  dashboard entry posting to an edge function with a pasted bearer header.
  Migration `0028` replaced it with a `pg_cron` job calling the SQL directly:
  `fn_is_service_session()` accepts `session_user = 'postgres'`, and a pg_cron
  job runs as the role that scheduled it, so there is no key, no HTTP hop and
  nothing to paste. One integration, not two.

- **The email failure is no longer silent or permanent.** Migration `0029` gave
  `notifications` a four-state delivery record and a retryable backlog, and
  `.github/workflows/job-health.yml` drains it nightly and goes red if anything
  survives the retry. So a stale webhook header now delays email and reports
  itself, where it used to lose it.

What remains true: the `send-notification` Database Webhook holds the only
hand-pasted copy of the service-role key, and nothing in this repository can
see or set it.

---

## Inventory

Every secret, and every place a copy of it lives. "GitHub env" means
**Settings → Environments → `staging` / `production` → Secrets**; the two
environments hold different values and are rotated independently.

| Secret | Copies | Rotating it breaks | Recovers by itself? |
| --- | --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | GitHub env · the `send-notification` Database Webhook header (dashboard) | client email, until the webhook header is updated | yes — the backlog drains on retry |
| `VITE_SUPABASE_ANON_KEY` | Vercel env (baked into the bundle at build time) | the whole frontend | no — needs a rebuild **and** redeploy |
| `SUPABASE_ACCESS_TOKEN` | GitHub env | every deploy, at `supabase link` | no |
| `SUPABASE_DB_PASSWORD` | GitHub env | `db push`, so every migration | no |
| `STRIPE_SECRET_KEY` | GitHub env → pushed to Supabase by `sync-secrets` | every charge, plan change and portal session | no |
| `STRIPE_WEBHOOK_SECRET` | GitHub env → pushed to Supabase · the Stripe endpoint itself | renewals, refunds, plan changes | partly — Stripe retries for 3 days |
| `RESEND_API_KEY` | GitHub env → pushed to Supabase | client email | yes — the backlog drains on retry |
| `VAULT_MASTER_KEY` | GitHub env → pushed to Supabase · the escrow copy | reading **and writing** door codes | **no — see `vault-key-rotation.md`** |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
injected into edge functions by Supabase itself and are never pushed by
`sync-secrets`. That matters here: after a key rotation the *functions* see the
new value immediately, while the *webhook* still sends the old one. The
mismatch is the whole failure.

`NOTIFY_POSTAL_ADDRESS` and `NOTIFY_UNSUBSCRIBE_BASE` are set directly on the
Supabase project by the owner (`owner-actions.md` §12) rather than synced, and
neither is a secret.

---

## Before you rotate anything

1. **Decide whether this is a leak or hygiene.** A leak means rotate now and
   accept the outage; hygiene means do it in a quiet hour, because several of
   these have a window where the system is half-updated.
2. **Know which Supabase key format this project uses.** Legacy projects sign
   `anon` and `service_role` as JWTs from one project JWT secret, so *they
   cannot be rotated separately* — rolling the JWT secret rolls both and signs
   out every user. Newer projects issue independently revocable
   `sb_publishable_…` / `sb_secret_…` keys. Check **Settings → API Keys**
   before you start; the answer changes the whole shape of step 1 below and
   this repository cannot see it.
3. **Do staging first.** The whole posture of the deploy runbooks is that every
   change rehearses on staging, and a rotation is a change.

---

## 1. Supabase service-role key

Order matters, and the order is *webhook last*: while the webhook header is
stale, email queues rather than failing, which is the cheapest thing to have
broken.

1. Dashboard → **Settings → API Keys** → rotate. On a legacy project this is
   the JWT secret, and it rotates the anon key too — go straight to §2
   afterwards, and expect every signed-in user to be signed out.
2. GitHub env → update `SUPABASE_SERVICE_ROLE_KEY`.
3. Dashboard → **Database → Webhooks** → the `notifications` INSERT hook →
   replace the `Authorization: Bearer …` header with the new key.
4. Confirm, in this order:
   - `select * from fn_notification_backlog();` — rows queued during the gap.
   - Run **Nightly ops check** (`job-health.yml`) by hand, or wait for 06:00
     UTC. It drains and goes red if anything is still stuck.
   - `select email_delivery_status, count(*) from notifications group by 1;`
     — `pending` and `failed` should both fall to what they were before.

If step 3 is skipped, nothing looks wrong until the ops check goes red the next
morning. That is the intended behaviour and it is why this list ends with a
verification rather than with "done".

## 2. Frontend anon key

The anon key is compiled into the bundle by Vite, so replacing the Vercel
environment variable changes nothing on its own.

1. Vercel → the project's environment variables → update
   `VITE_SUPABASE_ANON_KEY`.
2. **Redeploy.** Not a rollback to a previous deployment — that serves the old
   bundle with the old key baked in. Push the `release/*` ref again, or
   redeploy from the Vercel UI *with the build step*.
3. Confirm: load the app signed out and sign in. A stale anon key fails at the
   first request with a 401 and the app shows its retry surface, so this is not
   subtle — but it is total, which is why it is the one to do carefully.

## 3. `SUPABASE_ACCESS_TOKEN`

This one has already bitten this project: it expired after 15 days and every
staging deploy failed at `supabase link` with a bare `{"message":"Unauthorized"}`
for a fortnight, because nothing watches a workflow that nobody is waiting on.

1. Dashboard → **Account → Access Tokens** → generate. Note the expiry.
2. GitHub env → update `SUPABASE_ACCESS_TOKEN`.
3. Confirm: re-run the staging deploy. The `Link project` step prints the CLI
   output and emits an `::error` annotation naming token expiry if it is
   rejected again, so a failure here says what it is.

## 4. `SUPABASE_DB_PASSWORD`

1. Dashboard → **Settings → Database → Reset database password**.
2. GitHub env → update `SUPABASE_DB_PASSWORD`.
3. Confirm: re-run the deploy and watch `db push` reach "Finished".

Nothing else uses this password — the app connects through PostgREST, not
Postgres — so the blast radius is deploys only.

## 5. Stripe secret key

Under Connect Standard this is the **platform** key. Operators' own accounts
have their own credentials and are unaffected.

1. Stripe dashboard → **Developers → API keys** → *Roll* the secret key. Stripe
   lets the old key keep working for a chosen window; pick the shortest one
   that covers steps 2–3.
2. GitHub env → update `STRIPE_SECRET_KEY`.
3. Run the deploy with **`sync_secrets` ticked**. The secret does not reach the
   functions any other way.
4. Confirm: complete an overage walk on staging, or open the billing portal for
   a subscribed client. Since review H14 a failure here logs a structured line
   with the real Stripe error in `cause`, so "it stopped working" is
   answerable.

If the old key expires before step 3 lands, every money path 500s. The
overage claim ledger is built for exactly this — a pending claim keeps
blocking, the charge is not duplicated, and the walk can be completed once the
key is live — but it is still an outage.

## 6. `STRIPE_WEBHOOK_SECRET`

1. Stripe dashboard → **Developers → Webhooks** → the endpoint → roll the
   signing secret. Confirm it is still **Listen to events on: Connected
   accounts** — an account-level endpoint receives none of the events that
   matter, and the handler ignores accountless events, so a misconfigured
   endpoint fails silently and completely.
2. GitHub env → update `STRIPE_WEBHOOK_SECRET`.
3. Deploy with **`sync_secrets` ticked**.
4. Confirm: Stripe's endpoint page shows deliveries succeeding again. Events
   that failed while the secret was stale are retried for 3 days, and
   `stripe_events` is a claim ledger, so a redelivery after the fix applies
   exactly once.

## 7. `RESEND_API_KEY`

1. Resend → **API Keys** → create a new one, delete the old.
2. GitHub env → update `RESEND_API_KEY`.
3. Deploy with **`sync_secrets` ticked**.
4. Confirm: as §1 step 4 — the backlog is the verification.

---

## After any rotation

- **Delete the old value everywhere, including your own notes.** A rotation
  that leaves the leaked key working somewhere is a rotation that did nothing.
- **Write down what you rotated and when.** There is no audit log for these;
  the next person to ask "was this key live in July?" has only what you wrote.
- **If the rotation was triggered by a suspected leak, read
  `credential_access_log`.** It is the one place that records who opened which
  door code, from which IP, for what stated purpose — including failed
  re-auths. That is what tells you whether the leak was used.
