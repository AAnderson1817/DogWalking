#!/usr/bin/env bash
#
# The weekend-surcharge arithmetic exists THREE times, and this is what keeps
# the three ANSWERING THE SAME.
#
#   weekendWalkCost         (app/src/lib/walk-cost.ts)  what Booking quotes
#   fn_walk_cost            (0043, the live fallback)   what fn_debit_walk charges a row with no snapshot
#   fn_snapshot_walk_price  (0044, BEFORE INSERT)       what every new row is stamped with
#
# The trigger and the function are two copies of one expression in two
# migrations that nothing tied together; the TypeScript leaf is a third, in
# another runtime. Drift in any one is a client quoted a price the server does
# not take, on the screen that decides whether an off-session charge is
# disclosed at all (review H12).
#
# One case list (scripts/walk-cost-cases.txt), every implementation asked, the
# answers compared — check-push-endpoint-parity.sh's shape, plus a FOURTH
# comparison: trigger against function. For that comparison to mean anything
# the SQL side NULLS the snapshot before asking fn_walk_cost. The function
# coalesces the snapshot first, so without the null a sabotaged trigger reads
# as a function that agrees with it, and the function's own expression is tied
# to nothing. The trigger's answer is read BEFORE the null, the function's
# AFTER — that is the whole of the SQL side.
#
# Runs as the cluster's postgres role inside one `begin; … rollback;`: a
# scratch tenant, a service type and a walk per case, all gone at the end and
# none of them a lasting object. Needs a database AND deno, which is why it is
# its own script — no single test runner in this repository has both — and
# validate.sh skips it honestly, by name, when either is missing.
#
#   LOCAL_DB_URL=… bash scripts/check-walk-cost-parity.sh
set -euo pipefail

cd "$(dirname "$0")/.."
CASES="scripts/walk-cost-cases.txt"
: "${LOCAL_DB_URL:?LOCAL_DB_URL is required (see docs/dev/session-notes.md)}"

# The cases, tab-separated `expected credit_cost surcharge date`, comments and
# blank lines dropped.
mapfile -t rows < <(grep -vE '^\s*(#|$)' "$CASES")
if [ "${#rows[@]}" -eq 0 ]; then
  echo "FAIL: $CASES parsed to zero cases — a parser that sees nothing reports agreement" >&2
  exit 2
fi

