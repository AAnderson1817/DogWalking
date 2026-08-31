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
    -- Codex review on PR #85, ninth round. Cases 7, 8 and 8b commit push rows,
    -- and without this a run that dies mid-case leaves them behind. The
    -- reviewer expected the operator delete to REFUSE on the ON DELETE
    -- RESTRICT foreign key, but session_replication_role = replica above
    -- disables FK triggers, so it succeeds silently and orphans them.
    -- Measured, not assumed. That is worse: endpoint is UNIQUE, so the next
    -- run's seed insert dies on uq_push_subscriptions_endpoint and the suite
    -- cannot start at all -- cleanup as a PRECONDITION, the failure
    -- ops(smoke-identity) already paid for once.
    --
    -- No backticks anywhere in this comment: it sits inside a double-quoted
    -- shell string, where they are command substitution. That is the
    -- ops(deploy-retry) trap and this is its third recorded instance.
    delete from push_subscriptions where operator_id::text like '${NS}%';
    drop function if exists fn_debit_walk_barrier(uuid);
    drop function if exists fn_invite_signup_allow_attempt_barrier(uuid, inet, int, int);
    drop function if exists fn_register_push_subscription_barrier(text, text, text, text);
    delete from invite_signup_attempts where client_id in
      (select id from clients where operator_id::text like '${NS}%');
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

# Cleanup is HOUSEKEEPING, but the run cannot start on top of its leftovers, so
# say so here rather than letting it surface later as something unrecognisable.
# Codex review on PR #85: without the push delete above, a run that died
# mid-case left rows whose `endpoint` is UNIQUE, and the next run's seed insert
# failed with `uq_push_subscriptions_endpoint` — a message that says nothing
# about the previous run. Same shape as the collision ops(smoke-identity)
# spent four rounds diagnosing.
LEFTOVERS="$(psql "$DB" -At -c "
  select coalesce(sum(n), 0) from (
    select count(*) n from push_subscriptions where operator_id::text like '${NS}%'
    union all select count(*) from clients   where operator_id::text like '${NS}%'
    union all select count(*) from operators where id::text like '${NS}%'
  ) t")"
if [ "$LEFTOVERS" != "0" ]; then
  echo "FAIL: the ${NS} namespace still holds $LEFTOVERS row(s) after cleanup." >&2
  echo "      A previous run's fixtures survived db_cleanup — fix that rather" >&2
  echo "      than deleting them by hand, or the next run hits it too." >&2
  exit 1
fi

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
insert into clients (id, operator_id, full_name, status, invite_token)
  values ('${NS}-000000000101', '${NS}-000000000001', 'CC Invitee', 'invited',
          '${NS}-000000000901');
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
  ('${NS}-000000000304'::uuid, '15:00', '16:00'),
  ('${NS}-000000000305'::uuid, '17:00', '18:00')
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
# A needle containing a quote breaks the SQL, `q` then prints nothing, and the
# old `!= "0"` test read that empty string as "blocked" — so the precondition
# passed VACUOUSLY, in every case, without ever looking at pg_stat_activity.
# Found while adding case 5. The count must be a number and it must be > 0.
wait_until_blocked() {
  local needle="$1" i n
  case "$needle" in *"'"*) echo "bad needle (contains a quote)"; return;; esac
  for i in $(seq 1 100); do
    n="$(q "select count(*) from pg_stat_activity
             where state = 'active' and wait_event_type = 'Lock'
               and query like '%${needle}%'")"
    case "$n" in
      ''|*[!0-9]*) echo "probe failed"; return;;
    esac
    if [ "$n" -gt 0 ]; then echo blocked; return; fi
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

