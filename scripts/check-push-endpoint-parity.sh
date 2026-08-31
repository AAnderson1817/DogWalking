#!/usr/bin/env bash
#
# The push-service allowlist exists twice, and this is what keeps the two
# halves ANSWERING THE SAME. Codex review on PR #85.
#
#   fn_is_push_service_endpoint   (0049)                refuses at registration
#   isPushServiceEndpoint         (_lib/webpush.ts)     refuses before the fetch
#
# Both are wanted — the first makes the failure a sentence somebody can act on,
# the second is what actually stops the request and covers any row that
# predates the rule. But they are written against different primitives, a POSIX
# regex and `URL`, and they disagreed on two inputs within an hour of being
# written: `URL` normalises an uppercase scheme and an explicit `:443` away,
# and the regex did not. Neither was a hole, because registration was the
# STRICTER side — but "one list, one rule" is the whole claim these two halves
# make together.
#
# `app/scripts/push-service-hosts.test.ts` compares the two LISTS, which is the
# thing that drifts when somebody adds a provider. This compares the two
# ANSWERS, which is the thing that drifts when somebody edits either parser.
#
# Needs both a database and deno, which is why it is its own script rather than
# a case in either suite: no single test runner in this repository has both.
#
#   LOCAL_DB_URL=… bash scripts/check-push-endpoint-parity.sh
set -euo pipefail

cd "$(dirname "$0")/.."
CASES="scripts/push-endpoint-cases.txt"
: "${LOCAL_DB_URL:?LOCAL_DB_URL is required (see docs/dev/session-notes.md)}"

# The cases, tab-separated, comments and blank lines dropped.
mapfile -t rows < <(grep -vE '^\s*(#|$)' "$CASES")
if [ "${#rows[@]}" -eq 0 ]; then
  echo "FAIL: $CASES parsed to zero cases — a parser that sees nothing reports agreement" >&2
  exit 2
fi

sql_file="$(mktemp)"
trap 'rm -f "$sql_file"' EXIT

# ── the SQL side ──────────────────────────────────────────────────────────
# One statement, one row per case, in file order. `format('%L')` would be
# neater but the values come from a file and psql's own quoting is what must
# survive them, so they go in as parameters of a VALUES list built here with
# single quotes doubled.
{
  echo "select fn_is_push_service_endpoint(e) from (values"
  first=1
  for row in "${rows[@]}"; do
    endpoint="${row#*$'\t'}"
    escaped="${endpoint//\'/\'\'}"
    if [ "$first" = 1 ]; then first=0; else printf ','; fi
    printf "('%s')" "$escaped"
  done
  echo ") v(e);"
} > "$sql_file"
mapfile -t sql_answers < <(psql "$LOCAL_DB_URL" -At -v ON_ERROR_STOP=1 -f "$sql_file")

# ── the TypeScript side ───────────────────────────────────────────────────
mapfile -t ts_answers < <(deno run --allow-read=. scripts/push-endpoint-answers.ts "$CASES")

# ── compare ───────────────────────────────────────────────────────────────
# Three ways to be wrong, and all three are reported: SQL disagrees with the
# expectation, TypeScript disagrees with it, or the two disagree with each
# other. The last is the one this script exists for, but a case list that has
# drifted away from BOTH implementations would otherwise pass it.
if [ "${#sql_answers[@]}" -ne "${#rows[@]}" ] || [ "${#ts_answers[@]}" -ne "${#rows[@]}" ]; then
  echo "FAIL: ${#rows[@]} cases, ${#sql_answers[@]} SQL answers, ${#ts_answers[@]} TS answers" >&2
  exit 2
fi

bad=0
for i in "${!rows[@]}"; do
  expected="${rows[$i]%%$'\t'*}"
  endpoint="${rows[$i]#*$'\t'}"
  s="${sql_answers[$i]}"
  t="${ts_answers[$i]}"
  if [ "$s" != "$t" ]; then
    echo "DISAGREE  sql=$s ts=$t  $endpoint" >&2
    bad=$((bad + 1))
  elif [ "$s" != "$expected" ]; then
    echo "WRONG     expected=$expected both=$s  $endpoint" >&2
    bad=$((bad + 1))
  fi
done

if [ "$bad" -gt 0 ]; then
  echo "" >&2
  echo "FAIL: $bad of ${#rows[@]} push endpoint cases" >&2
  exit 1
fi
echo "PUSH ENDPOINT PARITY PASS — ${#rows[@]} cases, both implementations agree"
