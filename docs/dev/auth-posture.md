# Auth posture — what is set, where, and what is still unknown

Review **H2** found two things. The first is that `supabase/config.toml` governs
`supabase start` on a laptop **and nothing else**:

- `deploy-staging.yml` runs `link` / `db push` / `secrets set` / `functions deploy`
- `deploy-production.yml` runs `link` / `db push` / `secrets set` / `functions deploy`
- neither runs `supabase config push`, and that string appears in no workflow

So every auth decision in that file — signup policy, password rules, session
lifetime, MFA, OTP expiry, rate limits — was fiction as far as any deployed
project was concerned. Staging and production run whatever is set in the
Supabase dashboard, which no file recorded, no test asserted and no reviewer
could see. **The actual auth posture of the deployed systems was unknown from
this repository.**

The second is that the vault's re-auth was defeatable by a session-only
attacker. That half is fixed in code — see *The vault's assurance gate* below.

## The intended values

`config.toml` now holds these, and they are what a deployed project should
match. Each one is here because of what this product holds, not because it is a
common default.

| Setting | Value | Why |
| --- | --- | --- |
| `minimum_password_length` | **12** | Was 6. This password is the only thing between a live session and every door code, lockbox combination and alarm sequence belonging to every one of the operator's clients. |
| `password_requirements` | `lower_upper_letters_digits` | Was empty. |
| `secure_password_change` | **true** | Was false. Narrows the exploit chain but **does not close it** — see below. |
| `sessions.timebox` | **12h** | Was commented out, so a session lived until its refresh token was revoked: an exfiltrated token was good indefinitely. An operator's working day is the unit; a phone left on a bus overnight should not still be signed in. |
| `sessions.inactivity_timeout` | **2h** | As above. |
| `mfa.totp.enroll_enabled` / `verify_enabled` | **true** | Both read `true` on staging — see *What the first read-back found*. |

### What `secure_password_change` actually buys

With it off, an attacker holding **only a live session** — stolen phone, XSS,
exfiltrated localStorage token — can call
`supabase.auth.updateUser({ password })` with *no knowledge of the current
password*, and then immediately satisfy the vault's password check with the
password they just set.

That reduces "compromise of one browser session" to "every entry code for every
one of that operator's clients, plus a clean audit trail attributing the reads
to the operator".

**This file used to say that turning the setting on closes that chain. It does
not.** GoTrue demands reauthentication before a password change only when the
session is *not* "recently signed in", and recently means **created within the
last 24 hours**. A freshly stolen session — which is the overwhelmingly likely
case for a lifted phone or a live XSS — is inside that window, so the password
change succeeds and the chain runs exactly as before. The setting protects only
sessions that have already aged past a day.

There is a second-order consequence, and it points the opposite way from what
you would guess:

> **A session timebox at or under 24h makes `secure_password_change` inert.**
> The timebox caps how old a session can get. Cap it at 12h and no session can
> ever reach the 24h threshold, so the reauthentication branch can never be
> taken. The two hardened values in the table above cancel each other out.

Both halves follow from documented GoTrue behaviour rather than from an
experiment run against this project; what would confirm them is a session held
past the window with the setting on. `scripts/check-auth-posture.sh` emits a
`::notice` the moment the timebox is set into that range, so the interaction
announces itself rather than waiting to be rediscovered.

**So the control that actually closes this path is the vault's own `aal2`
gate**, described below — it cannot be satisfied by anything an attacker can do
from a stolen session, because it requires the second factor itself. Keep
`secure_password_change` on regardless: it is free, and it covers the aged
sessions that exist whenever the timebox is unset, as it is today.

## What now reads the deployed posture back

`staging-smoke.yml` gained an **`auth-posture`** job. It fetches
`/v1/projects/{ref}/config/auth` through the Management API (using the
`SUPABASE_ACCESS_TOKEN` secret that workflow already holds), prints the live
settings into the run summary, and then:

- **fails** when `secure_password_change` is off, or the password floor is under 12
- **warns** when there is no session timebox or inactivity timeout, or TOTP is off

Printing it is most of the fix: "unknown from this repository" stops being true
the moment a reader of the Actions log can see it. The two failures are the ones
that decide whether the vault's re-auth means anything.

