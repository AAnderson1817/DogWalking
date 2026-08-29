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
exist yet (review H16). The `frontend` job in both deploy workflows already
pushes the release refs; nothing consumes them until this is set.

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

*(This session cannot verify the current state: the token 403s on the branch
and ruleset endpoints, so the setting is unreadable from here as well as
unwritable.)*

### 8. Two auth settings in the dashboard
The `auth-posture` job ran for the first time on 2026-08-29 and read the live
staging config back. Two values sit below the intended posture, and both are
dashboard-only:

| Setting | Live | Intended | Where |
| --- | --- | --- | --- |
| Minimum password length | **6** | 12 | Authentication → Providers → Email |
| Secure password change | **off** | on | Authentication → Providers → Email |

`config.toml` governs `supabase start` on a laptop and nothing deployed. Wiring
`config push` is deliberately not done, and `docs/dev/auth-posture.md` says why.

Read the current values off the job summary rather than trusting this table to
stay accurate — it is a snapshot of one run.

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

## Keeping this honest

When a pull request creates one of these, add it here in the same commit rather
than only in the status log. When one is done, delete the entry — a list of
things that are already true is how a list stops being read.
