# Owner actions — the things no file in this repository can do

Everything else in Sanpo is code, and code is this session's job. This page is
the exception list: settings that live in a dashboard, secrets only the owner
holds, and money.

They accumulated one per pull request, each recorded in a status-log line
nobody re-reads. That is the wrong place for a to-do list, so they are indexed
here. **Each item says what it is, why it matters, and what is true until it is
done** — because several of them are gaps that the rest of the system currently
papers over, and a paper-over that nobody knows about is worse than an open
task.

Nothing here blocks development. Several block *production*.

---

## If you only do three things

In this order. Each takes minutes, none costs money, and each closes something
the rest of the system currently papers over.

| | Action | Why first |
| --- | --- | --- |
| 1 | **Enrol a TOTP factor** (§9) | The only control that actually closes the stolen-session path to the vault. Free, already enabled, nothing to buy. |
| 2 | **Realtime → Allow public access: OFF** (§6) | Until this is off, a named client's live position at their home address is joinable by anyone holding the anon key that ships in the bundle. |
| 3 | **Branch protection on `main`** (§7) | `main` is a deploy trigger. Verified still off on 2026-08-29. |

Everything else is either a spending decision, a one-time pre-production check,
or a setting that only matters once real clients exist.

## How each of these is checked

The point of this page is that none of it can be done from the repository. What
*can* be done from here is noticing when one is still undone, so the list does
not quietly rot:

| Item | What tells you |
| --- | --- |
| §2 vault key verification | The staging deploy's `Verify the vault key opens this project` step warns and says it proved nothing |
| §5 schema capability | `docs/dev/db-push-requirements.md`, run once before the first production push |
| §6 Realtime public access | Nothing automated. `docs/dev/realtime-authorization.md` has a positive and a negative check to run by hand |
| §7 branch protection | `GET /repos/{owner}/{repo}/branches` → `main.protected` |
| §8 auth settings | `.github/workflows/auth-posture.yml`, every staging deploy |
| §9 TOTP | Same workflow — it already reports enrolment and verification as on |
| §11 `RESEND_API_KEY` | `Nightly ops check` goes red when an email backlog survives its retry |
| §1a platform webhook + secret | Nothing automated from here — Stripe's own webhook delivery log (every delivery 500s while the secret is missing) is the only signal |
| §1b signup toggle | Nothing automated, by design — it is a business decision, and neither setting is a defect |
| §15 GoTrue admin rate limit | Nothing automated — no GoTrue in this environment. Sizes a harm; blocks nothing |
| §16 email confirmations | Nothing automated yet; the check needs a key name only a live `/config/auth` response carries |
| §17 VAPID keys | The opt-in section reads "not set up for this installation"; every notification records `push_status = 'skipped'` |

Several of these have no automated signal at all — §1, §1a, §1b, §4, §6, §15
and §16 —
and that is worth knowing about them specifically, because they are the ones
whose absence is invisible from inside the product. (This sentence used to say
"two", which was already an undercount before H31 — §1's own text describes a
failure that "nothing errors" on.)

---

## Blocks production

### 1. Stripe: listen on **connected accounts**
Where: Stripe Dashboard → Developers → Webhooks → the Sanpo endpoint.

Operators are the merchant of record (review B5), so every event that matters
happens on a *connected* account. An endpoint set to "Your account" receives
none of them, and the handler ignores accountless events — so a misconfigured
endpoint fails **silently and completely**: no charges reconcile, no cycle
credits are granted, and nothing errors.

Both deploy runbooks say this in bold. Until it is set: subscriptions appear to
work and no money is ever recorded.

### 1a. The SECOND Stripe endpoint: platform-webhook on **Your account** — review H31
Where: Stripe Dashboard → Developers → Webhooks → Add endpoint
(`…/functions/v1/platform-webhook`), then the
`STRIPE_PLATFORM_WEBHOOK_SECRET` GitHub secret (staging repo secret +
production environment secret) and a `sync_secrets` deploy.

