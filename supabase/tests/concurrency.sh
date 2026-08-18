#!/usr/bin/env bash
# Sanpo concurrency suite (review H20).
#
# Every other SQL test in this repository is a single `begin; … rollback;`, so
# no two backends ever contend and `SELECT … FOR UPDATE` is never exercised AS
# A LOCK. The debit tests prove sequential idempotency and the
# either-credit-or-overage invariant; neither can fail if the `for update` is
# deleted. Invariant 1 — "credit balance mutations happen ONLY inside SECURITY
# DEFINER functions that take a per-client row lock" — therefore had no test
# that could falsify its second half.
#
# The only backstop was `check (credit_balance >= 0)`, which turns a lost
# update into a constraint error at the moment of billing rather than
# preventing one. A lost update in the other direction — two grants, the second
# overwriting the first — trips no constraint at all: the client silently loses
# credits they paid for.
#
# ── How this tests the lock, and why not the obvious way ──────────────────
#
# The obvious harness launches two backends at once and hopes to observe a lost
# update. That is probabilistic, so it is flaky when the bug IS present, which
# is the worst possible direction for a test to be unreliable in.
#
# The first draft of this file was worse than that: it used
# `pg_advisory_xact_lock` in both sessions to make them contend. An advisory
# lock SERIALISES the two sessions itself, so deleting `for update` from
# `fn_debit_walk` would have left every assertion green — a test that cannot
# fail when the mechanism it exists for is removed, which is precisely the
# defect H20 is about.
#
# So the two sessions are made to overlap DETERMINISTICALLY. Session A calls
# the function and holds its transaction open; session B then calls it, and the
# harness waits until B is genuinely waiting — observed in `pg_stat_activity` as
# `wait_event_type = 'Lock'` — before letting A commit.
#
# That wait is a PRECONDITION, not the detector, and the distinction matters.
# It still passes with `for update` deleted, because the balance UPDATE inside
# `fn_ledger_apply` serialises the two sessions on its own. What it buys is the
# guarantee that B really did read its state while A held the row — without it,
# B might simply run after A finished and every outcome assertion below would
# pass for no reason. The detectors are the outcome assertions, and case 1
# explains which ones and why.
#
# It needs a database it can COMMIT to and two live sessions, which is why this
# is a bash harness and not another .sql file.
#
# Run: LOCAL_DB_URL=… ./supabase/tests/concurrency.sh
set -euo pipefail

DB="${LOCAL_DB_URL:-postgresql://postgres@127.0.0.1:54322/postgres}"
FAILURES=0
NS="cc000000-0000-4000-a000"
WORK="$(mktemp -d)"

q() { psql "$DB" -v ON_ERROR_STOP=1 -t -A -q -c "$1"; }

pass() { echo "  ok   $1"; }
fail() { echo "  FAIL $1"; echo "       $2"; FAILURES=$((FAILURES + 1)); }
expect_eq() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected $3, got $2"; fi
}

