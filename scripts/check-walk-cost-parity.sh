#!/usr/bin/env bash
#
# The weekend-surcharge arithmetic exists THREE times, and this is what keeps
# the three ANSWERING THE SAME.
#
#   weekendWalkCost         (app/src/lib/walk-cost.ts)  what Booking quotes, through effectiveWalkCost
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
# answers compared three ways ACROSS implementations — trigger against
# function, function against TypeScript, and all of them against the
# expectation, since a case list that has drifted away from every
# implementation passes the first two — plus the TypeScript runs against each
# other (below), which is the loop's fourth check. The SQL
# side reads the trigger's stamp and then NULLS it before asking fn_walk_cost.
# Not to catch a trigger drift — the TypeScript comparison catches that with
# or without the null, and TRG≠FN is merely the line that names which SQL copy
# moved — but because the function COALESCES the snapshot first: with the stamp
# in place its answer is the trigger's, and its own expression, the figure
# fn_debit_walk charges a pre-0043 row, is tied to nothing. Its answers are
# read through a join on `cost_credits is null`, so a null that did not take
# yields no answers and the count sentence below, never a function echoing
# the trigger (review of PR 2: the first version guarded the null with
# nothing, and deleting it left a sabotaged fn_walk_cost green).
#
# The TypeScript side runs FOUR times and the runs must agree with each
# other and with SQL. Under Etc/GMT+12 and Etc/GMT-14 — fixed offsets, so no
# tzdata dependency; the POSIX sign is inverted, so those are twelve hours
# WEST and fourteen hours EAST of Greenwich, either side of the day boundary
# — because a leaf that reads the local day at a CONSTANT offset (`new
# Date(d).getDay()`, or noon plus `getDay()`) spans twenty-six hours across
# that pair, so one edge crosses the day and one run answers a day out,
# while in the caller's own zone — UTC in CI — such a leaf answers every
# case correctly, which is exactly what the first version of this gate ran
# (review of PR 2). And under America/Chicago, the business zone (spec 00),
# AND Australia/Sydney, because a fixed offset has no DST: a leaf whose
# error is DST-DEPENDENT — UTC midnight shifted by the offset in force NOW,
# the natural "make it right for my zone" mistake — passes both fixed-offset
# runs, and is wrong in a DST zone exactly when that zone is on DAYLIGHT
# time today and the row is dated in its STANDARD time: the shift is then an
# hour short of that day's local midnight, so the read lands on the day
# before, while the other way round it lands an hour into the same day. One
# DST zone therefore pins that leaf only during its own daylight season —
# the second pass of the review claimed the Chicago run alone did it, and
# for the five months Chicago is on standard time it pinned nothing (third
# pass). Measured with deno's own zone data: at Chicago's daylight offset the
# leaf misreads 2026-03-07 and 2027-01-02 and at its standard offset
# nothing; at Sydney's daylight offset it misreads 2026-07-04 and 2026-07-06
# and at its standard offset nothing (a Sunday read as Saturday is still a
# weekend, so only a Saturday or a Monday dated in standard time can show
# it). Sydney's daylight season is the complement of Chicago's — no day of
# 2026–2028 has both zones on standard time — so the pair pins the leaf on
# every day of the year, and the run ASSERTS that precondition instead of
# assuming it: if neither zone is on daylight time today it refuses by name,
# because a run that pins nothing must not print PASS. deno carries its own
# zone data, so neither run needs host tzdata. The answers script REQUIRES
# the zone it was told and refuses a runtime that did not honour TZ, so an
# environment that ignores it, or a shell edit that drops the argument,
# cannot pass silently either.
#
# Runs as the cluster's postgres role inside one `begin; … rollback;`: a
# scratch tenant, a service type and a walk per case, all gone at the end and
# none of them a lasting object. Any other role — a second superuser included,
# since a superuser bypasses RLS and not triggers — is refused BY NAME first,
# because the `walks` update guard admits only a service session or the walk's
# own operator through `auth.uid()`, a psql connection is neither, and the
# guard's own refusal would blame the walk's status. Needs a database AND deno, which is
# why it is its own script — no single test runner in this repository has
# both — and validate.sh skips it honestly, by name, when either is missing.
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
-- Refused by name before anything else: the walks update guard below admits
-- only a service session or the walk's own operator via auth.uid(), a psql
-- connection is neither, and the guard's own refusal would blame the walk's
-- status.
do \$\$ begin
  if not fn_is_service_session() then
    raise exception 'FAIL: gate 8d must connect as the postgres role (session_user is %) — the walks update guard refuses a psql connection that is neither a service session nor the walk''s operator', session_user;
  end if;
end \$\$;
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

