---
name: validate
description: Run the full Sanpo validation gate — typecheck, lint, unit tests, build, e2e, edge-function checks, database reset, SQL smoke tests, and the invariant greps. Use before every commit, before opening a PR, or whenever asked to validate.
---

Run every applicable gate below in order. A gate is skipped (with a printed
SKIP line, saying why) only if its subject genuinely does not exist or its
prerequisite is unavailable in this environment. Any failure stops the run;
report the failing gate and fix before re-running. Finish with a one-line
PASS/FAIL/SKIP summary per gate.

**This file mirrors `.github/workflows/ci.yml`. When one changes, change both —
a local gate that is weaker than CI is worse than no local gate, because it
reports PASS for a state CI will reject.** Review H21 found this file
prescribing `tsc --noEmit -p app`, which resolves zero input files and exits 0,
so the typecheck gate had never checked anything; and a bare `deno test`, which
CI runs with a specific permission.

## 1. Frontend typecheck
```
npm --prefix app exec tsc -- -b --force app
```
**Not** `tsc --noEmit -p app`. `app/tsconfig.json` is a solution file (`"files":
[]` plus project references), so `-p` checks *zero files* and exits 0 on a
syntax error. Only build mode (`-b`) follows the references; `--force` because
`-b` is incremental and both referenced projects set `noEmit`.

## 2. Frontend lint
```
npm --prefix app run lint
```
oxlint with `--deny-warnings`. A warning fails CI.

## 3. Frontend unit tests
```
npm --prefix app test -- --run
```
Besides the unit tests, the `node` project carries the source scans that used
to be CI greps: every error rendered through `FormError` or `StateField`
(`app/scripts/form-errors.test.ts`) and the one private Realtime channel
(`app/scripts/realtime-channel.test.ts`). They moved here because a grep could
not tell a `StateField` prop from a bare `<span>` four lines below its tag, and
because a CI-only check is a green local run CI then refuses.

## 4. Frontend build
```
npm --prefix app run build
```
Runs `verify:brand-assets` via `prebuild`, and stamps `dist/version.json`.

## 5. End-to-end (Playwright)
```
npm --prefix app run test:e2e
```
Backend-free: `/dev/today` and `/dev/kit` render deterministic fixtures against
a plain `vite dev`, so this needs no secrets. Covers the locked Today
composition, the sampled-from-pixels contrast floors, and the rendered tint
contrast sweep. First run needs `npm --prefix app run test:e2e:install`.
SKIP only if a browser genuinely cannot be installed here — say so explicitly,
because these are the gates whose absence let a broken `fn_book_walk` reach
production.

## 6a / 6b. Edge functions
```
deno check supabase/functions/**/index.ts
deno test --allow-read=supabase/migrations,supabase/functions ./supabase/functions/_tests/
```
The permission is exactly CI's — not `-A`. Widening it locally means a test can
pass here and fail there, which has already happened once. Widen only in the
same commit as the test that needs it, in both places.

## 7. Database reset (requires the local stack)
```
supabase db reset
```
or `scripts/db-reset.sh` on the no-Docker local stack.

## 7b. Would `supabase db push` apply this? (requires `LOCAL_DB_URL`)
```
./scripts/db-push-check.sh
```
Gate 7 connects as the cluster's bootstrap **superuser** and applies each file
statement-at-a-time, so it answers a weaker question than a deploy asks (review
M5): a superuser skips every ownership and privilege check, and hosted
Supabase's `postgres` is not one. This re-applies all of them from zero as a
non-superuser holding only the privileges in
`scripts/local-stack/platform-roles.sql`, one transaction per file — which is
also what stops a migration adding an enum value and using it in the same file
— and checks the filename/version contract `db push` derives its ordering from.
It uses its own throwaway database, so it neither needs nor disturbs gate 7's.
Must end with `DB PUSH CHECK PASS`.

## 8. SQL assertions (requires `LOCAL_DB_URL`)
```
psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/smoke.sql
psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/materializer.sql
```
`smoke.sql` must end with `SMOKE PASS`. Run every `supabase/tests/*.sql`, not
just these two — later work adds files here. Invariant 1 (`credit_balance`
written only by `fn_ledger_apply`) is asserted inside `smoke.sql` against
`pg_proc`, with a self-test of its own pattern; it was a CI-only step until the
spec-drift audit found two spellings of the write it could not see. Its rewrite
found three more rounds of the same class (an upsert, a `MERGE`, `clients *`),
so it no longer reads the target: any `update … set …` statement naming the
column outside `fn_ledger_apply` fails, on the premise — asserted — that only
`clients` has a `credit_balance` column. An UPDATE is not the only write
(Codex): an INSERT whose column list names the column, an INSERT with no
column list at all (positional, whatever its target), and `copy … from` fail
too, while a VALUES tuple or a source select that only READS the balance does
not.