## What I deliberately did NOT do

**I did not add `supabase config push` to either deploy workflow**, even though
the review suggests it and it would be one line.

Two reasons, and the second is the real one:

1. `config push` applies the auth block **wholesale**. Until the values above
   were hardened, pushing `config.toml` would have *downgraded* a dashboard
   that might already be stricter — replacing whatever is set with a
   six-character password floor and MFA off. Hardening the file first is the
   prerequisite, and that is done; the readback above is how we find out what
   the dashboard currently holds.
2. **I could not verify it.** The Supabase CLI is not installed in the
   environment this work was done in, so I cannot confirm `config push` exists
   in the pinned 2.109.1, nor exactly which keys it applies. Adding an
   unverifiable step to the production **auth** configuration path — on a system
   holding other people's door codes — is the same shape as the defects this
   repository has spent a dozen PRs removing: the typecheck that checked zero
   files, the vault verification that verified nothing, the cron that reported
   dispatch as success.

The honest sequence is: read the posture back (now automatic), compare it to the
table above, change what differs **in the dashboard**, and wire `config push`
only once someone has watched it work against staging. That is a small, cheap
task for whoever next has a terminal with the CLI linked — it is not a task for
a session that cannot run the command.

## The vault's assurance gate (fixed in code)

The vault no longer accepts a password alone **when something better exists**.
`sessionAssurance()` reads the `aal` claim from the request's own token, and
`resolveAssurance()` returns one of three outcomes:

| Outcome | When | Result |
| --- | --- | --- |
| `aal2` | the session presented a second factor | allowed |
| `aal1_no_factor` | the account has no verified factor | **allowed** — where the product is today |
| `insufficient` | a verified factor exists, this session did not use it | **refused**, `second_factor_required` |

Graduated on purpose. Requiring `aal2` unconditionally would lock out every
operator who has not enrolled a factor, so the product would be unusable the
moment the gate shipped. This way, **enrolling a factor is what closes the
exploit, with no further code change** — and, per the section above, it is the
*only* thing that closes it.

An attacker cannot manufacture `aal2`: it needs the factor itself. So for any
operator with MFA enrolled, the change-the-password trick stops working even
while `secure_password_change` is still off.

A **missing** `aal` claim is treated as `aal1`, never as strong. That is what a
project with no MFA configured emits, and reading strength from an absent claim
would be the whole gate failing open. There is a test for it.

## What the first read-back found

The `auth-posture` job was written in the H2 PR and then **ran for the first
time on 2026-08-29**, months later: it fires on a successful staging deploy, and
no staging deploy succeeded in between. What it found:

```
password_min_length            6      (intended 12)      FAIL
secure_password_change         null   (intended true)    FAIL
sessions_timebox               0      (intended 12h)     warn
sessions_inactivity_timeout    0      (intended 2h)      warn
mfa_totp_enroll_enabled        true
mfa_totp_verify_enabled        true
```

Two of those are worth reading twice.

**TOTP is already on.** This file previously recorded MFA as a Pro-plan purchase
the owner had not made, and the `aal2` gate as inert pending that spend. Both
claims were wrong for this project: enrolment and verification are both enabled.
Nothing needs to be bought for an operator to enrol a factor, and doing so
closes the only exploit path this document describes. That is the
highest-value action available here, and it costs nothing.

**`secure_password_change` came back `null`, not `false`.** The check could not
originally tell those apart from a key that does not exist — see the header of
`scripts/check-auth-posture.sh`. It now can, and reports which it saw.

## Open decisions (owner)

1. **Enrol a TOTP factor** on each operator account. Free, available today, and
   the only control that actually closes the stolen-session path.
2. **Whether auth config is dashboard-managed or file-managed.** Pick one. If
   the dashboard, this file is the record and the readback job is the check. If
   the file, wire `config push` after verifying it, and the readback becomes a
   regression test rather than a report.
3. **`enable_signup = true`.** Open signup is currently required because client
   invites go through the same signup path (review H31). Closing it needs the
   invite flow to change first.

## Related

- `docs/dev/vault-key-rotation.md` — the key, not the auth
- `docs/spec/03-security-model.md` — the model these settings serve
- `docs/dev/staging-setup.md` — where the secrets live
