# Working in this repository

`CLAUDE.md` carries the invariants, conventions, working agreement and status
log; `docs/spec/` is authoritative for behaviour. This file is the operational
half neither of those covers: how to get a container running, which gates lie
to you, and the traps this repository has already paid for.

It exists because that knowledge used to live in a session handoff document
that had to be re-uploaded to be useful — and a fact nobody can find is a fact
nobody has. If you learn something here the hard way, add it here.

**Read first:** `CLAUDE.md` → `docs/dev/backlog.md` (what to work on) → this
file → the `docs/spec/` file your task touches.

## Bringing the container up

```sh
# database (see docs/dev/local-stack.md for what the shim does)
bash scripts/db-start.sh
export LOCAL_DB_URL="postgresql://postgres@127.0.0.1:54322/postgres"
bash scripts/db-reset.sh

# frontend deps — `ci`, not `install`: it installs exactly what the lockfile
# says, refuses if package.json and the lock disagree, and cannot rewrite the
# lock underneath you. It is what ci.yml runs (lines 40 and 419), so a green
# local run means the same dependency tree CI validated. Takes ~10s here.
npm ci --prefix app

# deno — often absent. deno.land is blocked by the egress proxy in this
# environment; the npm package carries the same binary and works:
npm install -g deno@2.9.1          # 2.9.1 is the CI pin — match it

# e2e — the preinstalled Chromium does not match the @playwright/test pin.
# Do NOT run `playwright install`; use the config's opt-in escape hatch
# (app/playwright.config.mjs:26 reads this and sets executablePath):
export PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome

# the env gate refuses a build without these; any placeholder will do
export VITE_SUPABASE_URL=https://placeholder.supabase.co
export VITE_SUPABASE_ANON_KEY=placeholder-anon-key
```

With all of the above exported, `bash scripts/validate.sh` runs the full gate.

## Gates that lie, and gates that are not there

- **`validate.sh` gates 10a/10b regenerate a file and `git diff --exit-code`
  it** — the definer catalogue in `docs/spec/03-security-model.md`, and
  `app/src/lib/types.ts`. They go red when *those two files* are uncommitted,
  which includes the case where your own edit to them is merely unstaged, not
  only the case where the generator produced a change. If they are the only
  red, commit and re-run before diagnosing. A dirty tree elsewhere does not
  trip them.
- **A missing tool makes a gate PASS by not running.** `validate.sh` skips its
  deno gate when deno is absent. Install it first; a gate that goes green by
  not running is this repository's most-recorded failure.
- **Two gates exist only in CI**, so a green local run does not cover them:
  *Every test file is claimed by a vitest project* and *Every e2e spec is
  actually run by this workflow*. Both matter — see the traps below.
- **`scripts/db-push-check.sh` is not part of `validate.sh`.** Run it for any
  PR touching `supabase/migrations/`: it re-applies every migration from zero
  as a **non-superuser**, one transaction per file. The ordinary reset runs as
  the bootstrap superuser and skips every ownership and privilege check a real
  deploy performs.

## Traps this repository has already paid for

- **Never `git restore` or `git checkout <file>` to recover uncommitted work.**
  The status log records six separate times this destroyed work in progress.
  For red-first sabotages: copy the **fixed** file to a scratch directory,
  apply the sabotage, verify the diff is non-empty, run, then restore from
  that copy. Restoring from a snapshot taken *before* the fix silently reverts
  it — that is how the sixth one happened.
- **Then check the restore actually happened.** The seventh instance was not a
  wrong snapshot but a restore that never ran: the sabotage was one link of a
  `cd app && SNAP=… && cp …` chain, the `cd` failed because the shell was
  already there, and every later link — including the restore — was skipped
  in silence. Issuing a restore is not the same as having restored. Assert the
  file is back (`grep -c` for something the sabotage removed) before believing
  any green run, and remember that a `validate.sh` started before a sabotage
  and finishing after it has told you nothing.