## 8b. Concurrency suite (requires `LOCAL_DB_URL`)
```
./supabase/tests/concurrency.sh
```
The only suite that COMMITS — it runs two real backends against each other,
because a lock cannot be exercised AS a lock inside a single transaction
(review H20). It clears its own namespace on the way in and out, and refuses
to start on leftovers. Numbered here to match `validate.sh`, which it was
missing from until `money(send-once)`: retyping
`fn_claim_notification_send`'s return silently invalidated case 10's `t`/`f`
detectors, which passed 18/18 locally and went red in CI.

## 8c. Push endpoint allowlist parity (requires `LOCAL_DB_URL` and deno)
```
./scripts/check-push-endpoint-parity.sh
```
The push-service allowlist exists twice — `fn_is_push_service_endpoint` (0049)
refuses at registration, `isPushServiceEndpoint` (`_lib/webpush.ts`) refuses
before the `fetch` — and they are written against different primitives. This
asks both the same questions from one case list
(`scripts/push-endpoint-cases.txt`). It has its own gate because no other
runner here has a database AND deno; they disagreed on an uppercase scheme and
an explicit `:443` the day they were written.

## 8d. Walk cost parity (requires `LOCAL_DB_URL` and deno)
```
./scripts/check-walk-cost-parity.sh
```
The weekend-surcharge arithmetic exists THREE times — `weekendWalkCost`
(`app/src/lib/walk-cost.ts`, what Booking quotes), `fn_walk_cost`'s live
fallback (0043, what `fn_debit_walk` charges a row with no snapshot) and the
`fn_snapshot_walk_price` trigger (0044, what every new row is stamped with) —
and the trigger and the function were two copies of one expression in two
migrations that nothing tied together. One case list
(`scripts/walk-cost-cases.txt`), every implementation asked, answers compared
three ways across implementations — trigger against function, function
against TypeScript, all against the expectation — plus the TypeScript runs
against each other. The SQL side nulls the snapshot before asking
`fn_walk_cost`, because the function coalesces the snapshot first and its own
expression would otherwise be tied to nothing (a trigger drift is caught by
the TypeScript comparison regardless), and reads the function's answers
through a join on the null having taken. The TypeScript side runs four
times — under `Etc/GMT+12` and `Etc/GMT-14`, either side of the day boundary,
against a constant-offset local read (in the caller's own zone such a leaf
answers every case correctly), and under `America/Chicago` and
`Australia/Sydney`, two DST zones with complementary daylight seasons,
against a DST-dependent one, which passes both fixed offsets and is a day out
only in a zone currently on daylight time (so one zone alone pins it for half
the year; the run refuses by name if neither is on daylight time today) — and
the answers script requires the zone it was told. Must end with
`WALK COST PARITY PASS`. Same
prerequisites as 8c: skipped by name when deno is missing, and inside the
`7-8. database` skip when there is no database — a gate that goes green by
not running is this repository's most-recorded failure, so a SKIP here is a
reason to install deno, not to move on.

## 8e. The definer catalogue matches the database (requires `LOCAL_DB_URL`)
```
python3 scripts/check-definer-catalog-live.py
```
Gate 10a's generator reads the migrations and MODELS each function's ACL:
what a new function starts with (`PUBLIC`, plus the platform's default
privileges), what `CREATE OR REPLACE` keeps, what `DROP` and a new overload
reset. A model written from a reading of PostgreSQL's rules shares that
reading's mistakes, and so would a test written from the same reading — the
`check-auth-posture` lesson — so this asks the database gate 7 built: every
function in `public` the migrations create (extension members are left out
by `pg_depend`, not by name) must be in the model with the same argument
types, the same `SECURITY DEFINER` flag and the same API roles holding
EXECUTE, and the model may name nothing the database lacks. That also covers
the one thing the generator cannot see, a grant made by dynamic SQL inside a
body. Needs no deno. Must end with `DEFINER CATALOGUE LIVE PASS`, and refuses
by name when either side holds fewer than 50 functions, since two empty sides
agree.