# ── Case 5: the lock-order inversion between debit and cancel-refund ──────
#
# Review M32. `fn_debit_walk` locked `clients` and then `walks`. The cancel
# path cannot do that: a BEFORE UPDATE trigger on `walks` runs with the walk
# tuple ALREADY locked by the UPDATE that fired it, and
# `fn_refund_cancelled_debit` then reaches for `clients`. Two orders, one
# cycle — an already-debited walk cancelled while a retry of complete-walk is
# between `fn_debit_walk`'s two lock statements.
#
# The outcome is a detected 40P01 abort rather than corruption, which is
# exactly why it needs a test: it surfaces as END WALK failing occasionally
# with no reproduction, on a screen the operator is standing outside a house
# holding.
#
# ── Why this is not timing-based ─────────────────────────────────────────
#
# The race needs an interleave INSIDE `fn_debit_walk`, between its two locks,
# and the harness cannot interleave a single RPC. So the function is copied
# with a BARRIER injected between them — and copied from
# `pg_get_functiondef`, not hand-written, so the copy provably carries the
# shipped lock order and cannot drift from it. The anchor is the first
# `for update;`, which means "after the first lock" whichever table that is,
# so this same test exercises both the old order and the new one.
#
# The barrier is an advisory lock held by session A, not a sleep. A sleep too
# short reports "no deadlock" — a FALSE PASS, the worst direction. Note that
# the advisory lock gates ONE session only; it never stands between the two
# contending sessions, so it cannot serialise them the way the discarded first
# draft of this file did.
echo
echo "== case 5: cancel-refund racing a debit retry on the same walk =="

# An in-progress walk that has already been debited: the only state
# `fn_refund_cancelled_debit` acts on.
psql "$DB" -v ON_ERROR_STOP=1 -q -c "
  update walks set status = 'in_progress', credits_debited = 1
   where id = '${NS}-000000000305';"

psql "$DB" -v ON_ERROR_STOP=1 -q -c "
do \$outer\$
declare
  v_def text;
  v_at int;
begin
  select pg_get_functiondef('fn_debit_walk(uuid)'::regprocedure) into v_def;
  v_def := replace(v_def, 'FUNCTION public.fn_debit_walk(',
                          'FUNCTION public.fn_debit_walk_barrier(');
  v_at := position('for update;' in v_def) + length('for update;');
  if v_at <= length('for update;') then
    raise exception 'case 5: no lock statement found in fn_debit_walk';
  end if;
  v_def := left(v_def, v_at)
        || E'\n  perform pg_advisory_xact_lock(919);'
        || substr(v_def, v_at + 1);
  execute v_def;
end \$outer\$;"

# Session A holds the barrier shut.
echo "select pg_advisory_lock(919);" >&3
for _ in $(seq 1 50); do
  [ "$(q "select count(*) from pg_locks where locktype = 'advisory' and objid = 919 and granted")" != "0" ] && break
  sleep 0.1
done

# B is the complete-walk retry. It takes its FIRST lock and stops at the barrier.
psql "$DB" -q -v ON_ERROR_STOP=1 -c \
  "begin; select fn_debit_walk_barrier('${NS}-000000000305'); commit;" >"$WORK/b5.out" 2>&1 &
B5_PID=$!
expect_eq "the debit retry reached the barrier holding its first lock" \
  "$(wait_until_blocked fn_debit_walk_barrier)" "blocked"

# C is the operator cancelling that same walk. Its UPDATE locks the walk row,
# then the refund trigger reaches for the client.
psql "$DB" -q -v ON_ERROR_STOP=1 -c \
  "begin; update walks set status = 'cancelled' where id = '${NS}-000000000305'; commit;" \
  >"$WORK/c5.out" 2>&1 &
C5_PID=$!
expect_eq "the cancel genuinely contended with the debit retry" \
  "$(wait_until_blocked "update walks set status")" "blocked"

# Release the barrier: B now reaches for its second lock.
echo "select pg_advisory_unlock(919);" >&3

B5_RC=0; C5_RC=0
wait $B5_PID || B5_RC=$?
wait $C5_PID || C5_RC=$?

if [ "$B5_RC" != "0" ] || [ "$C5_RC" != "0" ]; then
  fail "neither the debit nor the cancel is aborted" \
       "$(grep -ih "deadlock\|ERROR" "$WORK/b5.out" "$WORK/c5.out" | head -3)"
else
  pass "neither the debit nor the cancel is aborted"