- **Restoring a sabotaged MIGRATION does not restore the database.** Smoke-level
  sabotages injected after `begin;` roll back with the suite, which is why this
  only bites when you edit the migration itself and re-reset. Put the file back
  AND re-run `db-reset.sh`, then assert against the LIVE definition
  (`pg_get_functiondef`) rather than the file — the file being right tells you
  nothing about what the database is running.
- **Grep the definition with comments STRIPPED.** A well-commented function
  argues about the thing it does, so its own prose matches your needle: in
  0048, `for no key update` appeared three times in the live definition and
  only once in the code. Checking the raw text reported the fix present while
  the database was running the sabotaged body — the same mention-versus-use
  defect 0046's second Codex round found in a migration's own assertion.
  `regexp_replace(def, '--[^\n]*', '', 'g')` first.
- **A vitest file claimed by neither project runs nowhere, silently.** `node`
  takes `src/lib/**/*.test.ts` and `scripts/**/*.test.ts`; `dom` takes
  components / screens / hooks / prototypes plus `src/lib/**/*.test.tsx`. The
  orphan check is CI-only, so locally the file just never runs.
- **A new e2e spec needs its own named step in `ci.yml`.** Specs are invoked
  by filename; locally everything runs, so the gap only appears in CI.
- **Migrations are append-only and guard-enforced.** Never edit an applied,
  merged migration. One not yet merged may be rewritten in place — the
  append-only check exempts files *added* relative to `origin/main`.
- **Background agents can mutate the working tree while you validate.** If a
  gate fails inexplicably mid-run, `git status` before theorising: a subagent
  reproducing a sabotage will show up there in one command.
- **Sabotaging SQL is cheap if you inject it after `smoke.sql`'s own
  `begin;`** (line 11). The whole run rolls back, so no database reset is
  needed between proofs.
- **Assert on a named sentence, not a bare call.** A sabotage that aborts the
  suite with Postgres's own message reads as a broken suite rather than a
  broken rule. Wrap the call and raise your own `FAIL: …`.
- **A non-zero exit is not proof that a sabotage worked.** Check that YOUR
  `FAIL:` sentence appeared. In 0049 a sabotage of the upsert duplicated a
  column assignment, so the `create or replace` errored and the function was
  never replaced — the run exited 3 and looked red while testing nothing. A
  non-empty diff was not enough here, because the diff applied and the SQL
  did not. Make the batch runner print "(no FAIL line)" and treat that as a
  failure of the proof, not of the code.
- **The same trap in TypeScript is a bare `assertRejects`.** It passes for any
  rejection, including one from a dependency that blew up because your
  sabotage moved it earlier — so a test written to pin *which* refusal happens
  goes green against the exact defect it exists to catch. Assert on the error:
  `err instanceof HttpError && err.status === …`. Found in 0048's own new
  tests, by the sabotage, not by review.
- **`pg_get_functiondef` does not return a terminating semicolon.** Building a
  sabotage from the LIVE definition is the right technique (it cannot silently
  drop what a later migration added), but pasted straight into a script the
  next statement collides with it and psql dies on a syntax error hundreds of
  lines before your assertion. Same class as the entry above: exit non-zero,
  nothing proved. Append the `;`.
- **Tightening a validation rule silently invalidates other suites' fixtures.**
  PR #85 added a push-service host allowlist; `push_delivery_test.ts` went red
  immediately (its fixtures were arbitrary hosts) and was fixed. `concurrency.sh`
  case 7 did NOT, because its assertion — "at most 10 rows" — was satisfied by
  the nine seed rows alone: all ten concurrent registrations ERRORED, nothing
  was inserted, and the case printed `ok (got 9)` locally and in CI. The rule
  is not "grep for the fixture" — it is that **an assertion with a floor is
  vacuous without a precondition**. Any case whose detector can be satisfied by
  doing nothing needs an explicit "the thing under test actually happened"
  check, run FIRST, labelled as a precondition (cases 1, 5 and 6 already do).
