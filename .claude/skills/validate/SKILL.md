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
deno test --allow-read=supabase/migrations ./supabase/functions/_tests/
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
./supabase/tests/concurrency.sh
```
`concurrency.sh` is the only suite that COMMITS — it runs two real backends
against each other, because the row lock behind invariant 1 cannot be
exercised inside a single transaction. It clears its own namespace on the way
in and out.
`smoke.sql` must end with `SMOKE PASS`. Run every `supabase/tests/*.sql`, not
just these two — later work adds files here.

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

## 10. Generated artefacts are not stale
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

## 11. Secret-leak grep
```
grep -RInE "(VAULT_MASTER_KEY|SERVICE_ROLE|sk_live|sk_test)" app/src supabase/functions --include='*.ts' --include='*.tsx' | grep -v 'Deno.env.get' | grep -v env.ts && echo "FAIL: literal secret reference" || echo "PASS: no secret literals"
```

## 12. The rest of CI's invariant checks
These live in `ci.yml` and are cheap to run by hand when touching their
subject; run them when relevant, and read the workflow rather than trusting
this list to stay complete:

- invariant 1 — `credit_balance` written only by `fn_ledger_apply` (a
  `pg_proc` catalogue assertion, not a grep over migration text)
- every `var(--x)` names a property something defines
- errors go through `FormError`, never a bare `field__error` span
- exactly one `<main>`, owned by `AppMain`
- the walk channel is private, and is the only channel
- every `new HttpError(5xx, …)` carries its cause
- DEV fixtures absent from the production bundle
- the build stamps its commit, and `version.json` is excluded from the SPA rewrite
- the nightly schedule is in a migration