# NOTE: no `exec 3>&- 2>/dev/null` here. `exec` with redirections and no
# command applies them to the SHELL, permanently — the first version of this
# silenced every subsequent stderr write, including `set -x` output, so a
# failing run printed absolutely nothing. Session A's fd is closed at the end
# of the run instead.
# Every FK into these tables is ON DELETE RESTRICT, so the order matters and a
# missing child aborts the whole batch. It is one statement list on purpose —
# and it is NOT silenced, because the first version swallowed its own failure:
# `notifications` was missing (fn_debit_walk raises low_credit rows, which
# reference both the walk and the client), so nothing was ever deleted and the
# next run died on a duplicate key from fixtures it believed it had cleared.
db_cleanup() {
  psql "$DB" -v ON_ERROR_STOP=1 -q -c "
    -- credit_ledger carries an append-only block trigger, by design, so a
    -- suite that COMMITS ledger rows cannot delete them as an ordinary caller.
    -- replica role disables user triggers (and FK checks) for this session
    -- only. The harness owns this database; the trigger it is stepping around
    -- is the one whose correctness smoke.sql asserts separately.
    set session_replication_role = replica;
    delete from notifications where operator_id::text like '${NS}%';
    delete from credit_ledger where operator_id::text like '${NS}%';
    delete from payments where operator_id::text like '${NS}%';
    delete from plan_change_intents where operator_id::text like '${NS}%';
    delete from credential_access_log where operator_id::text like '${NS}%';
    delete from access_credentials where operator_id::text like '${NS}%';
    delete from schedule_pets where operator_id::text like '${NS}%';
    delete from recurring_schedules where operator_id::text like '${NS}%';
    delete from walks where operator_id::text like '${NS}%';
    delete from pets where operator_id::text like '${NS}%';
    delete from properties where operator_id::text like '${NS}%';
    delete from clients where operator_id::text like '${NS}%';
    delete from service_types where operator_id::text like '${NS}%';
    delete from plans where operator_id::text like '${NS}%';
    delete from operators where id::text like '${NS}%';
    delete from auth.users where id::text like '${NS}%';
  " || { echo "FAIL: could not clear the ${NS} fixture namespace" >&2; exit 1; }
}
# Separate from the workdir teardown on purpose: the pre-run call below is
# there to clear a previous failed run's fixtures, and a combined function
# deleted the temp directory it had just created, so `mkfifo` then failed.
cleanup() { db_cleanup; rm -rf "$WORK"; }
trap cleanup EXIT
db_cleanup

# ── Fixtures ──────────────────────────────────────────────────────────────
# Committed, not rolled back: the whole point is that a second backend can see
# them. Namespaced and torn down by the trap, so a failed run leaves nothing.
psql "$DB" -v ON_ERROR_STOP=1 -q <<SQL
insert into auth.users (id, email) values ('${NS}-000000000001', 'cc-op@sanpo.dev');
insert into operators (id, business_name, display_name, email)
  values ('${NS}-000000000001', 'CC Walks', 'CC', 'cc-op@sanpo.dev');
insert into plans (id, operator_id, name, credits_per_cycle, price_pence, cycle,
                   rollover_policy, overage_rate_pence)
  values ('${NS}-000000000010', '${NS}-000000000001', 'CC Plan', 10, 5000, 'monthly', 'none', 1800);
insert into service_types (id, operator_id, name, duration_minutes, credit_cost)
  values ('${NS}-000000000020', '${NS}-000000000001', 'CC Walk', 30, 1);
insert into clients (id, operator_id, full_name, email, plan_id, credit_balance, status)
  values ('${NS}-000000000100', '${NS}-000000000001', 'CC Client', 'cc-client@sanpo.dev',
          '${NS}-000000000010', 1, 'active');
insert into properties (id, operator_id, client_id, label, address_line1, city, postcode)
  values ('${NS}-000000000200', '${NS}-000000000001', '${NS}-000000000100',
          'Home', '1 CC St', 'Chicago', '60601');
insert into walks (id, operator_id, client_id, property_id, service_type_id,
                   scheduled_date, origin_date, window_start, window_end, status)
select v.id, '${NS}-000000000001', '${NS}-000000000100', '${NS}-000000000200',
       '${NS}-000000000020', current_date, current_date, v.s::time, v.e::time, 'scheduled'
from (values
  ('${NS}-000000000301'::uuid, '09:00', '10:00'),
  ('${NS}-000000000302'::uuid, '11:00', '12:00'),
  ('${NS}-000000000303'::uuid, '13:00', '14:00'),
  ('${NS}-000000000304'::uuid, '15:00', '16:00')
) as v(id, s, e);
SQL
echo "== concurrency: fixtures committed =="

# ── Session A: a psql held open on a FIFO so statements can be fed to it ──
mkfifo "$WORK/a"
psql "$DB" -q -v ON_ERROR_STOP=1 <"$WORK/a" >"$WORK/a.out" 2>&1 &
A_PID=$!
exec 3>"$WORK/a"

