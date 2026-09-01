#!/usr/bin/env bash
# The validation gate, runnable by a person.
#
# Review L22: `CLAUDE.md` names `/validate` as the thing to run before every
# commit, and `/validate` is a Claude Code skill — so the canonical gate could
# only be invoked from one tool, and a human contributor had no way to run it
# at all. This script is the same gates in the same order.
#
# It is NOT a replacement for `.claude/skills/validate/SKILL.md`, which carries
# the reasoning: why each gate exists, which defect it was written after, and
# when a SKIP is honest rather than a dodge. Read that when a gate fails.
#
# Gates whose prerequisite is genuinely absent (no local database, no browser)
# print SKIP and do not fail the run — but the summary at the end names them,
# because a skip that scrolls past is how a gate stops existing.
#
# Usage:
#   scripts/validate.sh              # everything available here
#   scripts/validate.sh --fast       # skip the build, e2e and database gates
#   LOCAL_DB_URL=postgres://…        # enables the SQL gates
set -uo pipefail

cd "$(dirname "$0")/.."

FAST=0
[ "${1:-}" = "--fast" ] && FAST=1

pass=(); fail=(); skip=()

# `run` records an outcome rather than exiting, so one failure does not hide
# the state of every gate after it — the point of running these locally is to
# learn everything that is wrong in one pass.
run() {
  local name=$1; shift
  printf '\n\033[1m── %s\033[0m\n' "$name"
  if "$@"; then pass+=("$name"); printf '\033[32mPASS\033[0m  %s\n' "$name"
  else fail+=("$name"); printf '\033[31mFAIL\033[0m  %s\n' "$name"; fi
}
skip_gate() { skip+=("$1"); printf '\n\033[33mSKIP\033[0m  %s — %s\n' "$1" "$2"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ── 1–4. Frontend ─────────────────────────────────────────────────────────
# `tsc -b`, never `-p`: app/tsconfig.json is a solution file ("files": [] plus
# project references), so `-p` checks ZERO files and exits 0 on a syntax error.
run "1. typecheck"    npm --prefix app exec tsc -- -b --force app
run "2. lint"         npm --prefix app run lint
run "3. unit tests"   npm --prefix app test -- --run

if [ "$FAST" = 1 ]; then
  skip_gate "4. build" "--fast"
elif [ -f app/.env.local ] || [ -f app/.env.production ] || [ -n "${VITE_SUPABASE_URL:-}" ]; then
  run "4. build" npm --prefix app run build
else
  # `verify-env.mjs` refuses a build with no keys, on purpose (review H22), so
  # this is a missing prerequisite rather than a failing gate.
  skip_gate "4. build" "no app/.env.local and no VITE_SUPABASE_URL — see app/.env.example"
fi

# ── 5. End-to-end ─────────────────────────────────────────────────────────
if [ "$FAST" = 1 ]; then
  skip_gate "5. e2e" "--fast"
elif [ -d app/node_modules/@playwright ] || [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
  # A container with a preinstalled Chromium whose build number does not match
  # the @playwright/test pin fails to launch with a message that reads as "not
  # installed". `PLAYWRIGHT_CHROMIUM_PATH` is the config's escape hatch for it.
  run "5. e2e" npm --prefix app run test:e2e
else
  skip_gate "5. e2e" "no Playwright browsers — 'npm --prefix app run test:e2e:install', or set PLAYWRIGHT_CHROMIUM_PATH to one already on this machine"
fi

# ── 6. Edge functions ─────────────────────────────────────────────────────
# The permission is exactly CI's, not `-A`. A locally-wider permission means a
# test can pass here and fail there, which has already happened once.
if have deno; then
  run "6a. deno check" bash -c 'deno check supabase/functions/**/index.ts'
  run "6b. deno test"  deno test --allow-read=supabase/migrations,supabase/functions ./supabase/functions/_tests/
else
  skip_gate "6. edge functions" "deno is not installed"
fi

# ── 7–8. Database ─────────────────────────────────────────────────────────
if [ "$FAST" = 1 ]; then
  skip_gate "7-8. database" "--fast"
elif [ -n "${LOCAL_DB_URL:-}" ] && have psql; then
  run "7. db reset" scripts/db-reset.sh
  # 7b is SKILL.md's and ci.yml's (ci.yml:673) and was missing here, so
  # `validate.sh` did not in fact run "the same gates in the same order" as
  # CLAUDE.md's command list claims. Gate 7 connects as the cluster's bootstrap
  # SUPERUSER, which skips every ownership and privilege check a deploy
  # performs; 7b re-applies all of them as a non-superuser holding only the
  # privileges in platform-roles.sql, one transaction per file. It is also the
  # only gate that can see a missing `grant ... to service_role`, because the
  # objects it creates carry no platform default ACL to hide behind (0050).
  run "7b. db push check" scripts/db-push-check.sh
  for f in supabase/tests/*.sql; do
    run "8. $(basename "$f")" psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -f "$f"
  done
  # 8b is the only suite that COMMITS, running two real backends, so it is the
  # only one that can exercise a lock AS a lock (review H20). It was CI-only
  # until now, which is why a change to `fn_claim_notification_send`'s return
  # type passed 18/18 here and went red there: `validate.sh` is documented as
  # "the same gates in the same order", and a gate missing from it is a green
  # local run that CI refuses. Second instance — `db-push-check.sh` was the
  # first, added as 7b one PR ago. It namespaces and tears down its own
  # fixtures, and refuses to start on leftovers.
  run "8b. concurrency suite" supabase/tests/concurrency.sh

  # 8c needs BOTH a database and deno, which is why it is its own script: the
  # push-service allowlist exists in a migration AND in an edge library, and
  # no single test runner here can ask both of them the same question. They
  # disagreed on two inputs the day they were written.
  if have deno; then
    run "8c. push endpoint parity" scripts/check-push-endpoint-parity.sh
  else
    skip_gate "8c. push endpoint parity" "deno is not installed"
  fi
else
  skip_gate "7-8. database" "LOCAL_DB_URL is unset or psql is missing — docs/dev/local-stack.md"
fi

# ── 9. Migrations are append-only (invariant 6) ───────────────────────────
# CI is blind to this on its own: `db reset` replays every migration from
# scratch, so an edited migration produces a fully green run while `db push`
# skips it entirely in staging and production.
append_only() {
  git fetch -q origin main 2>/dev/null || { echo "cannot reach origin/main"; return 1; }
  local changed
  changed=$(git diff --name-status origin/main... -- supabase/migrations/ | grep -v '^A' || true)
  [ -z "$changed" ] && return 0
  echo "an existing migration was modified:"; echo "$changed"; return 1
}
run "9. append-only migrations" append_only

# ── 10. Generated artefacts are not stale ─────────────────────────────────
definer_catalog() {
  python3 scripts/gen-definer-catalog.py && git diff --exit-code -- docs/spec/03-security-model.md
}
run "10a. definer catalogue" definer_catalog

if [ -n "${LOCAL_DB_URL:-}" ]; then
  # Queries the LIVE schema, so it needs gate 7's stack up.
  run "10b. generated types" bash -c \
    'python3 scripts/gen-types.py && git diff --exit-code -- app/src/lib/types.ts'
else
  skip_gate "10b. generated types" "needs LOCAL_DB_URL (reads the live schema)"
fi

run "10c. workflow gating" python3 scripts/verify-workflows.py

# 10d. CLAUDE.md states the migration and edge-function counts in prose, and
# its own note used to say "nothing enforces these two counts". They went
# stale a third time at 0051. A fresh session reads that paragraph as fact.
run "10d. status counters" python3 scripts/check-status-counters.py

# 10e. Spec 01's enum block was a hand list under a heading saying "migration
# 0001", missing `disputed`, `card_saved` and four whole enums by 0049. Same
# shape as 10a: reads the migrations only, so it always runs.
enum_catalog() {
  python3 scripts/gen-enum-catalog.py && git diff --exit-code -- docs/spec/01-data-model.md
}
run "10e. enum catalogue" enum_catalog

# ── 11. Secret-leak grep ──────────────────────────────────────────────────
no_secret_literals() {
  local hits
  hits=$(grep -RInE "(VAULT_MASTER_KEY|SERVICE_ROLE|sk_live|sk_test)" \
           app/src supabase/functions --include='*.ts' --include='*.tsx' \
         | grep -v 'Deno.env.get' | grep -v 'env.ts' || true)
  [ -z "$hits" ] && return 0
  echo "$hits"; return 1
}
run "11. no secret literals" no_secret_literals

# ── 12. Every var(--x) names a property something defines ─────────────────
# An undefined custom property makes the WHOLE declaration invalid and the
# element silently inherits, so the failure is a layout that looks subtly wrong
# rather than an error anyone sees.
run "12. css tokens defined" python3 - <<'PY'
import re, pathlib, sys
defined, used = set(), {}
for f in pathlib.Path('app/src').rglob('*.css'):
    t = re.sub(r'/\*.*?\*/', '', f.read_text(), flags=re.S)
    for m in re.finditer(r'(--[A-Za-z0-9_-]+)\s*:', t): defined.add(m.group(1))
    for m in re.finditer(r'var\(\s*(--[A-Za-z0-9_-]+)', t): used.setdefault(m.group(1), str(f))
missing = sorted((k, v) for k, v in used.items() if k not in defined)
for k, v in missing: print(f"{k} is used but never defined ({v})")
sys.exit(1 if missing else 0)
PY

# ── Summary ───────────────────────────────────────────────────────────────
printf '\n\033[1m── summary ─────────────────────────────────────────\033[0m\n'
printf '\033[32m%d passed\033[0m' "${#pass[@]}"
[ "${#skip[@]}" -gt 0 ] && printf '  \033[33m%d skipped\033[0m' "${#skip[@]}"
[ "${#fail[@]}" -gt 0 ] && printf '  \033[31m%d failed\033[0m' "${#fail[@]}"
printf '\n'
for s in "${skip[@]:-}"; do [ -n "$s" ] && printf '  \033[33mSKIP\033[0m %s\n' "$s"; done
for f in "${fail[@]:-}"; do [ -n "$f" ] && printf '  \033[31mFAIL\033[0m %s\n' "$f"; done

# A skipped gate is not a pass. Exit 0 so a partial local environment is
# usable, but say plainly that CI will run what was skipped here.
if [ "${#fail[@]}" -gt 0 ]; then
  echo; echo "CI runs every gate above. Fix the failures before pushing."
  exit 1
fi
if [ "${#skip[@]}" -gt 0 ]; then
  echo; echo "Gates were skipped. CI runs all of them, so green here is not green there."
fi