The operator's own $49/month Sanpo subscription lives on the platform
account, and its events arrive only at an endpoint set to **Your account** —
the exact mirror of §1, with the mirror failure mode: misconfigured, the app
locks operators out at trial end while their payments succeed in Stripe.
Until the secret is set and synced, `platform-webhook` answers every
delivery 500 `misconfigured` (loud in Stripe's dashboard, invisible in the
app). Runbook steps: `staging-setup.md` §4·3, `production-cutover.md` §4·3a.

### 1b. Decide the signup toggle — review H31, now actually usable
Where: Supabase Dashboard → Authentication → Sign In / Up → "Allow new users
to sign up".

Client invites no longer depend on public signup (claim-signup uses the
admin API) and the magic link no longer creates accounts, so this toggle now
governs exactly one thing: whether STRANGERS can start an operator trial at
`/signup`. ON = self-serve acquisition; OFF = invitation-only. Either is
fine — the point of H31 is that it is finally a choice. Nothing breaks
either way, which also means nothing automated will tell you it is set
wrong; it is a business decision, not a defect signal.

One stated residual (spec 04): with the toggle OFF, a person holding a live
client invite can still end up with an operator trial — claim-signup mints
them an ordinary account, and nothing stops an account from filling in the
operator onboarding form instead of claiming. "Off" means strangers cannot;
invitees technically still can.

### 2. `SUPABASE_SERVICE_ROLE_KEY` on the staging environment — issue #31
The vault deploy step *Verify the vault key opens this project* exits 0 with a
warning when this secret is unset. It ran for the first time on `5193e69` and
**passed without verifying anything**.

Production now refuses to deploy without it; staging stays non-fatal, because
blocking every staging deploy on a secret only the owner can add would be worse
than the gap — but it says outright that it proved nothing. Until it is set,
staging's vault verification is decoration.

### 3. Vercel production branches
Set the production branch to `release/staging` (staging project) and
`release/production` (production project). See `docs/dev/production-cutover.md`.

Until then Vercel deploys `main` on push, which means the frontend ships
**ahead of its own migrations** — a client opening a screen whose RPC does not
exist yet (review H16).

**The repository half is confirmed working.** `release/staging` exists and sits
at the same commit as `main` (`df81429`, checked 2026-08-29), so the `frontend`
job is advancing the ref exactly as designed. `release/production` does not
exist yet, which is correct — production has never deployed. Nothing consumes
either ref until the Vercel setting changes; this is one dashboard field per
project, and the machinery behind it is already running.

### 4. Backups: plan tier, PITR, storage destination — review B3
`docs/dev/disaster-recovery.md` states plainly that RTO and RPO are
**UNMEASURED** and carries the rehearsal that would make them real. Storage
objects have no backup at any tier and `walk_photos` carries no checksum, so a
restore desynchronises the photo evidence irrecoverably.

These are spending decisions. They are listed as open rather than quietly
closed.

### 5. Confirm the project can actually run this schema — review M5
One SQL query, once, before the first production `db push`. It is in
`docs/dev/db-push-requirements.md`; every column must come back `t`.

`scripts/db-push-check.sh` now proves in CI that these migrations apply under a
named, minimal privilege set — but whether a given Supabase project *grants*
that much cannot be read from this repository, and no amount of local modelling
substitutes for asking the project.

Automating it into the deploy was considered and declined; the runbook records
why, and what would have to be established first. The short version: the runner
may have no IPv4 route to a direct Postgres connection, and a gate that blocks
the first production deploy with a networking error is worse than a checklist
item.

The load-bearing row is **`BYPASSRLS`**. 0004 puts `force row level security`
on 23 tenant tables; FORCE means the owner is subject to its own policies, and
a `SECURITY DEFINER` function runs as its owner. Without that attribute all 53
definer functions — the credit engine, the vault, the materializer — read zero
rows and write nothing. The migrations still apply cleanly; the schema is
simply inert. If it comes back `f`, do **not** deploy and do not "fix" it by
dropping `FORCE`, which would weaken every tenant boundary in the product to
make a deploy succeed.

---

## Security, and cheap

