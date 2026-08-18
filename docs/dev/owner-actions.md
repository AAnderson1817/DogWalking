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

---

## Security, and cheap

### 5. Realtime → **Allow public access: off** — issue #24
Migration 0020 authorizes the private `walk:{id}` channel with RLS policies on
`realtime.messages`. Policies govern *private* channels only; they do not stop
a third party opening the same topic as a **public** one.

That toggle exists in no `config.toml` key and neither workflow runs `config
push` (review H2), so no file here can set it. Until it is off, 0020 hardens
our own client and leaves the old door open for everyone else — a named
person's live position at a named residential address, joinable with the anon
key that ships in the bundle. `docs/dev/realtime-authorization.md` has the
steps and both verifications.

### 6. Branch protection on `main` — review H19
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

### 7. Compare the deployed auth posture to the intended one
`staging-smoke.yml`'s `auth-posture` job prints the live settings into the run
summary and fails on the two that decide whether the vault's re-auth means
anything. Read one run, compare it to the table in `docs/dev/auth-posture.md`,
and change what differs **in the dashboard**.

`config.toml` governs `supabase start` on a laptop and nothing deployed. Wiring
`config push` is deliberately not done, and that file says why at length.

### 8. Supabase Pro, for MFA
TOTP enrolment is a Pro feature. The vault's assurance gate shipped in #48 is
correct and **inert** without it: every operator sits at `aal1_no_factor`, so
enrolling a factor is what closes the session-only-attacker exploit, with no
further code change.

This is the single highest-value security purchase for this product, because
the vault *is* the product.

---

## Delivery

### 9. `RESEND_API_KEY`
Without it `send-notification` now returns 500 and logs what is missing — it
used to report uniform success while sending zero email. The nightly ops check
drains the backlog and goes red if one survives, so a missing key is loud
rather than silent. Client-facing mail does not leave until this is set.

---

## Keeping this honest

When a pull request creates one of these, add it here in the same commit rather
than only in the status log. When one is done, delete the entry — a list of
things that are already true is how a list stops being read.