## 9. Migrations are append-only (invariant 6)
```
git fetch -q origin main
git diff --name-status origin/main... -- supabase/migrations/ |
  grep -v '^A' && echo "FAIL: an existing migration was modified" || echo "PASS: append-only"
```
Until this landed in CI, invariant 6 was enforced only by a Claude Code hook —
a tool preference, invisible to anyone else touching the repo. CI is blind to
the violation on its own: `db-reset` replays every migration from scratch, so
an edited migration produces a fully green run, while `db push` skips it
entirely in staging and production. The schemas diverge silently and
permanently.

## 10a / 10b. Generated artefacts are not stale
Both are committed and both rot silently when a migration lands without a
regeneration. A stale `types.ts` makes `tsc` agree with code the database will
reject; a stale definer catalogue makes spec 03's grant-audit checklist lie
about which functions exist.

Reads the migrations only, so it always runs:
```
python3 scripts/gen-definer-catalog.py && git diff --exit-code -- docs/spec/03-security-model.md
python3 scripts/gen-definer-catalog-proofs.py
```
The generator reads the migrations with `gen-enum-catalog.py`'s SQL reader and
scans its skeleton; it used to strip comments with a regex pair that lost a
GRANT sharing a line with `--` inside a string, let a nested block comment end
early, and read a `/*` inside a string as a comment. It models each function's
ACL, and refuses by name a definer function `PUBLIC` or `anon` can execute or
one `authenticated` holds only through the platform's default privileges
(invariant 5) — so the first command above fails on either, before the diff.
The proofs are the reader's cases, one per rule of the model, and each shape
PR B's review found it misreading, with `main()` driven for both refusals; they
must end with `DEFINER CATALOGUE PROOFS PASS`.

Queries the **live schema**, so it needs gate 7's stack up. Without it the
script exits non-zero from `psql`, which is a missing prerequisite and not a
failing gate — report SKIP, not FAIL:
```
python3 scripts/gen-types.py && git diff --exit-code -- app/src/lib/types.ts
```

## 10c. Deploy workflow gating
```
python3 scripts/verify-workflows.py
```
Five rules that YAML validity cannot express, each written after the thing it
forbids shipped, or (rule 5) after a drift that had not failed yet. No job may
gate on its own result (it can then never run). A job whose `if` uses a status
function must re-state every `needs` it dropped the implicit `success()` for. A
job that runs `git push` needs `fetch-depth: 0`, because git cannot prove a
fast-forward from a shallow clone. Every checkout in a `workflow_run`-triggered
workflow pins `ref: ${{ github.event.workflow_run.head_sha || github.sha }}`.
The upstream SHA must be chosen first, because on that event `github.sha` is
main's newest commit rather than the one the upstream run tested or deployed.
The fallback must be `github.sha`, because on a manual dispatch the upstream
SHA is empty and the fallback is what gets checked out. Rule 4 fails if it
inspected no such checkout, since a trigger parse that read nothing would
report every checkout pinned. And rule 5: every `supabase/setup-cli` step pins
one commit SHA and one exact `X.Y.Z` CLI release, and every
`supabase functions deploy` runs with the same flags, because staging is the
only place a CLI version or a deploy path is exercised before production runs
it. The owner's `4c45ab1` had already moved staging's function deploy to
`--use-api` while production stayed on the Docker bundler. Each half fails if
it saw nothing.

## 10d. CLAUDE.md's counts match the tree
```
python3 scripts/check-status-counters.py
```
`CLAUDE.md` states the migration and edge-function counts in prose, and its
own note used to read "nothing enforces these two counts". They went stale at
review H21, again by `0043`, and a third time at `0051`. A fresh session reads
that paragraph as fact about this tree, so it is checked rather than trusted.
The gate FAILS when it cannot find the sentence carrying a count — a parser
that matches nothing reports agreement, which is how `column-grants.test.ts`
and `db-push-check.sh`'s object derivation both had to be fixed.

## 10e. Spec 01's enum catalogue is not stale
Reads the migrations only, so it always runs:
```
python3 scripts/gen-enum-catalog.py && git diff --exit-code -- docs/spec/01-data-model.md
```
Spec 01's enum block was hand-maintained under a heading that said "migration
0001". By 0049 it was missing `disputed` (in every partial-unique-index
predicate spec 04 says the code must agree with) and `card_saved`, plus four
whole enums — on the file an engineer reads to learn which statuses exist.
Same shape as 10a, and red for the same false reason when
`docs/spec/01-data-model.md` is merely uncommitted.

## 10f. The enum catalogue generator's proof set holds
Reads the migrations only, so it always runs:
```
python3 scripts/gen-enum-catalog-proofs.py
```
Forty-three review rounds on PR #88 each fixed one way `gen-enum-catalog.py`
could bless a wrong catalogue or refuse a healthy migration, and each fix was
proven red before it shipped — in a session scratchpad, which is a rule
connected to nothing once the container is gone. The probes are committed
now: each writes a migration into a scratch copy of the real set and asserts
the generator either renders the expected catalogue or refuses with the
sentence the rule names. About half a minute; a FAIL line names the rule.