# Wait until B's statement is actually waiting on a lock. Polls rather than
# sleeping a fixed time: a fixed sleep is a race with the machine, and on a
# slow runner it would report "not blocked" for a lock that is working.
wait_until_blocked() {
  local needle="$1" i
  for i in $(seq 1 100); do
    if [ "$(q "select count(*) from pg_stat_activity
                where state = 'active' and wait_event_type = 'Lock'
                  and query like '%${needle}%'")" != "0" ]; then
      echo blocked; return
    fi
    sleep 0.1
  done
  echo "not blocked"
}

# ── Case 1: the lock protects the credit-vs-overage DECISION ──────────────
#
# This is the case that actually falsifies the `for update`, and it took two
# wrong attempts to find. The obvious one — two debits against a balance of 10,
# assert the balance fell by 2 — passes with the lock REMOVED, because
# `fn_ledger_apply` writes `credit_balance = credit_balance + amount`, a
# read-modify-write inside a single UPDATE, which Postgres already makes safe:
# the second session re-reads the row after acquiring the write lock. The
# arithmetic was never the exposure.
#
# What `for update` protects is the DECISION taken before that write:
#
#     if v_balance >= v_cost then debit else overage
#
# `v_balance` is read first. Without the lock, two sessions read the same stale
# balance and both conclude "there is credit for this" — so at the boundary,
# one credit funds two walks. That breaks invariant 3 (a walk is either fully
# credit-funded or fully charged at the overage rate, never partially) and
# drives the balance under `check (credit_balance >= 0)`, which turns a silent
# billing error into a 500 at END WALK.
#
# So the fixture is a balance of exactly 1 against two walks costing 1 each.
# With the lock: one debits, the other correctly falls to overage. Without it:
# both debit, and the second write violates the check.
echo
echo "== case 1: one credit, two walks, two backends =="
echo "begin; select fn_debit_walk('${NS}-000000000301');" >&3
for _ in $(seq 1 50); do
  [ "$(q "select count(*) from credit_ledger where walk_id = '${NS}-000000000301'")" != "0" ] && break
  sleep 0.1
done

psql "$DB" -q -v ON_ERROR_STOP=1 -c \
  "begin; select fn_debit_walk('${NS}-000000000302'); commit;" >"$WORK/b.out" 2>&1 &
B_PID=$!

expect_eq "B genuinely overlapped A (precondition, not the detector)" \
  "$(wait_until_blocked fn_debit_walk)" "blocked"

echo "commit;" >&3
if ! wait $B_PID; then
  fail "the second walk could not be billed at all" "$(cat "$WORK/b.out")"
fi

# The three assertions that go red together when the lock is gone.
expect_eq "one credit funded exactly one walk" \
  "$(q "select count(*) from credit_ledger where client_id = '${NS}-000000000100' and entry_type = 'debit'")" "1"
expect_eq "the second walk fell to overage, not to a second debit" \
  "$(q "select is_overage from walks where id = '${NS}-000000000302'")" "t"
expect_eq "the balance is spent, not negative" \
  "$(q "select credit_balance from clients where id = '${NS}-000000000100'")" "0"

# Top up for the cases below THROUGH the ledger. A bare
# `update clients set credit_balance = 8` breaks the balance_after chain that
# case 3 asserts on — caught by that assertion on the first run, which is the
# chain earning its place before it has been asked to catch anything real.
psql "$DB" -v ON_ERROR_STOP=1 -q -c \
  "select fn_adjust_credits('${NS}-000000000100', 8, 'cc fixture top-up');" >/dev/null

# ── Case 2: idempotency under contention, not in sequence ─────────────────
# The second session must see the first's COMMITTED credits_debited after the
# lock is released — not the row it read before blocking.
echo
echo "== case 2: the same walk debited by two sessions at once =="
echo "begin; select fn_debit_walk('${NS}-000000000303');" >&3
for _ in $(seq 1 50); do
  [ "$(q "select count(*) from credit_ledger where walk_id = '${NS}-000000000303'")" != "0" ] && break
  sleep 0.1
done

psql "$DB" -q -v ON_ERROR_STOP=1 -c "begin; select fn_debit_walk('${NS}-000000000303'); commit;" >"$WORK/b2.out" 2>&1 &
B_PID=$!
expect_eq "B genuinely overlapped A" \
  "$(wait_until_blocked fn_debit_walk)" "blocked"