fi
if grep -qi "deadlock detected" "$WORK/b5.out" "$WORK/c5.out"; then
  fail "no deadlock was detected" "$(grep -ih "deadlock detected" "$WORK/b5.out" "$WORK/c5.out" | head -1)"
else
  pass "no deadlock was detected"
fi

# The refund still happened — a fix that made the two paths agree by removing
# the refund would satisfy every assertion above.
expect_eq "the cancelled walk's credit came back" \
  "$(q "select count(*) from credit_ledger
         where walk_id = '${NS}-000000000305' and entry_type = 'adjust' and amount > 0")" "1"
expect_eq "and the walk stops claiming it was paid for" \
  "$(q "select credits_debited from walks where id = '${NS}-000000000305'")" "0"

psql "$DB" -q -c "drop function if exists fn_debit_walk_barrier(uuid);" >/dev/null


# ── Case 6: a stale attempt landing after the invite was reissued ─────────
#
# Codex review on PR #84, second round. `fn_invite_signup_allow_attempt`
# resolves the token to a client BEFORE it serialises on the advisory lock,
# and the reset trigger takes no advisory lock — so a request that resolved
# the OLD token can sit in the queue while an operator rotates or purges the
# invite, and then insert against the client that still exists. Two harms:
# the reissued invite does not get the fresh budget the previous round's fix
# promised, and after a PURGE the row re-creates an `ip` for a client whose
# personal data was erased on request.
#
# Same apparatus as case 5, and for the same reason: the interleave is INSIDE
# one RPC, so the function is copied from `pg_get_functiondef` — never
# hand-written, so the copy provably carries the shipped logic — with a
# barrier injected at the point the finding names. The anchor is the first
# token lookup, which is a stable landmark in both the pre-fix body and the
# fixed one, so this same case exercises both.
echo
echo "== case 6: a stale attempt landing after the invite was reissued =="

# Spend some of the budget on the old token, so there is something for the
# reset to clear and the assertion cannot pass by there being nothing.
psql "$DB" -v ON_ERROR_STOP=1 -q -c "
  select fn_invite_signup_allow_attempt('${NS}-000000000901', '203.0.113.5')
    from generate_series(1, 4);" >/dev/null
expect_eq "the old token spent part of its budget (precondition)" \
  "$(q "select count(*) from invite_signup_attempts where client_id = '${NS}-000000000101'")" "4"

psql "$DB" -v ON_ERROR_STOP=1 -q -c "
do \$outer\$
declare
  v_def text;
  v_at int;
begin
  select pg_get_functiondef(
    'fn_invite_signup_allow_attempt(uuid, inet, int, int)'::regprocedure) into v_def;
  v_def := replace(v_def, 'FUNCTION public.fn_invite_signup_allow_attempt(',
                          'FUNCTION public.fn_invite_signup_allow_attempt_barrier(');
  v_at := position('where invite_token = p_token;' in v_def)
        + length('where invite_token = p_token;');
  if v_at <= length('where invite_token = p_token;') then
    raise exception 'case 6: no token lookup found in fn_invite_signup_allow_attempt';
  end if;
  v_def := left(v_def, v_at)
        || E'\n  perform pg_advisory_xact_lock(920);'
        || substr(v_def, v_at + 1);
  execute v_def;
end \$outer\$;"

# Session A holds the barrier shut.
echo "select pg_advisory_lock(920);" >&3
for _ in $(seq 1 50); do
  [ "$(q "select count(*) from pg_locks where locktype = 'advisory' and objid = 920 and granted")" != "0" ] && break
  sleep 0.1
done

# B is a claim-signup attempt bearing the OLD token. It resolves the client
# and stops before serialising.
psql "$DB" -q -v ON_ERROR_STOP=1 -c \
  "begin; select fn_invite_signup_allow_attempt_barrier('${NS}-000000000901', '203.0.113.6'); commit;" \
  >"$WORK/b6.out" 2>&1 &
