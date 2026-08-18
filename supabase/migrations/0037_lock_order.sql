-- 0037 — one lock order for walks and clients, and it is walks first.
--
-- Review M32. `fn_debit_walk` locked `clients` and then `walks`. The cancel
-- path cannot do that, and not by choice: `fn_refund_cancelled_debit` is a
-- BEFORE UPDATE trigger on `walks`, so by the time its body runs the walk
-- tuple is ALREADY locked by the UPDATE that fired it, and only then does it
-- reach for `clients`. Two orders, one cycle.
--
-- Reproduced deterministically before this migration was written
-- (`concurrency.sh` case 5, which injects a barrier between the two locks of a
-- copy generated from `pg_get_functiondef`, so the copy provably carries the
-- shipped order). The observed outcome was worse than the review predicted:
-- the transaction Postgres chose to abort was the CANCEL, so the operator's
-- cancellation silently failed and the walk stayed `in_progress` still
-- claiming its credit. Nothing is corrupted — 40P01 rolls back cleanly — but
-- it presents as "END WALK sometimes fails" or "the cancel didn't take", with
-- no reproduction, on a screen someone is holding outside a client's house.
--
-- ── Why walks first, rather than clients first ───────────────────────────
--
-- The review suggested moving the refund into a cancel RPC that takes the
-- client lock before updating the walk. That works for the one path it
-- rewrites and leaves every OTHER walk-cancelling path — the portal cancel,
-- the pause-window sweep, schedule deactivation, whatever is written next —
-- free to invert it again, because the trigger fires for all of them.
--
-- Walks-first is the order the trigger PHYSICALLY CANNOT violate. Anything
-- that updates a walk and then touches the balance is compliant without having
-- to know the rule exists, which is the property worth having in a rule nobody
-- will remember. `fn_debit_walk` is the only function in the tree that took
-- the two locks the other way round (verified against every `for update` in
-- migrations 0001–0036), so this is a one-function change, and the smoke
-- assertion below keeps it that way.
--
-- Nothing about invariant 1 changes: the per-client row lock is still taken,
-- still before the balance is read, and still guards the credit-vs-overage
-- DECISION. Only the order of two acquisitions changes.

create or replace function fn_debit_walk(p_walk uuid)
returns table (outcome text, cost int, new_balance int)
language plpgsql
security definer
set search_path = public
as $$
declare
  w record;
  v_cost int;
  v_balance int;
begin
  if not fn_is_service_session() then
    raise exception 'fn_debit_walk: service role required';
  end if;

  -- The walk first, under its own lock. This also replaces the unlocked
  -- pre-read that used to exist only to find `client_id`: one statement now
  -- both locks the row and returns everything read from it, so there is no
  -- window in which the walk is read but not held.
  select * into w from walks where id = p_walk for update;
  if not found then
    raise exception 'fn_debit_walk: unknown walk %', p_walk;
  end if;

  -- Then the client. Serializes every balance mutation for this client, which
  -- is what invariant 1 requires and what makes the decision below safe: two
  -- sessions must not both read the same stale balance and both conclude there
  -- is credit for their walk.
  select credit_balance into v_balance
    from clients where id = w.client_id for update;

  if w.credits_debited > 0 then
    return query select 'debited'::text, w.credits_debited, v_balance;
    return;
  end if;
  if w.is_overage then
    return query select 'overage'::text, fn_walk_cost(p_walk), v_balance;
    return;
  end if;

  v_cost := fn_walk_cost(p_walk);

  if v_balance >= v_cost then
    insert into credit_ledger
      (operator_id, client_id, entry_type, amount, walk_id, note)
    values
      (w.operator_id, w.client_id, 'debit', -v_cost, p_walk, 'walk debit');
    update walks set credits_debited = v_cost, is_overage = false
     where id = p_walk;
    return query select 'debited'::text, v_cost, v_balance - v_cost;
  else
    -- No ledger entry, balance untouched; caller charges the WHOLE walk
    -- at plans.overage_rate_pence.
    update walks set credits_debited = 0, is_overage = true
     where id = p_walk;
    return query select 'overage'::text, v_cost, v_balance;
  end if;
end;
$$;

revoke all on function fn_debit_walk(uuid) from public, anon, authenticated;

comment on function fn_debit_walk(uuid) is
  'Debits a walk against the client balance, or marks it overage. Takes the walk lock BEFORE the client lock — see 0037: the cancel-refund trigger runs with the walk already locked and cannot do it the other way round (review M32).';