## 10g. The three gate lists agree
```
python3 scripts/check-gate-lockstep.py
```
Every named `ci.yml` step has a row in §13 saying where it runs here, every
row names a step that exists, every gate below is run by `validate.sh` under
the same id, and every gate `validate.sh` runs is here — exactly, so a
lettered gate never stands in for its parent (the first version let `8b`
cover a deleted gate 8). `CLAUDE.md` called these three files a
lockstep for months before anything checked it, and they drifted exactly as
an unchecked list does: gates 7b and 8b were each missing from `validate.sh`
until a green local run that CI refused, and this file's own §13 ended "read
the workflow rather than trusting this list to stay complete". Must end with
`GATE LOCKSTEP PASS`.

## 10h. Every function setting is one the CLI applies
```
python3 scripts/check-function-config.py
```
`supabase functions deploy` reads `[functions.<name>]` from `config.toml` and
ignores a key it does not know. Measured on CLI 2.109.1 and 2.117.0 alike: a
`verfy_jwt = false` typo on a public function deploys with exit 0, no warning,
and `verify_jwt` unset, which the platform reads as on, so the gateway answers
every caller 401. The deploy probe
cannot see it, because it authenticates with the service-role key, which the
gateway accepts either way. So every key must be one the CLI's schema declares
(read from the pinned release, which the gate also checks has not moved), and
every table must name a function `scripts/repo-functions.sh` ships. Values are
not checked: the CLI coerces `env(VAR)` and comma lists, and a value it cannot
decode is a loud deploy failure anyway. It re-checks its own probes every run.

## 11. Secret-leak grep
```
grep -RInE "(VAULT_MASTER_KEY|SERVICE_ROLE|sk_live|sk_test)" app/src supabase/functions --include='*.ts' --include='*.tsx' | grep -v 'Deno.env.get' | grep -v env.ts && echo "FAIL: literal secret reference" || echo "PASS: no secret literals"
```

## 12. Every `var(--x)` names a property something defines

```
node app/scripts/check-css-tokens.mjs
```

An undefined custom property makes the **whole declaration** invalid at
computed-value time, and the property then behaves as `unset`: an inherited
property takes its parent's value, a non-inherited one drops to its **initial**
value. Either way the failure is a layout that looks subtly wrong rather than
an error anyone sees. Measured, not recalled: on `/pricing`,
`padding-left: var(--s-5)` computed to `0px` — not the UA list indent — and the
bullets hung out into the card's padding. This file used to say the element
"silently inherits", which is true only of inherited properties.

The history is three instances of one mistake, each through a door the check
did not watch. `feat(settings)` shipped `--fs-13` and four colour tokens written
from memory, which is why CI got the check. It was **missing from this file
until H6**, so a `var(--s-5)` went into CSS twice, `/validate` passed, and CI
caught it — a local gate weaker than the CI gate means "green locally" does not
predict "green in CI". Then a third `var(--s-5)` went into a React style object
in `Pricing.tsx` and sat live for weeks with every gate green, because both
copies scanned `*.css` only. The spacing scale is 1·2·3·4·6·8·12; all three
`--s-5`s became `--s-6`.