B6_PID=$!
expect_eq "the attempt resolved the old token and reached the barrier" \
  "$(wait_until_blocked fn_invite_signup_allow_attempt_barrier)" "blocked"

# C is the operator reissuing the invite — the documented remedy for a burned
# budget. Its UPDATE fires the reset trigger.
psql "$DB" -q -v ON_ERROR_STOP=1 -c "
  set local request.jwt.claims = '{\"sub\":\"${NS}-000000000001\",\"role\":\"authenticated\"}';
  select fn_rotate_invite('${NS}-000000000101');" >"$WORK/c6.out" 2>&1
expect_eq "the reissue cleared the burned budget" \
  "$(q "select count(*) from invite_signup_attempts where client_id = '${NS}-000000000101'")" "0"

# Release the barrier: B now serialises and decides whether to record.
echo "select pg_advisory_unlock(920);" >&3
wait $B6_PID || true

# THE FINDING. A stale request must not spend the budget the reissue just
# handed to the real claimant — and on the purge path, which rotates the token
# the same way, must not re-create an `ip` row for an erased client.
expect_eq "the stale attempt did not refill the reissued invite's budget" \
  "$(q "select count(*) from invite_signup_attempts where client_id = '${NS}-000000000101'")" "0"

# It is ALLOWED, not refused: the token no longer matches anything, so the
# caller goes on to the check and is told `not_found`, which is true.
expect_eq "and it was allowed through rather than rate-limited" \
  "$(grep -c ' t$\| t' "$WORK/b6.out" || true)" "1"

psql "$DB" -q -c "drop function if exists fn_invite_signup_allow_attempt_barrier(uuid, inet, int, int);" >/dev/null

# ── Case 6b: the row lock is real, and it does not deadlock ───────────────
#
# The fix for case 6 introduces a `clients` row lock into a function that
# previously took none, which is the change M32/0037 exists to guard. Both
# halves are demonstrated rather than asserted: that the lock actually blocks
# a rotation (the mechanism the fix rests on — a rotation is an ordinary
# UPDATE of a non-key column, so it takes the conflicting `for no key
# update`), and that the two orders cannot cycle. Lock order is advisory ->
# clients -> invite_signup_attempts here and clients -> invite_signup_attempts
# in the rotation, so both take clients first and no cycle exists; this is the
# demonstration of that.
echo
echo "== case 6b: the client row lock blocks a rotation, without deadlocking =="

CUR_TOKEN="$(q "select invite_token from clients where id = '${NS}-000000000101'")"

psql "$DB" -v ON_ERROR_STOP=1 -q -c "
do \$outer\$
declare
  v_def text;
  v_at int;
begin
  select pg_get_functiondef(
    'fn_invite_signup_allow_attempt(uuid, inet, int, int)'::regprocedure) into v_def;
  v_def := replace(v_def, 'FUNCTION public.fn_invite_signup_allow_attempt(',
                          'FUNCTION public.fn_invite_signup_allow_attempt_barrier(');
  -- Anchored on the re-check itself and then advanced to the END of that
  -- statement, so the injection point does not depend on WHICH lock mode is
  -- written there. That is deliberate: anchoring on the lock clause would
  -- make removing or weakening it abort this case instead of failing its
  -- assertion, and a missing lock is precisely what the assertion below is
  -- here to report.
  v_at := position('where id = v_client and invite_token = p_token' in v_def);
  if v_at = 0 then
    raise exception 'case 6b: no post-lock re-check found in fn_invite_signup_allow_attempt';
  end if;
  v_at := v_at + position(';' in substr(v_def, v_at)) - 1;
  v_def := left(v_def, v_at)
        || E'\n  perform pg_advisory_xact_lock(921);'
        || substr(v_def, v_at + 1);
  execute v_def;
end \$outer\$;"

echo "select pg_advisory_lock(921);" >&3
for _ in $(seq 1 50); do
  [ "$(q "select count(*) from pg_locks where locktype = 'advisory' and objid = 921 and granted")" != "0" ] && break
  sleep 0.1
done

