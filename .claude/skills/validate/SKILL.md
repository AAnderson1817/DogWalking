---
name: validate
description: Run the full PawTrail validation gate — frontend typecheck + build, edge function checks, database reset, and SQL smoke tests. Use before every commit, at the end of every phase, or whenever asked to validate.
---

Run every applicable gate below in order. A gate is skipped (with a printed SKIP line) only if its subject doesn't exist yet in the current phase. Any failure stops the run; report the failing gate and fix before re-running. Finish with a one-line PASS/FAIL summary per gate.

## 1. Frontend typecheck (if `app/tsconfig.json` exists)
```
npx tsc --noEmit -p app
```

## 2. Frontend unit tests (if `app` has a `test` script)
```
npm --prefix app run test -- --run
```

## 3. Frontend build (if `app/package.json` exists)
```
npm --prefix app run build
```

## 4. Edge functions (if `supabase/functions/` has entrypoints)
```
deno check supabase/functions/**/index.ts
deno test supabase/functions/_tests/ 2>/dev/null || echo "SKIP: no _tests"
```

## 5. Database reset (if `supabase/migrations/` non-empty; requires `supabase start` running)
```
supabase db reset
```

## 6. Smoke tests (if `supabase/tests/smoke.sql` exists; requires `LOCAL_DB_URL`)
```
psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/smoke.sql
```
Must end with `SMOKE PASS`. Also run any additional `supabase/tests/*.sql` assertion scripts added by later phases (e.g. `materializer.sql`).

## 7. Secret-leak grep
```
grep -RInE "(VAULT_MASTER_KEY|SERVICE_ROLE|sk_live|sk_test)" app/src supabase/functions --include='*.ts' --include='*.tsx' | grep -v 'Deno.env.get' | grep -v env.ts && echo "FAIL: literal secret reference" || echo "PASS: no secret literals"
```