It is one script now, called by this gate and by `ci.yml`'s step "Every CSS
token used is a token that exists", because the three inline copies this
section used to say to "keep identical" had drifted: validate.sh read token
names as `[A-Za-z0-9_-]` and CI as `[a-zA-Z0-9-]`, which read `var(--a_c)` as
`--a`. What it checks, and why each rule exists, is in the script's header and
`app/scripts/css-tokens.test.ts`: uses come from string and template literals
in the TypeScript AST, so comments and JSX text never count — but every `var(`
in a string IS a use, wherever the string sits (MapView's SVG `stroke`/`fill`
are real ones), so prose that writes `var(--x)` is red too, and a red on a
string not visibly in a style says to write the name without `var(`; a name
built at runtime (`var(--s-${n})`) is read as a prefix some defined name must
start with, because a literal ending mid-name is a fragment; a custom property
counts as defined from TS only when its VALUE reaches the `style` prop of a
HOST element, a lowercase or dashed tag (a component may drop the prop, so its
`style` defines nothing and the red names the component) — an object that
flows into one (directly, through a spread, a ternary or `||`/`??`), or a
`const` used that way in the same file, resolved by symbol so a shadowing name
is a different binding — or is set by `….style.setProperty`,
and in either case only to a value that SETS it: a literal `null`,
`undefined`, boolean or `""` removes the property (React clears it, and so
does `setProperty` with `""` or `null`), so it defines nothing — nor does a
key a later property or spread in the same style takes off again, since React
applies the last value (a later element the gate cannot read, or a const
mutated after it is created, counts as leaving it set). A type decides
nothing: counting any `--x`-shaped key let a config object
"define" a token no style ever sets, and reading a `CSSProperties` annotation
as evidence let an unused typed object and a `CSSProperties | Payload` union
do the same (Codex, PR #95, four rounds). Every other flow into a style (an
import, a `let`, a function's return value) is left unrecognised on purpose,
and the red says so: when the missing name is set somewhere the gate cannot
follow, the FAIL line names every place it is set and suggests a default in
CSS, which is a real definition whatever the object is. That is the stopping
rule — recognising every flow is a type checker's job, and adding one shape
per review round is how a check grows without end. Test files are fixtures and
are not read; and it refuses to pass if it scanned no stylesheets, no TS, or
no string literals — a check that saw nothing reports agreement. Still
scope-blind, as it always was: a token defined under one selector satisfies a
use anywhere.

## 13. Every CI step, and where it runs here
`ci.yml` is what CI enforces; this table says where each of its steps runs
locally. Gate 10g fails when a step has no row, a row names no step, or a gate
id names no heading — so the list is complete by construction, where the one
it replaced was a hand-kept selection that told its reader not to trust it.
One row serves one name, so two steps may share a name only if they are the
same step in the same job setting after the same steps, as the two `Install`s
are; a pair that differs in any of the three is refused too.

- **a gate id**: `validate.sh` runs the same check under that number;
- **CI only**: a check with no local gate. Each is cheap to run by hand when
  you touch its subject — read the step in `ci.yml`;
- **setup**: an install or a cache, not a check.

| CI step | Here |
|---|---|
| `Install` | setup |
| `Typecheck` | 1 |
| `Lint (warnings fail)` | 2 |
| `Unit tests` | 3 |
| `Build` | 4 |
| `The built service worker is stamped, and precaches a usable shell` | CI only |
| `A production build without Supabase config is refused` | CI only |
| `Every test file is claimed by a vitest project` | CI only |
| `The deployed frontend sets its security headers` | CI only |
| `Deploy workflow gating` | 10c |
| `Every function setting is one the CLI applies` | 10h |
| `CLAUDE.md's counts match the tree` | 10d |
| `The CI, SKILL.md and validate.sh gate lists agree` | 10g |
| `Secret-leak grep` | 11 |
| `The build stamps the commit it was built from` | CI only |
| `version.json is excluded from the SPA rewrite` | CI only |
| `DEV fixtures absent from the production bundle` | CI only |
| `Every CSS token used is a token that exists` | 12 |
| `Behavioural tests still execute` | CI only |
| `Exactly one <main>, owned by AppMain` | CI only |
| `Resolve the Playwright version` | setup |
| `Chromium browser` | setup |
| `Today composition (4 viewports)` | 5 |
| `Today contrast (sampled from the artwork)` | 5 |
| `Tint contrast (rendered component gallery)` | 5 |
| `Today plate responsive candidates` | 5 |
| `Calendar week geometry` | 5 |
| `Every e2e spec is actually run by this workflow` | CI only |
| `Typecheck entrypoints` | 6a |
| `Tests` | 6b |
| `Every 5xx throw carries its cause` | CI only |
| `No secret logging grep (phase 01 gate)` | CI only |
| `Reset — shim + migrations 0001..NNNN + seed` | 7 |
| `Push endpoint allowlist — both implementations agree` | 8c |
| `Walk cost parity — TS leaf, fn_walk_cost and the snapshot trigger agree` | 8d |
| `Spec 03's definer catalogue matches the database` | 8e |
| ``Would `supabase db push` apply this?`` | 7b |
| `Smoke suite (credit engine + full spec-03 security matrix)` | 8 |
| `Materializer suite (idempotency, skips, no resurrection)` | 8 |
| `Concurrency suite (the row lock behind invariant 1)` | 8b |
| `The nightly schedule is in a migration` | CI only |
| `Generated types match the schema` | 10b |
| `Spec 03's definer catalogue matches the migrations` | 10a |
| `Spec 01's enum catalogue matches the migrations` | 10e |
| `The enum catalogue generator's proof set holds` | 10f |
| `No edits to migrations that already exist on the base branch` | 9 |