# B holds the client row and stops.
psql "$DB" -q -v ON_ERROR_STOP=1 -c \
  "begin; select fn_invite_signup_allow_attempt_barrier('$CUR_TOKEN', '203.0.113.8'); commit;" \
  >"$WORK/b6b.out" 2>&1 &
B6B_PID=$!
expect_eq "the attempt reached the barrier holding the client row" \
  "$(wait_until_blocked fn_invite_signup_allow_attempt_barrier)" "blocked"

# C reissues. Its UPDATE must wait for that row.
psql "$DB" -q -v ON_ERROR_STOP=1 -c "
  set local request.jwt.claims = '{\"sub\":\"${NS}-000000000001\",\"role\":\"authenticated\"}';
  select fn_rotate_invite('${NS}-000000000101');" >"$WORK/c6b.out" 2>&1 &
C6B_PID=$!
expect_eq "the reissue genuinely blocked on it — the window case 6 exploited is shut" \
  "$(wait_until_blocked fn_rotate_invite)" "blocked"

echo "select pg_advisory_unlock(921);" >&3
B6B_RC=0; C6B_RC=0
wait $B6B_PID || B6B_RC=$?
wait $C6B_PID || C6B_RC=$?

if [ "$B6B_RC" != "0" ] || [ "$C6B_RC" != "0" ]; then
  fail "neither the attempt nor the reissue is aborted" \
       "$(grep -ih "deadlock\|ERROR" "$WORK/b6b.out" "$WORK/c6b.out" | head -3)"
else
  pass "neither the attempt nor the reissue is aborted"
fi
if grep -qi "deadlock detected" "$WORK/b6b.out" "$WORK/c6b.out"; then
  fail "no deadlock was detected" "$(grep -ih "deadlock detected" "$WORK/b6b.out" "$WORK/c6b.out" | head -1)"
else
  pass "no deadlock was detected"
fi

# The reissue ran second, so its trigger swept the row the attempt had just
# written: the new token starts clean even when an attempt was mid-flight.
expect_eq "the reissued invite still starts with a clean budget" \
  "$(q "select count(*) from invite_signup_attempts where client_id = '${NS}-000000000101'")" "0"

psql "$DB" -q -c "drop function if exists fn_invite_signup_allow_attempt_barrier(uuid, inet, int, int);" >/dev/null


# ── Case 7: the device quota under concurrent registration ───────────────
#
# Codex review on PR #85, fourth round. The quota is a count-then-delete, and
# under READ COMMITTED each transaction sees only the committed rows plus its
# own insert — so with the cap nearly reached, simultaneous calls each see a
# compliant count, each delete nothing, and all commit. The bound held only
# against a caller who registered one device at a time, which is not the
# caller it exists to bound.
#
# Two real backends, because that is the only place this is visible: a single
# transaction cannot observe its own isolation level.
echo
echo "== case 7: the per-recipient device quota holds under concurrency =="

# Real push-service hosts, because 0049 refuses anything else (Codex review
# on PR #85). These fixtures said `https://push.example/…` and the allowlist
# turned every registration below into an ERROR — which this case did not
# notice, because `total <= 10` is satisfied by the nine seeds alone. It
# reported "ok (got 9)" while proving nothing, in CI and locally alike. That
# is why the precondition below exists and is checked FIRST.
psql "$DB" -v ON_ERROR_STOP=1 -q -c "
  delete from push_subscriptions where operator_id = '${NS}-000000000001';
  insert into push_subscriptions (operator_id, client_id, endpoint, p256dh, auth)
  select '${NS}-000000000001', null, 'https://fcm.googleapis.com/fcm/send/seed-' || g,
         repeat('A', 87), repeat('B', 22)
    from generate_series(1, 9) g;"