### 6. Realtime → **Allow public access: off** — issue #24
Migration 0020 authorizes the private `walk:{id}` channel with RLS policies on
`realtime.messages`. Policies govern *private* channels only; they do not stop
a third party opening the same topic as a **public** one.

That toggle exists in no `config.toml` key and neither workflow runs `config
push` (review H2), so no file here can set it. Until it is off, 0020 hardens
our own client and leaves the old door open for everyone else — a named
person's live position at a named residential address, joinable with the anon
key that ships in the bundle. `docs/dev/realtime-authorization.md` has the
steps and both verifications.

### 7. Branch protection on `main` — review H19
A ruleset requiring green CI and one review. This is the **only** guardrail in
the review that a determined `git push` cannot route around, and a two-minute
settings change.

`main` is a deploy trigger, not just a branch: a one-line docs commit pushed
straight to it deploys staging Supabase and runs the smoke suite. The rule
exists as prose in `CLAUDE.md` and is enforced by nothing. It matters slightly
more since the `frontend` deploy job gained `contents: write`.

**Verified open, 2026-08-29.** This entry used to say the state was unreadable
from here because the token 403s on the branch and ruleset endpoints. That is
no longer true for the branches endpoint: `GET /repos/{o}/{r}/branches` returns
`main` with `"protected": false`. Read as narrowly as it deserves — that field
reflects classic branch protection, and a repository *ruleset* is a separate
mechanism that would not necessarily appear in it. So: no branch protection,
and rulesets remain unverified from here.

### 8. Two auth settings in the dashboard
Both are at **Authentication → Providers → Email**, and both are read back
automatically by `.github/workflows/auth-posture.yml` after every staging
deploy.

| Setting | Live | Intended | Confidence |
| --- | --- | --- | --- |
| Minimum password length | **6** | 12 | **Verified** 2026-08-29 |
| `security_update_password_require_current_password` | **false** | true | **Verified** 2026-08-29 |
| `security_update_password_require_reauthentication` | **false** | true | **Verified** 2026-08-29 |

Turning on **either** satisfies the gate, and they are not equivalent: requiring
the current password *closes* the stolen-session path, requiring
reauthentication only *narrows* it (GoTrue asks only once a session is more than
24h old). Turn on the first.

**Correction to the previous version of this entry**, which stated the second
row as "off". It was never measured. `check-auth-posture.sh` was asking the
Management API for `secure_password_change_enabled`, a key that API has never
returned, so the value was unreadable under that name and the "off" was an
artifact of the check's own defect. The gate has been fixed to name the two keys
the response actually carries
(`security_update_password_require_current_password` and
`security_update_password_require_reauthentication`), and the next run of the
posture workflow reads them for the first time.

That defect also meant this gate **could not be satisfied by any dashboard
change** — so it failed on every run from the day it landed, which is why the
staging smoke workflow was permanently red and why the posture check now lives
in its own workflow. Fixing the check was in-repository work and is done; what
remains for you is the password floor, and whichever of the two password-change
settings the next run reports as off.

`config.toml` governs `supabase start` on a laptop and nothing deployed. Wiring
`config push` is deliberately not done, and `docs/dev/auth-posture.md` says why.

Read the current values off the job summary rather than trusting this table to
stay accurate — it is a snapshot of one run, and one of its rows has already
been wrong once.

**Also on that page: the redirect allow-list.** Password recovery (review L16)
sends people to `{site}/reset-password`, and the list is matched **exactly** —
`site_url` on its own permits `site_url` and nothing under it. Add, under
**Authentication → URL Configuration → Redirect URLs**, for each environment:

```
https://<staging-host>/reset-password
https://<production-host>/reset-password
https://<staging-host>/claim/*
https://<production-host>/claim/*
```

The `/claim/*` wildcard is H31's: an invited client's confirmation email must
land back on THEIR INVITE LINK — without it, GoTrue's silent `site_url`
fallback drops them on "/", a role-less signed-in user is routed to the
operator onboarding form, and completing that form permanently dead-ends the
invite.

