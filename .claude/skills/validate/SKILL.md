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

## 6. Edge functions
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
just these two — later work adds files here.

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
```

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
Three rules that YAML validity cannot express, each written after the thing it
forbids shipped: no job may gate on its own result (it can then never run); a
job whose `if` uses a status function must re-state every `needs` it dropped the
implicit `success()` for; and a job that runs `git push` needs `fetch-depth: 0`,
because git cannot prove a fast-forward from a shallow clone.

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

## 10f. The catalogue generators' proof set holds
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

It covers BOTH catalogue generators. `gen-definer-catalog.py` (gate 10a) read
migrations with the naive comment-stripping regex pair `gen-enum-catalog.py`
had to replace, so it carries its own probes here — the file name still says
`enum` because renaming it would cost more than it tells anyone, and the
footer says `catalogue-generator proofs` rather than `enum`.

## 10g. The three gate lists are in lockstep
Reads four files, so it always runs:
```
python3 scripts/check-gate-lockstep.py
```
`CLAUDE.md` says to keep `ci.yml`, `SKILL.md` and `validate.sh` in lockstep,
and nothing checked it — this repository's most-recorded defect, a rule written
down and connected to nothing. It had already drifted three ways:
`db-push-check.sh` was CI-only for a whole PR and `concurrency.sh` for another,
each found only when CI refused a commit that had passed locally; §13 below
told a fresh session that two gates existed only in CI when fifteen did; and
the secret-leak step called itself "validate gate 7" when it is gate 11.

Every named `run:` step in `ci.yml` is classified in the script as SETUP, as a
`validate.sh` gate label, or as CI_ONLY. It fails on an unclassified step, on a
map entry naming a step that no longer exists, on a `validate.sh` label the map
claims and `validate.sh` does not declare, on a §13 entry with no step behind
it, and on the CI-only count in `docs/dev/session-notes.md` disagreeing with
the measured one. The map is an allowlist of exceptions, editable only in that
file and only in the same commit as the step it describes.

## 11. Secret-leak grep
```
grep -RInE "(VAULT_MASTER_KEY|SERVICE_ROLE|sk_live|sk_test)" app/src supabase/functions --include='*.ts' --include='*.tsx' | grep -v 'Deno.env.get' | grep -v env.ts && echo "FAIL: literal secret reference" || echo "PASS: no secret literals"
```

## 12. Every `var(--x)` names a property something defines

```
python3 - <<'PY'
import re, pathlib, sys
defined, used = set(), {}
for f in pathlib.Path('app/src').rglob('*.css'):
    t = re.sub(r'/\*.*?\*/', '', f.read_text(), flags=re.S)
    for m in re.finditer(r'(--[A-Za-z0-9_-]+)\s*:', t): defined.add(m.group(1))
    for m in re.finditer(r'var\(\s*(--[A-Za-z0-9_-]+)', t): used.setdefault(m.group(1), str(f))
missing = sorted((k, v) for k, v in used.items() if k not in defined)
for k, v in missing: print(f"FAIL: {k} is used but never defined ({v})")
sys.exit(1 if missing else 0)
PY
```

An undefined custom property makes the **whole declaration** invalid, and the
element silently inherits instead — so the failure is a layout that looks
subtly wrong rather than an error anyone sees. This gate shipped in CI with
`feat(settings)`, after four colour tokens and `--fs-13` were written from
memory and none of them existed.

It was **missing from this file until H6**, which is the more interesting
defect: the spacing scale is 1·2·3·4·6·8·12 with no `--s-5`, a `var(--s-5)`
went in twice, `/validate` passed, and CI caught it. A local gate weaker than
the CI gate is the same shape as the `deno test -A` mismatch recorded at the
top of this file — it means "green locally" does not predict "green in CI",
which is the only thing running these gates before committing is for.

Keep this identical to `.github/workflows/ci.yml`'s step of the same name.

## 13. The rest of CI's invariant checks
These run in `ci.yml` and NOWHERE ELSE, so a green `scripts/validate.sh` says
nothing about them. Every entry is the `ci.yml` step's exact name, and
`scripts/check-gate-lockstep.py` (gate 10g) fails in both directions: a
CI-only step missing from this list, and a list entry naming a step that no
longer exists. The count is checked too — `docs/dev/session-notes.md` told a
fresh session there were two of these, the spec-drift audit that found it said
seven, and the measured number is fifteen.

Run one by hand when you touch its subject; read the workflow for what each
actually does.

- `The built service worker is stamped, and precaches a usable shell`
- `A production build without Supabase config is refused`
- `Every test file is claimed by a vitest project`
- `The deployed frontend sets its security headers`
- `The build stamps the commit it was built from`
- `version.json is excluded from the SPA rewrite`
- `DEV fixtures absent from the production bundle`
- `Behavioural tests still execute`
- `Exactly one <main>, owned by AppMain`
- `The walk channel is private, and is the only channel`
- `Every e2e spec is actually run by this workflow`
- `Every 5xx throw carries its cause`
- `No secret logging grep (phase 01 gate)`
- `Invariant 1 — credit_balance written only by fn_ledger_apply`
- `The nightly schedule is in a migration`