- **A green tick is not a green run.** The above was found by reading the CI
  job log, where the postgres *service container* log at the very end printed
  ten `ERROR: … is not a push service` lines the job itself never surfaced.
  After a change that could make a fixture invalid, read the log of the job
  that exercises it rather than the conclusion.
- **A sabotage can be red for the WRONG reason.** When several rules share one
  assertion, change exactly one of them. A userinfo-blind host parse written
  for PR #85 also dropped the suffix list, so it failed on "a real push service
  endpoint was refused" rather than on the near-miss it was aimed at — a
  perfectly red run that demonstrated a different rule. If the aggregate cannot
  tell them apart, probe each rule directly (`select fn_x('…')`) alongside the
  suite run; that is cheap and it is what makes "individually load-bearing" a
  reading rather than a claim.

## Verifying things the gates cannot see

`smoke.sql` runs through psql and simulates personas with `set local role`; it
never goes through PostgREST, and no e2e spec signs in against a backend. So a
whole class of defect — anything about what the *HTTP client* asks for — is
invisible to every gate.

When that class is in scope, run a real PostgREST against the local database.
The binary is a single download from the PostgREST GitHub releases, points at
`LOCAL_DB_URL`, and with `db-anon-role = authenticated` plus an HS256 JWT
whose `sub` is a seeded operator you get a genuine authenticated request with
RLS live. That is how the `select=*` 42501 blocker was found; nothing in the
repository could see it.

## The rhythm, per PR

1. Start from main: `git fetch origin main && git checkout -B <branch> origin/main`.
   A branch whose PR already merged is finished — restart it from main rather
   than stacking on merged history.
2. Read the spec your task touches. Build with **red-first proofs**: a test
   that fails against the plausible wrong implementation, behind a verified
   non-empty diff.
3. Fast gates (`tsc -b --force`, lint, vitest), then full `validate.sh`.
4. Update the spec **in the same commit** as the code, and append one status-log
   entry to `CLAUDE.md` in the established voice: defect → mechanism → fix →
   what was proven red-first → counts. Counts must be read, not recalled.
5. Open the PR against the template. **Wait for the Codex review** — it has
   found real defects on every recent PR, including ones an independent
   adversarial pass had just missed.
6. Merge by **rebase** on green, then verify the staging chain: CI on main →
   Deploy staging → Staging smoke. *Auth posture (staging)* is red by design
   until an owner dashboard change; it is not yours.

### Codex reviews the commit the PR opened with

It does not re-review on push. If your own commits change the diff afterwards,
comment `@codex review` to get the head you would actually merge looked at.
On PR #80 that re-request found two defects in fixes that had themselves come
out of an adversarial pass — including a comment-stripping guard that stripped
only `--` and so still passed for the wrong reason.

## Commit identity

`CLAUDE.md` requires the author `AAnderson1817 <andyanderson1818@gmail.com>`
and the `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer. Set
the author explicitly per commit if your harness suggests otherwise:

```sh
GIT_AUTHOR_NAME="AAnderson1817" GIT_AUTHOR_EMAIL="andyanderson1818@gmail.com" git commit …
```

The **committer** is not worth setting: GitHub's rebase merge rewrites it to
the merging account, so whatever you put there does not survive onto `main`
(verified against `git log --format='%cn'` on main). The author and the
trailer are what persist, and they are what the ownership section is about.

## Escalation

`docs/dev/owner-actions.md` is the list of things no file here can do. Beyond
that, the owner reserves for a review-first session: migrations that touch
money invariants, the credential vault, RLS semantics, or the deploy
workflows. If a diff grows into one of those, say so and stop rather than
merging — unless the owner has authorised that category for the session, as
they did for the `0046` invite and unsubscribe-token work.