Until this is done the flow fails in the way that is hardest to report:
GoTrue accepts the reset request, sends a perfectly good email, and then
redirects to `site_url` instead — so the person arrives *signed in on Today*
with no password form and no error, and has no idea why. The local
`config.toml` has the equivalent entries; nothing in this repository can write
the deployed ones.

### 9. Enrol a TOTP factor (free — this replaces "buy Supabase Pro")
**Correction.** This entry previously said MFA required the Supabase Pro plan,
and that the vault's assurance gate was inert pending that purchase. Both were
wrong for this project: the read-back shows `mfa_totp_enroll_enabled` and
`mfa_totp_verify_enabled` are **already true** on staging. Nothing needs buying.

Enrol a second factor on each operator account. It is the **only** control that
actually closes the session-only-attacker path against the vault — a stolen
session can change the account password (see `auth-posture.md` for why
`secure_password_change` does not stop that within 24h), but it cannot
manufacture `aal2`, because that needs the factor itself.

**The surface for this now exists**: Settings → *Two-factor authentication* —
turn it on, scan the QR with any authenticator app, enter the code. Verifying
upgrades the current session on the spot, and the vault's re-auth sheet asks
for the code from then on. What used to be "impossible until a UI ships" is a
one-minute scan.

The one edge that stays with you: a **lost authenticator** cannot be removed
from inside the product (turning two-factor off requires a current code — a
session thief must not be able to delete the control). Recovery is the
dashboard: Authentication → Users → the account → delete its MFA factor,
after satisfying yourself it is really the operator asking.

Highest-value action on this list, and it costs nothing.

### 10. Have the privacy notice and terms reviewed

`app/src/lib/legal.ts` holds both documents, and they are live at
`/legal/privacy` and `/legal/terms`.

**What they are:** a factually accurate description of what this system does
with data, written from the code — the tables, the edge functions, and the five
services that receive it (Supabase, Stripe, Resend, Mapbox, Vercel). Every
claim was checked against a call site, and a test fails the build if a
subprocessor is dropped from the list.

**What they are not:** reviewed by a lawyer. They have not been checked against
CCPA/CPRA, against your state's requirements, or against what Stripe's live-mode
review expects to see. Nothing in this repository can do that.

**What the terms deliberately do NOT contain**, because writing plausible
versions of them would be the most dangerous thing this session could produce —
they would *read* as protection and provide none:

- no limitation of liability
- no warranty disclaimer (the "provided as-is" line is plain English, not a
  disclaimer in any enforceable form)
- no indemnity
- no arbitration clause
- no governing-law provision

If you want those, a lawyer writes them. Do not assume a page titled "Terms of
service" is covering you for anything on that list.

Two further specifics worth a professional eye: the notice says Sanpo processes
data on the operator's instructions, which is a processor/controller split that
should
match whatever agreement you have with operators; and the terms disclaim any
role in the walking arrangement itself, which is the position the product's
architecture takes but not necessarily the one a court would.

Changing the text means bumping the document's `version` — every consent
already recorded points at the old version, which is what makes the record
evidence. `app/scripts/legal-version.test.ts` enforces that and prints the new
hash to paste in.

---

## Delivery

### 11. `RESEND_API_KEY`
Without it `send-notification` now returns 500 and logs what is missing — it
used to report uniform success while sending zero email. The nightly ops check
drains the backlog and goes red if one survives, so a missing key is loud
rather than silent. Client-facing mail does not leave until this is set.

---

### 12. `NOTIFY_POSTAL_ADDRESS` — a physical address in the email footer

**Set the secret `NOTIFY_POSTAL_ADDRESS` on the Supabase project** to the
business's real postal address, e.g. `Sanpo, 123 Example St, Chicago, IL 60601`.

Until it is set, every notification email carries the literal text
`[postal address not configured]` in its footer. That is deliberate: an unset
value should look unset in a test send rather than silently ship a plausible
wrong address that nobody notices.

Why it matters: a physical address is required in commercial mail by CAN-SPAM,
and its absence is a spam-filter signal in transactional mail too. Every
operator sends from ONE shared identity (`notifications@sanpocare.com`), so the
sending reputation is the platform's, aggregated — Sanpo is the bulk sender
even when no single operator is (review M29).