-- The function's answer: its own live expression. Joined on the null having
-- TAKEN, so a dropped or mis-scoped update above yields no answers and the
-- count sentence, not a function echoing the trigger.
select 'fn', n, fn_walk_cost($WALK)
  from (values $values) c(n, cc, sc, d)
  join walks w on w.id = $WALK and w.cost_credits is null
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

# ── the daylight-season precondition ─────────────────────────────────────
# A DST-dependent leaf is caught by a DST zone only while that zone is on
# daylight time (see the header), so the run first reads which of its two
# zones is — today's offset against the larger of this year's January and
# July offsets; daylight time is the SMALLER `getTimezoneOffset()`, and a
# zone with no DST answers 0. Read, never assumed, and anything but a 0 or a
# 1 is the probe failing, reported as that rather than as a season.
daylight_today() {
  TZ="$1" deno eval 'const o = (d) => new Date(d).getTimezoneOffset(); const y = new Date().getUTCFullYear(); const std = Math.max(o(`${y}-01-15T12:00:00Z`), o(`${y}-07-15T12:00:00Z`)); console.log(o(Date.now()) < std ? 1 : 0);' 2>&1 || true
}
season=""
for zone in America/Chicago Australia/Sydney; do
  dl="$(daylight_today "$zone")"
  case "$dl" in
    0|1) season+="${season:+ }$zone=$dl" ;;
    *) echo "FAIL: could not read whether $zone is on daylight time today (the probe printed '${dl}')" >&2; exit 2 ;;
  esac
done
if [[ "$season" != *"=1"* ]]; then
  echo "FAIL: neither zone is on daylight time today ($season) — a DST-dependent leaf passes every run in this state, so this run would pin nothing about it; the two seasons were complementary when this was written, so read the zone data before believing either side" >&2
  exit 2
fi

# ── the TypeScript side ───────────────────────────────────────────────────
# Four times: either side of the day boundary at a fixed offset, and in two
# DST zones whose daylight seasons are complementary (see the header). The
# zone is passed as an argument as well as in TZ, so the script refuses a
# runtime that ignored it — and refuses to run with no zone at all, so
# dropping the argument here goes red by name; deno honours TZ without
# --allow-env.
ts_run() { TZ="$1" deno run --allow-read=. scripts/walk-cost-answers.ts "$CASES" "$1"; }
mapfile -t ts_west < <(ts_run Etc/GMT+12)
mapfile -t ts_east < <(ts_run Etc/GMT-14)
mapfile -t ts_chi < <(ts_run America/Chicago)
mapfile -t ts_syd < <(ts_run Australia/Sydney)

# ── compare ───────────────────────────────────────────────────────────────
# Four ways to be wrong, and all four are reported: the TypeScript runs
# disagree with each other (the leaf reads the local day, at a fixed offset
# or a DST-dependent one), the trigger disagrees with the function (which SQL
# copy moved), the function disagrees with TypeScript, or all of them agree
# with each other and not with the expectation. A case list that has drifted
# away from EVERY implementation would otherwise pass the first three.
if [ "$n_trg" -ne "${#rows[@]}" ] || [ "$n_fn" -ne "${#rows[@]}" ] \
   || [ "${#ts_west[@]}" -ne "${#rows[@]}" ] || [ "${#ts_east[@]}" -ne "${#rows[@]}" ] \
   || [ "${#ts_chi[@]}" -ne "${#rows[@]}" ] || [ "${#ts_syd[@]}" -ne "${#rows[@]}" ]; then
  echo "FAIL: ${#rows[@]} cases, $n_trg trigger answers, $n_fn function answers, ${#ts_west[@]} TS answers west of Greenwich, ${#ts_east[@]} east, ${#ts_chi[@]} in America/Chicago, ${#ts_syd[@]} in Australia/Sydney" >&2
  exit 2
fi

bad=0
for i in "${!rows[@]}"; do
  n=$((i + 1))
  IFS=$'\t' read -r expected cost surcharge date <<< "${rows[$i]}"
  label="cost=$cost surcharge=$surcharge $date"
  g="${trg[$n]:-}"; f="${fn[$n]:-}"; t="${ts_west[$i]}"; te="${ts_east[$i]}"; tc="${ts_chi[$i]}"; ty="${ts_syd[$i]}"
  wrong=0
  if [ "$t" != "$te" ] || [ "$t" != "$tc" ] || [ "$t" != "$ty" ]; then
    echo "TZ-DEPENDENT ts(UTC-12)=$t ts(UTC+14)=$te ts(Chicago)=$tc ts(Sydney)=$ty  $label" >&2
    wrong=1
  fi
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
echo "WALK COST PARITY PASS — ${#rows[@]} cases, three implementations agree, either side of the day boundary and in two DST zones ($season, daylight time is 1)"