# Ten simultaneous registrations of DISTINCT endpoints, all racing.
#
# Explicit PIDs, never a bare `wait`: session A is a psql held open on a FIFO
# and does not exit until `exec 3>&-` at the end of this file, so a bare
# `wait` blocks until the script is killed. Case 5 collects PIDs for the same
# reason; this one learned it the slow way.
RACE_PIDS=""
for i in $(seq 1 10); do
  psql "$DB" -q -v ON_ERROR_STOP=1 -c "
    set local request.jwt.claims = '{\"sub\":\"${NS}-000000000001\",\"role\":\"authenticated\"}';
    select fn_register_push_subscription(
      'https://fcm.googleapis.com/fcm/send/race-$i', repeat('C', 87), repeat('D', 22));" \
    >"$WORK/race$i.out" 2>&1 &
  RACE_PIDS="$RACE_PIDS $!"
done
for pid in $RACE_PIDS; do wait "$pid" || true; done

# PRECONDITION, not the detector: the ten registrations have to have actually
# HAPPENED. Without this, anything that makes them all fail — a refused
# endpoint, a shape check, a renamed function — leaves the nine seeds behind
# and `total <= 10` passes having exercised no quota, no lock and no race.
#
# Ten exactly, and that is deterministic rather than hopeful: each race
# registers a DISTINCT endpoint, the advisory lock serialises the
# read-modify-write, and every race row is newer than every seed, so a correct
# quota evicts all nine seeds and keeps all ten races.
RACE_NEW="$(q "select count(*) from push_subscriptions
                where operator_id = '${NS}-000000000001'
                  and endpoint like '%/race-%'")"
if [ "$RACE_NEW" = "10" ]; then
  pass "all ten concurrent registrations landed (precondition, not the detector)"
else
  fail "the race registered nothing to bound" \
       "expected 10 race rows, got $RACE_NEW — this case would otherwise pass on the seeds alone"
fi

RACE_TOTAL="$(q "select count(*) from push_subscriptions where operator_id = '${NS}-000000000001'")"
if [ "$RACE_TOTAL" -le 10 ]; then
  pass "the quota held under 10 concurrent registrations (got $RACE_TOTAL)"
else
  fail "the quota was bypassed by concurrency" "expected <= 10, got $RACE_TOTAL"
fi

psql "$DB" -q -c "delete from push_subscriptions where operator_id = '${NS}-000000000001';" >/dev/null

echo
echo "== case 8: a device registration racing the erasure of its own client =="

# Codex review on PR #85, eighth round. `fn_register_push_subscription`
# resolved the caller's client with `my_client_id()` and then read
# `clients.operator_id` UNLOCKED and without a `purged_at` predicate, so a
# registration that started before an erasure could insert its row after
# `fn_purge_client` had tombstoned the client and the 0049 trigger had deleted
# every device it knew about. The endpoint identifies a browser; a row bearing
# one surviving an erasure request is exactly what H5 exists to prevent.
#
# Not reachable sequentially: the purge NULLs `auth_user_id`, so afterwards
# `my_client_id()` returns null and the caller never reaches the client branch
# at all. Only an interleave gets there, which is why this needs the barrier.
psql "$DB" -v ON_ERROR_STOP=1 -q -c "
  insert into auth.users (id, email) values ('${NS}-000000000801', 'cc-erase@sanpo.test');
  insert into clients (id, operator_id, auth_user_id, full_name, status)
    values ('${NS}-000000000102', '${NS}-000000000001', '${NS}-000000000801', 'CC Erasee', 'active');
  insert into push_subscriptions (operator_id, client_id, endpoint, p256dh, auth)
    values ('${NS}-000000000001', '${NS}-000000000102',
            'https://fcm.googleapis.com/fcm/send/erase-seed', repeat('E', 87), repeat('F', 22));"

psql "$DB" -v ON_ERROR_STOP=1 -q -c "
do \$outer\$
declare
  v_def text;
  v_at  int;
  v_needle constant text := 'v_client := my_client_id();';
begin
  select pg_get_functiondef(
    'fn_register_push_subscription(text, text, text, text)'::regprocedure) into v_def;
  v_def := replace(v_def, 'FUNCTION public.fn_register_push_subscription(',
                          'FUNCTION public.fn_register_push_subscription_barrier(');
  v_at := position(v_needle in v_def) + length(v_needle);
  if v_at <= length(v_needle) then
    raise exception 'case 8: no client resolution found in fn_register_push_subscription';
  end if;
  v_def := left(v_def, v_at)
        || E'\n  perform pg_advisory_xact_lock(930);'
        || substr(v_def, v_at + 1);
  execute v_def;