# Every field is checked for shape before it goes anywhere near SQL. An
# unreadable case is refused by line, never skipped: a case that silently
# drops out is a case that is no longer checked.
values=""
for i in "${!rows[@]}"; do
  IFS=$'\t' read -r expected cost surcharge date <<< "${rows[$i]}"
  if ! [[ "${expected:-}" =~ ^[0-9]+$ && "${cost:-}" =~ ^[0-9]+$ \
       && "${surcharge:-}" =~ ^[0-9]+$ && "${date:-}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    echo "FAIL: unreadable case in $CASES: '${rows[$i]}' (want expected<TAB>credit_cost<TAB>surcharge<TAB>YYYY-MM-DD)" >&2
    exit 2
  fi
  values+="${values:+,}($((i + 1)), $cost, $surcharge, date '$date')"
done

sql_file="$(mktemp)"
trap 'rm -f "$sql_file"' EXIT

# ── the SQL side ──────────────────────────────────────────────────────────
# Scratch tenant under its own uuid namespace (8d…). Output is tagged lines,
# `trg|n|answer` and then `fn|n|answer`, each carrying its case number, so a
# missing or extra line is a count mismatch below rather than a misalignment.
OP='8d000000-0000-4000-8000-000000000001'
CL='8d000000-0000-4000-8000-000000000002'
PR='8d000000-0000-4000-8000-000000000003'
SVC="('8d000000-0000-4000-8001-' || lpad(n::text, 12, '0'))::uuid"
WALK="('8d000000-0000-4000-8002-' || lpad(n::text, 12, '0'))::uuid"
cat > "$sql_file" <<SQL
begin;
insert into auth.users (id, email) values ('$OP', 'walk-cost-parity@sanpo.test');
insert into operators (id, business_name, display_name, email)
  values ('$OP', 'Walk cost parity', 'Parity', 'walk-cost-parity@sanpo.test');
insert into clients (id, operator_id, full_name, status)
  values ('$CL', '$OP', 'Parity Client', 'active');
insert into properties (id, operator_id, client_id, label)
  values ('$PR', '$OP', '$CL', 'Home');

insert into service_types (id, operator_id, name, duration_minutes, credit_cost, weekend_surcharge_credits)
  select $SVC, '$OP', 'walk cost parity ' || n, 30, cc, sc
    from (values $values) c(n, cc, sc, d);

-- Fires fn_snapshot_walk_price.
insert into walks (id, operator_id, client_id, property_id, service_type_id,
                   scheduled_date, window_start, window_end, status, origin_date)
  select $WALK, '$OP', '$CL', '$PR', $SVC, d, '09:00', '10:00', 'scheduled', d
    from (values $values) c(n, cc, sc, d);

-- The trigger's answer: what the row was stamped with.
select 'trg', n, w.cost_credits
  from (values $values) c(n, cc, sc, d)
  join walks w on w.id = $WALK
 order by n;

-- Null the snapshot so fn_walk_cost has to COMPUTE (see the header).
update walks set cost_credits = null where operator_id = '$OP';

-- The function's answer: its own live expression.
select 'fn', n, fn_walk_cost($WALK)
  from (values $values) c(n, cc, sc, d)
 order by n;
rollback;
SQL

# Counted by hand rather than via `${#trg[@]}`: under `set -u` bash 5.2 reports
# an EMPTY associative array as unbound, so a database that answered nothing
# killed this script with "trg: unbound variable" instead of the count
# sentence below — a gate dying for a reason other than the one it names.
declare -A trg fn
n_trg=0; n_fn=0
while IFS='|' read -r tag n answer; do
  case "$tag" in
    trg) trg[$n]=$answer; n_trg=$((n_trg + 1)) ;;
    fn)  fn[$n]=$answer;  n_fn=$((n_fn + 1)) ;;
    *)   echo "FAIL: unexpected SQL output line: '$tag|$n|$answer'" >&2; exit 2 ;;
  esac
done < <(psql "$LOCAL_DB_URL" -Atq -v ON_ERROR_STOP=1 -f "$sql_file")

# ── the TypeScript side ───────────────────────────────────────────────────
mapfile -t ts_answers < <(deno run --allow-read=. scripts/walk-cost-answers.ts "$CASES")

# ── compare ───────────────────────────────────────────────────────────────
# Four ways to be wrong, and all four are reported: the trigger disagrees with
# the function, the function disagrees with TypeScript, or all three agree
# with each other and not with the expectation. A case list that has drifted
# away from EVERY implementation would otherwise pass the first three.
if [ "$n_trg" -ne "${#rows[@]}" ] || [ "$n_fn" -ne "${#rows[@]}" ] \
   || [ "${#ts_answers[@]}" -ne "${#rows[@]}" ]; then
  echo "FAIL: ${#rows[@]} cases, $n_trg trigger answers, $n_fn function answers, ${#ts_answers[@]} TS answers" >&2
  exit 2
fi

bad=0
for i in "${!rows[@]}"; do
  n=$((i + 1))
  IFS=$'\t' read -r expected cost surcharge date <<< "${rows[$i]}"
  label="cost=$cost surcharge=$surcharge $date"
  g="${trg[$n]:-}"; f="${fn[$n]:-}"; t="${ts_answers[$i]}"
  wrong=0
  if [ "$g" != "$f" ]; then
    echo "TRG≠FN    trigger=$g fn=$f  $label" >&2
    wrong=1
  fi
  if [ "$f" != "$t" ]; then
    echo "DISAGREE  sql=$f ts=$t  $label" >&2
    wrong=1
  fi
  if [ "$wrong" = 0 ] && [ "$f" != "$expected" ]; then
    echo "WRONG     expected=$expected all=$f  $label" >&2
    wrong=1
  fi
  bad=$((bad + wrong))
done

if [ "$bad" -gt 0 ]; then
  echo "" >&2
  echo "FAIL: $bad of ${#rows[@]} walk cost cases" >&2
  exit 1
fi
echo "WALK COST PARITY PASS — ${#rows[@]} cases, three implementations agree"