Only the owner knows the address, which is why it is here and not a literal in
the template.

**Optional, same area:** `NOTIFY_UNSUBSCRIBE_BASE`. The one-click unsubscribe
URL defaults to the Supabase functions host, which works but reads as a long
opaque URL in the footer. Point this at a friendlier domain that proxies to
`/functions/v1/unsubscribe` and the link becomes readable. Nothing breaks if it
stays unset.

## Artwork

### 13. A 2x Today plate, if the softness on modern phones is worth it — review M17

The approved plate is `875 x 1798`, and that is every pixel of it that exists
anywhere in this repository. `docs/reference/sanpo-today-locked-composition.png`
is the same dimensions and is the composition mockup (artwork *plus* UI —
measured `18.57 dB` PSNR against the plate), and its own README says it must
not be embedded.

So M17's first half is done — the plate now ships in four sizes and a device
that needs fewer than 875 pixels stops downloading all of them — and its second
half **cannot be done from here**. A DPR-3 phone paints 960–1290 device pixels
across a plate that has 875, so it upscales 10–47%, exactly as it did before.
Nothing in the codebase can add detail that was never drawn.

**What is true until this is done:** the artwork is slightly soft on modern
flagship phones, which is where the review argued it matters most for how the
product reads. It is not a defect and nothing is broken; every gate is green
and the composition is exact.

**What it would take:** the `875 x 1798` composition re-rendered at
`1750 x 3596`, byte-identical in layout. Then `VARIANT_WIDTHS` in
`app/scripts/generate-today-plate-variants.mjs` gains the larger widths, the
new master replaces the old one, and the hashes in
`app/scripts/verify-sanpo-assets.mjs` are updated in the same commit. The
review costed a 2x master at "near 1.5 MiB" — with the responsive candidates
now in place that weight only reaches the devices that can use it, which is
the thing that was not true before.

This is a spending and design decision, and the composition is LOCKED
(`CLAUDE.md`, Ownership): a re-render is a resize, never a recomposition.

### 17. Mint the VAPID key pair — review M27

Push notifications ship in code and are inert until this exists. Nothing here
can create the pair: the public half has to be baked into the client bundle at
build time and the private half is a deploy secret, so this is three settings
in two places.

```
npx web-push generate-vapid-keys
```

Then:

| Where | Name | Value |
| --- | --- | --- |
| Vercel (all environments) | `VITE_VAPID_PUBLIC_KEY` | the public key |
| Supabase Edge Function secrets | `VAPID_PUBLIC_KEY` | the same public key |
| Supabase Edge Function secrets | `VAPID_PRIVATE_KEY` | the private key |
| Supabase Edge Function secrets | `VAPID_SUBJECT` | `mailto:` an address you read |

The public key must be **identical** in both places. A browser subscribes with
the one from the bundle and the push service checks the signature against it;
a mismatch fails at the push service, per device, with nothing on our side to
look at.

`VAPID_SUBJECT` is not decoration. RFC 8292 §2.1 makes it how a push service
reaches a human about a misbehaving sender, and a service that cannot may
simply stop accepting the key. `_lib/webpush.ts` refuses a subject that is not
`mailto:` or `https:` rather than sending one that will be ignored.

**What is true until this is done:** the opt-in section says "Push
notifications are not set up for this installation yet" and offers no switch,
so nobody subscribes, so every notification records `push_status = 'skipped'`
for want of a device. That is the honest state, not a silent failure — and it
is why this blocks nothing. The email channel is unaffected.

Rotating later invalidates every existing subscription: browsers subscribed
under the old key keep endpoints the new key cannot sign for, and the send
path learns it one 403 at a time. Treat it as a re-opt-in, not a swap.

## Questions, not tasks

These three are not settings to change. They are facts about the deployed
projects or about Supabase that cannot be established from this repository —
there is no GoTrue and no Supabase CLI in this environment, and supabase.com is
blocked by the egress proxy. None of them blocks anything; each one decides how
a document or a runbook should describe something that already ships. §14 was
filed under Artwork by the pull request that added it, which was simply wrong.