end \$outer\$;"

# Session A holds the barrier shut.
echo "select pg_advisory_lock(930);" >&3
for _ in $(seq 1 50); do
  [ "$(q "select count(*) from pg_locks where locktype = 'advisory' and objid = 930 and granted")" != "0" ] && break
  sleep 0.1
done

# B is the client's own browser registering a device. It resolves its client
# id and stops before looking the client up.
psql "$DB" -q -v ON_ERROR_STOP=1 -c "
  begin;
  set local request.jwt.claims = '{\"sub\":\"${NS}-000000000801\",\"role\":\"authenticated\"}';
  select fn_register_push_subscription_barrier(
    'https://fcm.googleapis.com/fcm/send/erase-race', repeat('C', 87), repeat('D', 22));
  commit;" >"$WORK/b8.out" 2>&1 &
B8_PID=$!
expect_eq "the registration resolved its client and reached the barrier" \
  "$(wait_until_blocked fn_register_push_subscription_barrier)" "blocked"

# C is the operator honouring an erasure request.
psql "$DB" -q -v ON_ERROR_STOP=1 -c "
  set local request.jwt.claims = '{\"sub\":\"${NS}-000000000001\",\"role\":\"authenticated\"}';
  select * from fn_purge_client('${NS}-000000000102');" >"$WORK/c8.out" 2>&1
expect_eq "the purge deleted the device it knew about (precondition)" \
  "$(q "select count(*) from push_subscriptions where client_id = '${NS}-000000000102'")" "0"

# Release the barrier: B now looks its client up and decides.
echo "select pg_advisory_unlock(930);" >&3
wait $B8_PID || true

# THE FINDING. A device registered by a request that began before the erasure
# must not outlive it.
expect_eq "no device survived the erasure" \
  "$(q "select count(*) from push_subscriptions where client_id = '${NS}-000000000102'")" "0"

# And it is REFUSED rather than silently dropped, so the browser learns its
# subscription was not recorded instead of reporting notifications as on.
if grep -q "erased" "$WORK/b8.out"; then
  pass "the registration was refused, naming the erasure"
else
  fail "the registration did not name the erasure" "$(tail -2 "$WORK/b8.out")"
fi

psql "$DB" -q -c "drop function if exists fn_register_push_subscription_barrier(text, text, text, text);" >/dev/null

# ── Case 8b: the row lock is real, and it does not deadlock ───────────────
#
# Case 8 proves the OUTCOME, and it would still pass with only the
# `purged_at` predicate and no lock at all — the purge commits before the
# barrier releases there, so the predicate alone answers. The predicate alone
# is NOT the fix: a registration that reads the client while the purge is
# still in flight sees a live row and inserts. So the lock gets its own case.
#
# It is also the change M32/0037 exists to guard: a `clients` row lock added
# to a function that took none. Order is advisory -> clients ->
# push_subscriptions here, and walks -> clients -> everything in
# `fn_purge_client`, so both take clients before push_subscriptions and the
# purge never takes this advisory lock. This is the demonstration of that,
# rather than the assertion of it.
echo
echo "== case 8b: the client row lock blocks an erasure, without deadlocking =="

psql "$DB" -v ON_ERROR_STOP=1 -q -c "
  insert into auth.users (id, email) values ('${NS}-000000000802', 'cc-erase2@sanpo.test');
  insert into clients (id, operator_id, auth_user_id, full_name, status)
    values ('${NS}-000000000103', '${NS}-000000000001', '${NS}-000000000802', 'CC Erasee 2', 'active');"

psql "$DB" -v ON_ERROR_STOP=1 -q -c "
do \$outer\$
declare
  v_def text;
  v_at  int;