echo "commit;" >&3
wait $B_PID || fail "session B (duplicate debit)" "$(cat "$WORK/b2.out")"

expect_eq "one walk, one debit row" \
  "$(q "select count(*) from credit_ledger where walk_id = '${NS}-000000000303'")" "1"
expect_eq "balance fell by exactly 1" \
  "$(q "select credit_balance from clients where id = '${NS}-000000000100'")" "7"

# ── Case 3: a debit racing an adjustment ──────────────────────────────────
# Different functions, same client row. Both must take the same lock, or one
# of the two writes disappears.
echo
echo "== case 3: fn_adjust_credits blocks behind fn_debit_walk =="
echo "begin; select fn_debit_walk('${NS}-000000000304');" >&3
for _ in $(seq 1 50); do
  [ "$(q "select count(*) from credit_ledger where walk_id = '${NS}-000000000304'")" != "0" ] && break
  sleep 0.1
done

psql "$DB" -q -v ON_ERROR_STOP=1 -c "begin; select fn_adjust_credits('${NS}-000000000100', 5, 'cc top-up'); commit;" \
  >"$WORK/b3.out" 2>&1 &
B_PID=$!
expect_eq "the adjustment genuinely overlapped the debit" \
  "$(wait_until_blocked fn_adjust_credits)" "blocked"
echo "commit;" >&3
wait $B_PID || fail "session B (adjust)" "$(cat "$WORK/b3.out")"

expect_eq "7, minus 1 debit, plus 5 adjust" \
  "$(q "select credit_balance from clients where id = '${NS}-000000000100'")" "11"
# The chain assertion is what actually detects a lost update: a clobbered write
# leaves a balance_after that no longer follows from the row before it, even
# where the final balance happens to look plausible.
expect_eq "every balance_after follows from the previous row" \
  "$(q "
    with chain as (
      select amount, balance_after, lag(balance_after) over (order by seq) as prev
        from credit_ledger where client_id = '${NS}-000000000100')
    select count(*) from chain where prev is not null and balance_after <> prev + amount")" "0"

# ── Case 4: two deliveries of one invoice ─────────────────────────────────
# Stripe redelivers invoice.paid for three days and two deliveries can land at
# once. Exactly one grant must result — asserted on the LEDGER, not the
# balance, because rollover 'none' wipes the balance before each grant, so the
# balance reads identically whether or not the second grant happened.
echo
echo "== case 4: two concurrent fn_apply_invoice_paid for one invoice =="
INV="in_cc_$(q "select floor(random() * 1000000)::int")"
echo "begin; select fn_apply_invoice_paid('${NS}-000000000100', 10, '${INV}', 5000, 'USD', null, true);" >&3
for _ in $(seq 1 50); do
  [ "$(q "select count(*) from payments where stripe_invoice_id = '${INV}'")" != "0" ] && break
  sleep 0.1
done

psql "$DB" -q -v ON_ERROR_STOP=1 -c "begin; select fn_apply_invoice_paid('${NS}-000000000100', 10, '${INV}', 5000, 'USD', null, true); commit;" \
  >"$WORK/b4.out" 2>&1 &
B_PID=$!
expect_eq "the redelivery genuinely overlapped the first delivery" \
  "$(wait_until_blocked fn_apply_invoice_paid)" "blocked"
echo "commit;" >&3
wait $B_PID || fail "session B (invoice redelivery)" "$(cat "$WORK/b4.out")"

expect_eq "one invoice, one cycle grant" \
  "$(q "select count(*) from credit_ledger
         where client_id = '${NS}-000000000100'
           and entry_type = 'grant' and stripe_invoice_id = '${INV}'")" "1"
expect_eq "one payments row for the invoice" \
  "$(q "select count(*) from payments where stripe_invoice_id = '${INV}'")" "1"

exec 3>&-
wait $A_PID 2>/dev/null || true

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "CONCURRENCY PASS"
else
  echo "CONCURRENCY FAIL: $FAILURES assertion(s)"
  exit 1
fi