### 14. Confirm whether Supabase's backup includes the `storage` schema — migration 0047

One fact decides how much `walk_photos.sha256` actually adds, and it cannot be
established from this repository (supabase.com is blocked by the egress proxy
here, and no project has ever been restored).

Supabase Storage records a server-side `size` and a content-derived `eTag` per
object in `storage.objects.metadata`. If that schema is included in the
project's backup, a restore brings back an independent expected-value record
and `0047`'s columns are a second opinion. If it is **not** included, `0047` is
the only surviving record of what each object was.

**What is true until this is answered:** `docs/dev/disaster-recovery.md` §5
states both branches rather than picking one, and the rehearsal in §6 is where
you would find out. Answering it costs one restore into a scratch project and a
single query:

```sql
select count(*), count(metadata) from storage.objects;
```

Nothing is blocked on this. It only changes how the DR document describes the
value of a column that is already being written.

### 15. Does GoTrue rate-limit `POST /admin/users`? — migration 0048

`0048` gives `claim-signup` its own per-client budget, so this question does
not block anything. It sizes the harm it was closing, and the answer cannot be
established from here — there is no GoTrue in this environment and
supabase.com is blocked by the egress proxy.

Before H31, invited clients got their account from public `supabase.auth.signUp`,
covered by `[auth.rate_limit] sign_in_sign_ups = 30` per 5 minutes **per IP**.
H31 moved account creation into an edge function calling
`auth.admin.createUser` with the service role. Either answer is worth knowing:

- **Exempt** — then between H31 and `0048` the endpoint had no bound at all.
- **Not exempt** — then it is worse, because the only IP GoTrue can see is the
  edge function's egress address. Every claimant in the world shares one
  30-per-5-minutes bucket, and one attacker exhausts it for everybody.

**What is true until this is answered:** `0048`'s own limiter is unaffected
either way — it is keyed in Postgres on the client the invite belongs to and
does not depend on GoTrue's behaviour. What stays unknown is whether a burst
of legitimate claims across *different* invites can still exhaust a shared
GoTrue bucket and refuse them all. If the answer is "not exempt", that is a
real second limit sitting behind ours, and the remedy is a dashboard change
to `sign_in_sign_ups`, not code.

Answering it is a Supabase support question or one test against a staging
project: call `POST /auth/v1/admin/users` more than 30 times inside five
minutes with the service role and see whether the 31st is refused.

### 16. Is `enable_confirmations` on for the deployed projects? — migration 0048

`claim-signup` creates accounts with `email_confirm: false`, deliberately:
typing an address proves nothing, and an unbound invite would otherwise let a
link-holder camp a stranger's address. What happens next depends entirely on a
dashboard setting no file here records.

- **Confirmations ON** — an account created for a guessed address is inert
  until someone clicks a link in that inbox. The worst case is address
  squatting: the real client cannot register, and asks their walker why.
- **Confirmations OFF** — the account is usable immediately by whoever created
  it, so the same guess is a takeover of the client portal.

`0048` bounds the *rate* either way. This decides what a single successful
guess is worth, which is the difference between an annoyance and an incident.

**What is true until this is answered:** the frontend already handles both —
`ClaimInvite` catches `email_not_confirmed` on the sign-in that follows and
offers a resend — so nothing is broken in either configuration. What is
missing is knowing which one is deployed. Dashboard → Authentication →
Providers → Email → *Confirm email*.

Deliberately NOT added to `scripts/check-auth-posture.sh`, and the reason is
that script's own header: the Management API's name for this setting is not
established from here (no GoTrue in this environment, supabase.com blocked by
the egress proxy), `app/scripts/auth-posture.test.ts` builds its fixtures only
from key names captured from a real response, and a gate naming a key that
does not exist is the exact defect that left staging-smoke permanently red
through every attempt to fix it. When a live `/config/auth` response is next
read, the key name is in it, and the check is a two-line addition then.

## Keeping this honest

When a pull request creates one of these, add it here in the same commit rather
than only in the status log. When one is done, delete the entry — a list of
things that are already true is how a list stops being read.
