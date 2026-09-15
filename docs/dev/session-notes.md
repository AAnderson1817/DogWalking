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

- **`validate.sh` gates 10a/10b/10e regenerate a file and `git diff --exit-code`
  it** — the definer catalogue in `docs/spec/03-security-model.md`,
  `app/src/lib/types.ts`, and the enum catalogue in
  `docs/spec/01-data-model.md`. They go red when *those three files* are uncommitted,
  which includes the case where your own edit to them is merely unstaged, not
  only the case where the generator produced a change. If they are the only
  red, commit and re-run before diagnosing. A dirty tree elsewhere does not
  trip them.
- **Gate 10f is the catalogue generators' proof set**
  (`scripts/gen-enum-catalog-proofs.py`: the probes from the forty-three review
  rounds on PR #88 plus the controls; its footer reports how many hold, and no
  count is written here because a count in prose goes stale the day a control
  is added — Codex on PR #90, round five). To pin a new rule, add a
  `scratch("name", sql)` probe and
  assert either `unchanged(d)` (a healthy migration renders the committed
  catalogue), a value list from `run(d)[1]`, or `refuses(d, "<the sentence the
  rule names>")` — never a bare exit, which any crash satisfies. `run()` RAISES
  `Refused` when the generator refuses, so an absence proof (`"x" not in
  run(d)[2]`) cannot pass on the empty result a refusal used to return — a
  generator that wrongly refused a valid `drop type` passed every proof
  asserting the type was gone (Codex on PR #90, round two). Probes run on an
  ENUM-ONLY copy of the real migrations — every `create/alter/drop type`
  verbatim under its own file name, found by the generator's own
  `enum_statement_spans`, nothing else — so a real migration that
  creates a schema (arming the shadow guard) or sets a session state cannot
  turn the probes red while the real tree is green (round four: one
  `create schema aux_future;` turned 64 of them red); a control asserts that
  baseline renders the committed block before any probe runs. Prove it red
  by reinstating the defect on a snapshot of the generator, then `cp` the
  snapshot back and `cmp` before believing the next green run.
- **Gate 10f also carries the DEFINER catalogue's probes**, at the end of the
  same file, because `gen-definer-catalog.py` reads migrations through the
  same `strip_sql` (it carried its own regex comment stripper until then, and
  every catalogue probe there made spec 03's grant-audit checklist wrong
  against it). A definer probe is `definer_rows(name, sql)` against a migration set
  holding that SQL and NOTHING else, and it asserts the WHOLE table plus the
  exit code and stderr — an expectation naming one row is satisfied by a
  harness that produces no rows, which is why three preconditions sit above
  them (a grant shows its role, an invoker function is catalogued by nobody, a
  real grant to `anon` fails the run by name).
- **A missing tool makes a gate PASS by not running.** `validate.sh` skips its
  deno gate when deno is absent. Install it first; a gate that goes green by
  not running is this repository's most-recorded failure.
- **`db-push-check.sh` and `concurrency.sh` were CI-only until recently** and
  are now `validate.sh` gates 7b and 8b. Both were added after a green local
  run that CI refused, one PR apart. If you add a gate to `ci.yml`, add it to
  `validate.sh` and `SKILL.md` in the same commit — `CLAUDE.md` calls the
  three a lockstep and the drift is invisible until CI disagrees with you.
- **Fourteen gates still exist only in CI**, so a green local run is not a
  green CI run. They are listed by exact step name in `SKILL.md` §13 rather
  than here, because a count written into prose is a count that rots — and this
  one has already rotted three times: the bullet said TWO, the spec-drift audit
  that found it said seven, measuring gave fifteen, and moving the walk-channel
  check into gate 3 one commit later made it fourteen.
  `scripts/check-gate-lockstep.py` (gate 10g) checks the list, the count and
  this sentence against `ci.yml`, which is why the number above is right rather
  than merely written down.

## Traps this repository has already paid for

- **Never write the working tree from git to recover uncommitted work.** The
  named offenders are `git restore` and `git checkout <file>`, but the rule is
  about the CLASS, not those two spellings: the eighth instance was
  `git checkout-index -f -a`, reached for reflexively, which overwrote every
  unstaged file from the index — silently destroying two finished edits and
  their red-first proof. Anything that writes the tree from git, the index or a
  commit is the same hazard, including `git stash`, `git clean` and
  `git read-tree -u`. The status log records seven earlier times.
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
- **No backticks inside a double-quoted shell string — including in comments.**
  `psql "$DB" -c "..."` is a double-quoted string, so a backticked word in a
  SQL comment inside it is COMMAND SUBSTITUTION: bash runs it, prints
  `foo: command not found` to stderr, and splices the empty result into the
  SQL. Harmless by luck, not by design. Third recorded instance in this repo
  (`ops(deploy-retry)` had it twice in one warning string), and this one was
  found only because a sabotage run surfaced the stderr that a passing run
  hides. A grep for it is NOT reliable — shell quoting defeats a crude parser,
  and mine produced a false positive on the first try — so this is a rule to
  remember rather than a gate.
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
  Changing a function's RETURN TYPE does the same thing: `money(send-once)`
  moved `fn_claim_notification_send` from boolean to uuid, and case 10's
  detectors counted `t`/`f` lines. That one was legible only because all three
  of its assertions — the precondition included — fell to zero at once.
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
- **Extract a module with TEXT ANCHORS, never line ranges.** Splitting
  `deps.ts` out of `send-notification/index.ts` by line numbers cut through a
  comment block and produced a file that would not parse. Same defect as the
  L21 CSS split, which a depth-blind `re.split` cut through an `@media` block.
  Slice on strings you can see, and assert each boundary matched something
  non-empty before writing either file.
- **A deps module that reads `Deno.env` at construction cannot be constructed
  in a test.** CI runs `deno test` with NO permissions, so `makeSendDeps()`
  reading `SUPABASE_URL` at call time fails with `NotCapable` the moment a
  test imports it — and the whole reason to split a `deps.ts` out of an
  `index.ts` is that importing `index.ts` runs `serveFunction` and binds a
  port. Hoist every `Deno.env.get` into `index.ts` and pass a config object.
  `send-notification/{deps,push_deps}.ts`, `billing-portal/deps.ts` and
  `connect-onboarding/deps.ts` are the worked examples, each driven by its
  own `*_deps_test.ts` against `_tests/scripted_db.ts`; a `handler.ts` is
  the other seam (decisions behind a deps OBJECT) and reads no env either.
- **A scan OVER edge code lives in vitest, not deno.** A gate that reads
  `supabase/functions/*.ts` as text — `select-columns.test.ts`,
  `discarded-errors.test.ts` — is a `scripts/**/*.test.ts` file in the node
  vitest project: that is where the precedent lives, the orphan check in
  `ci.yml` already claims that directory, gate 3 runs it with no new line in
  `ci.yml`/`SKILL.md`/`validate.sh`, and `app` already depends on
  `typescript` when a real parser is wanted. Deno tests DRIVE the edge code;
  vitest scripts READ it.

- **`${#arr[@]}` on an EMPTY associative array is "unbound" under `set -u`
  in bash 5.2.** `scripts/check-walk-cost-parity.sh` died with `trg: unbound
  variable` on a dead database — exit non-zero, and the named count sentence
  never printed. Count by hand (an `n=$((n+1))` beside each assignment);
  separately, read a possibly-missing ENTRY as `${arr[$k]-}` — that form
  fixes a different expression and does not make `${#arr[@]}` safe.
- **A sabotage that goes red on TYPECHECK is red for the wrong reason.**
  Deleting a refusal from a handler leaves the row possibly null, and
  `deno check` fails before the test runs. Rewrite the sabotage so it
  compiles and the red is the test's own sentence; three of the handler-seam
  sabotages needed this.
- **The repository's `_tests/asserts.ts` `assertEquals` on two Error objects
  cannot fail** — it is JSON-stringify equality, so it compares `{}` to `{}`
  (`@std/assert`'s would fail; that is not the one the suite imports). To pin
  that a raw error propagates un-wrapped, assert identity (`err === boom`).
- **Two worktrees cannot share the e2e dev server.** `playwright.config.mjs`
  starts `npm run dev` on 5173 and REUSES an existing one outside CI, so a
  second validate run in another worktree either kills the first's server or
  is served the other tree. `E2E_BASE_URL` disables the managed server
  entirely — set it only for a server you started on that port yourself.
  Serialise the runs instead.
- **Agents validating in parallel need their own Postgres.** `db reset` on a
  shared cluster tears the other run's database out from under it; give each
  run a cluster on its own port (its own `PGDATA`) and point `LOCAL_DB_URL`
  at it.
- **A gate that runs in the caller's zone pins nothing about zones — two
  fixed offsets pin nothing about DST — and one DST zone pins a
  DST-dependent leaf only in its own daylight season.** A leaf that shifts
  UTC midnight by the offset in force NOW passes `Etc/GMT+12` and
  `Etc/GMT-14` (no DST) and is a day out in a DST zone only while that zone
  is on daylight time, on rows dated in its standard time (measured:
  America/Chicago catches `2026-03-07` and `2027-01-02` at its daylight
  offset and nothing at its standard one). Gate 8d runs America/Chicago AND
  Australia/Sydney, whose daylight seasons are complementary, and asserts
  each run that one of them is on daylight time today; its answers script
  REQUIRES the zone argument, because with it optional a shell edit that
  dropped it stayed green.
  The rest of this bullet is the first pass: CI runs
  in UTC, where a leaf that reads the LOCAL day (`new Date(d).getDay()`)
  answers every date correctly; gate 8d runs its TypeScript side under
  `Etc/GMT+12` and `Etc/GMT-14` and has the answers script refuse a runtime
  that ignored `TZ`. A DATE has no zone, so DST-transition cases cannot pin a
  parse either — the first version of that case file said they did.

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

The same is true of a workflow `run:` block: no gate here executes one, and the
staging workflows run against a live project nobody should be poking at to test
a change. Drive it instead — read the step out of the YAML with the parser
`verify-workflows.py` uses, substitute the `${{ }}` expressions (asserting the
substitution matched, or the step ends up talking to a URL that does not
resolve and every assertion is really about curl failing), write the block to a
file and run it with `bash -e`, which is GitHub's default `shell`. Point it at
a stub that refuses the way the real API does — GoTrue caps `per_page`, a
create collides with 422, a REST delete refused by a foreign key answers 409.
`app/scripts/staging-fixtures.test.ts` is the worked example, and
`ops(smoke-fixtures)`/`ops(deploy-retry)` are two earlier ones. Shell functions
cannot cross a step boundary, so sharing them between steps means a committed
script both steps source plus a checkout in that job — which is also the only
way anything can exercise them.

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
and a `Co-Authored-By: Claude <model> <noreply@anthropic.com>` trailer naming
the co-authoring model (the harness states the current one). Set
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