begin
  select pg_get_functiondef(
    'fn_register_push_subscription(text, text, text, text)'::regprocedure) into v_def;
  v_def := replace(v_def, 'FUNCTION public.fn_register_push_subscription(',
                          'FUNCTION public.fn_register_push_subscription_barrier(');
  -- Anchored on the ASSIGNMENT and advanced to the END of that statement, so
  -- the injection point depends on neither the lock mode nor the purged_at
  -- predicate. Anchoring on either would make removing it ABORT this case
  -- instead of failing its assertion, and removing them is exactly what the
  -- assertions below are here to report. Case 6b's comment says the same of
  -- its own anchor; this one was first written against the predicate and the
  -- sabotage caught it.
  --
  -- And no backticks: this is inside a double-quoted shell string, where they
  -- are command substitution (the ops(deploy-retry) trap).
  v_at := position('select operator_id into v_operator' in v_def);
  if v_at = 0 then
    raise exception 'case 8b: no client lookup found in fn_register_push_subscription';
  end if;
  v_at := v_at + position(';' in substr(v_def, v_at)) - 1;
  v_def := left(v_def, v_at)
        || E'\n  perform pg_advisory_xact_lock(931);'
        || substr(v_def, v_at + 1);
  execute v_def;
end \$outer\$;"

echo "select pg_advisory_lock(931);" >&3
for _ in $(seq 1 50); do
  [ "$(q "select count(*) from pg_locks where locktype = 'advisory' and objid = 931 and granted")" != "0" ] && break
  sleep 0.1
done

# B holds the client row and stops.
psql "$DB" -q -v ON_ERROR_STOP=1 -c "
  begin;
  set local request.jwt.claims = '{\"sub\":\"${NS}-000000000802\",\"role\":\"authenticated\"}';
  select fn_register_push_subscription_barrier(
    'https://fcm.googleapis.com/fcm/send/erase-race-2', repeat('C', 87), repeat('D', 22));
  commit;" >"$WORK/b8b.out" 2>&1 &
B8B_PID=$!
expect_eq "the registration reached the barrier holding the client row" \
  "$(wait_until_blocked fn_register_push_subscription_barrier)" "blocked"

# C erases. Its `for update` on that row must wait.
psql "$DB" -q -v ON_ERROR_STOP=1 -c "
  set local request.jwt.claims = '{\"sub\":\"${NS}-000000000001\",\"role\":\"authenticated\"}';
  select * from fn_purge_client('${NS}-000000000103');" >"$WORK/c8b.out" 2>&1 &
C8B_PID=$!
expect_eq "the erasure genuinely blocked on it — the window case 8 exploited is shut" \
  "$(wait_until_blocked fn_purge_client)" "blocked"

echo "select pg_advisory_unlock(931);" >&3
B8B_RC=0; C8B_RC=0
wait $B8B_PID || B8B_RC=$?
wait $C8B_PID || C8B_RC=$?

if [ "$B8B_RC" != "0" ] || [ "$C8B_RC" != "0" ]; then
  fail "neither the registration nor the erasure is aborted" \
       "$(grep -ih "deadlock\|ERROR" "$WORK/b8b.out" "$WORK/c8b.out" | head -3)"
else
  pass "neither the registration nor the erasure is aborted"
fi
if grep -qi "deadlock detected" "$WORK/b8b.out" "$WORK/c8b.out"; then
  fail "no deadlock was detected" "$(grep -ih "deadlock detected" "$WORK/b8b.out" "$WORK/c8b.out" | head -1)"
else
  pass "no deadlock was detected"
fi

# The erasure still wins: it runs after the registration commits, so the
# trigger deletes the device that registration just created.
expect_eq "the erasure still took the device the registration had just made" \
  "$(q "select count(*) from push_subscriptions where client_id = '${NS}-000000000103'")" "0"

psql "$DB" -q -c "drop function if exists fn_register_push_subscription_barrier(text, text, text, text);" >/dev/null

exec 3>&-
wait $A_PID 2>/dev/null || true

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "CONCURRENCY PASS"
else
  echo "CONCURRENCY FAIL: $FAILURES assertion(s)"
  exit 1
fi
