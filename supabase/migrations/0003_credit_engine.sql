-- 0003 — credit & billing engine (spec 02)
-- Single source of truth = credit_ledger; clients.credit_balance is a
-- denormalized running balance maintained exclusively by the ledger trigger
-- below, which fires only on inserts performed by the definer functions in
-- this file (authenticated/anon get no INSERT on credit_ledger — 0004).
-- Every mutating function serializes per client via SELECT … FOR UPDATE.

-- ── session helpers ──────────────────────────────────────────────────────
-- True when the call arrives with the service_role JWT (edge functions,
-- webhook, cron) or from a direct superuser session (migrations, seeds,
-- smoke tests). Inside SECURITY DEFINER bodies current_user is the function
-- owner, so the JWT claim / session_user are the reliable signals.
create function fn_is_service_session() returns boolean
language sql stable
set search_path = public
as $$
  select coalesce(auth.role() = 'service_role', false)
      or session_user = 'postgres'
$$;

-- ── ledger trigger: balance maintenance + auditable chain ────────────────
-- Computes balance_after from the current denormalized balance and applies
-- the delta, in the same transaction as the ledger insert. Callers hold the
-- per-client row lock; the UPDATE here would block on it otherwise.
create function fn_ledger_apply() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_operator uuid;
  v_new_balance int;
begin
  select operator_id into v_client_operator from clients where id = new.client_id;
  if v_client_operator is null then
    raise exception 'ledger insert for unknown client %', new.client_id;
  end if;
  if new.operator_id <> v_client_operator then
    raise exception 'ledger operator_id % does not match client operator %',
      new.operator_id, v_client_operator;
  end if;

  update clients
     set credit_balance = credit_balance + new.amount
   where id = new.client_id
  returning credit_balance into v_new_balance;

  if v_new_balance < 0 then
    raise exception 'credit balance for client % would go negative', new.client_id;
  end if;

  new.balance_after := v_new_balance;
  return new;
end;
$$;

create trigger trg_credit_ledger_apply
  before insert on credit_ledger
  for each row execute function fn_ledger_apply();

-- Append-only enforcement at the trigger level (belt to 0004's braces).
create function fn_ledger_block_mutation() returns trigger
language plpgsql
as $$
begin
  raise exception 'credit_ledger is append-only';
end;
$$;

create trigger trg_credit_ledger_immutable
  before update or delete on credit_ledger
  for each row execute function fn_ledger_block_mutation();

-- ── fn_grant_credits ─────────────────────────────────────────────────────
-- Called by stripe-webhook on invoice.paid (service role only).
create function fn_grant_credits(p_client uuid, p_amount int, p_note text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operator uuid;
  v_balance int;
begin
  if not fn_is_service_session() then
    raise exception 'fn_grant_credits: service role required';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'fn_grant_credits: amount must be positive';
  end if;

  select operator_id into v_operator
    from clients where id = p_client for update;
  if not found then
    raise exception 'fn_grant_credits: unknown client %', p_client;
  end if;

  insert into credit_ledger (operator_id, client_id, entry_type, amount, note)
  values (v_operator, p_client, 'grant', p_amount, p_note);

  select credit_balance into v_balance from clients where id = p_client;
  return v_balance;
end;
$$;

-- ── fn_walk_cost ─────────────────────────────────────────────────────────
-- credit_cost + weekend surcharge when scheduled_date is Sat/Sun.
create function fn_walk_cost(p_walk uuid)
returns int
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cost int;
begin
  select st.credit_cost
       + case when extract(isodow from w.scheduled_date) in (6, 7)
              then st.weekend_surcharge_credits else 0 end
    into v_cost
    from walks w
    join service_types st on st.id = w.service_type_id
   where w.id = p_walk
     and ( fn_is_service_session()
        or w.operator_id = auth.uid()
        or exists (select 1 from clients c
                    where c.id = w.client_id and c.auth_user_id = auth.uid()) );
  if v_cost is null then
    raise exception 'fn_walk_cost: walk % not found or not accessible', p_walk;
  end if;
  return v_cost;
end;
$$;

-- ── fn_debit_walk ────────────────────────────────────────────────────────
-- Invariant 3: a walk is EITHER fully credit-funded OR fully charged at the
-- plan overage rate — never partial. Idempotent under the client row lock.
create function fn_debit_walk(p_walk uuid)
returns table (outcome text, cost int, new_balance int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client uuid;
  w record;
  v_cost int;
  v_balance int;
begin
  if not fn_is_service_session() then
    raise exception 'fn_debit_walk: service role required';
  end if;

  select client_id into v_client from walks where id = p_walk;
  if not found then
    raise exception 'fn_debit_walk: unknown walk %', p_walk;
  end if;

  -- Serialize all balance mutations for this client, then re-read the walk
  -- under the lock so concurrent debits of the same walk are idempotent.
  select credit_balance into v_balance
    from clients where id = v_client for update;

  select * into w from walks where id = p_walk for update;

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

-- ── fn_adjust_credits ────────────────────────────────────────────────────
-- Operator manual adjustment (±); callable by authenticated — the body
-- re-verifies the caller is the operator of p_client (RLS does not apply
-- inside definer context).
create function fn_adjust_credits(p_client uuid, p_amount int, p_note text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operator uuid;
  v_balance int;
begin
  if p_amount is null or p_amount = 0 then
    raise exception 'fn_adjust_credits: amount must be non-zero';
  end if;

  select operator_id, credit_balance into v_operator, v_balance
    from clients where id = p_client for update;
  if not found then
    raise exception 'fn_adjust_credits: unknown client %', p_client;
  end if;
  if not (fn_is_service_session() or v_operator = auth.uid()) then
    raise exception 'fn_adjust_credits: caller is not the operator of this client';
  end if;
  if v_balance + p_amount < 0 then
    raise exception 'fn_adjust_credits: adjustment would make balance negative';
  end if;

  insert into credit_ledger (operator_id, client_id, entry_type, amount, note)
  values (v_operator, p_client, 'adjust', p_amount, p_note);

  select credit_balance into v_balance from clients where id = p_client;
  return v_balance;
end;
$$;

-- ── fn_apply_rollover ────────────────────────────────────────────────────
-- Called at cycle boundary (invoice.paid), BEFORE fn_grant_credits for the
-- new cycle. Single-lot carryover (v1): each boundary collapses the whole
-- remaining balance into at most one explicit rollover lot.
create function fn_apply_rollover(p_client uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operator uuid;
  v_balance int;
  v_plan plans%rowtype;
  v_carried int;
  v_excess int;
  v_expires timestamptz;
begin
  if not fn_is_service_session() then
    raise exception 'fn_apply_rollover: service role required';
  end if;

  select c.operator_id, c.credit_balance into v_operator, v_balance
    from clients c where c.id = p_client for update;
  if not found then
    raise exception 'fn_apply_rollover: unknown client %', p_client;
  end if;

  select p.* into v_plan
    from plans p join clients c on c.plan_id = p.id
   where c.id = p_client;
  if not found then
    -- No plan ⇒ nothing to roll; balance persists.
    return v_balance;
  end if;

  if v_plan.rollover_policy = 'none' then
    if v_balance > 0 then
      insert into credit_ledger (operator_id, client_id, entry_type, amount, note)
      values (v_operator, p_client, 'expiry', -v_balance, 'cycle boundary: no rollover');
    end if;

  elsif v_plan.rollover_policy = 'capped' then
    v_carried := least(v_balance, v_plan.rollover_cap);
    v_excess := v_balance - v_carried;
    if v_excess > 0 then
      insert into credit_ledger (operator_id, client_id, entry_type, amount, note)
      values (v_operator, p_client, 'expiry', -v_excess, 'cycle boundary: over rollover cap');
    end if;
    if v_carried > 0 then
      -- Re-book the carryover as one explicit lot: expiry/rollover pair.
      insert into credit_ledger (operator_id, client_id, entry_type, amount, note)
      values (v_operator, p_client, 'expiry', -v_carried, 'cycle boundary: carryover re-book');
      v_expires := case when v_plan.rollover_expiry_days is not null
                        then now() + make_interval(days => v_plan.rollover_expiry_days)
                        else null end;
      insert into credit_ledger (operator_id, client_id, entry_type, amount, expires_at, note)
      values (v_operator, p_client, 'rollover', v_carried, v_expires, 'cycle carryover lot');
    end if;

  else
    -- unlimited: balance persists; no entries (amount must be <> 0).
    null;
  end if;

  select credit_balance into v_balance from clients where id = p_client;
  return v_balance;
end;
$$;

-- ── fn_expire_credits ────────────────────────────────────────────────────
-- Daily sweep (cron via materialize-walks, phase 08; callable manually).
-- Debits conceptually consume the live lot first (single-lot v1 rule).
create function fn_expire_credits()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  lot record;
  v_balance int;
  v_consumed int;
  v_remaining int;
  v_count int := 0;
begin
  if not fn_is_service_session() then
    raise exception 'fn_expire_credits: service role required';
  end if;

  for lot in
    select l.*
      from credit_ledger l
     where l.entry_type = 'rollover'
       and l.expires_at is not null
       and l.expires_at < now()
       and not exists (
             select 1 from credit_ledger e
              where e.client_id = l.client_id
                and e.entry_type = 'expiry'
                and e.seq > l.seq)
  loop
    select credit_balance into v_balance
      from clients where id = lot.client_id for update;

    -- Re-validate candidacy under the lock: a concurrent cycle boundary may
    -- have re-booked this client's balance (inserting a superseding expiry)
    -- between the candidate scan above and lock acquisition.
    if exists (select 1 from credit_ledger e
                where e.client_id = lot.client_id
                  and e.entry_type = 'expiry'
                  and e.seq > lot.seq) then
      continue;
    end if;

    select coalesce(sum(-amount), 0) into v_consumed
      from credit_ledger
     where client_id = lot.client_id
       and entry_type = 'debit'
       and seq > lot.seq;

    v_remaining := least(greatest(0, lot.amount - v_consumed), v_balance);

    if v_remaining > 0 then
      insert into credit_ledger (operator_id, client_id, entry_type, amount, note)
      values (lot.operator_id, lot.client_id, 'expiry', -v_remaining,
              'expired rollover lot ' || lot.id);
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

-- ── fn_change_plan ───────────────────────────────────────────────────────
-- Credit-side proration only; Stripe prorates money (spec 02). Upgrades add
-- floor(Δcredits × remaining_fraction); downgrades never claw back.
create function fn_change_plan(p_client uuid, p_new_plan uuid, p_remaining_fraction numeric)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operator uuid;
  v_old_credits int := 0;
  v_new plans%rowtype;
  v_delta int;
  v_balance int;
begin
  if not fn_is_service_session() then
    raise exception 'fn_change_plan: service role required';
  end if;
  if p_remaining_fraction is null or p_remaining_fraction < 0 or p_remaining_fraction > 1 then
    raise exception 'fn_change_plan: remaining_fraction must be within [0,1]';
  end if;

  select c.operator_id into v_operator
    from clients c where c.id = p_client for update;
  if not found then
    raise exception 'fn_change_plan: unknown client %', p_client;
  end if;

  select coalesce(p.credits_per_cycle, 0) into v_old_credits
    from clients c left join plans p on p.id = c.plan_id
   where c.id = p_client;

  select * into v_new from plans where id = p_new_plan;
  if not found then
    raise exception 'fn_change_plan: unknown plan %', p_new_plan;
  end if;
  if v_new.operator_id <> v_operator then
    raise exception 'fn_change_plan: plan belongs to a different operator';
  end if;

  v_delta := floor((v_new.credits_per_cycle - v_old_credits) * p_remaining_fraction);

  if v_delta > 0 then
    insert into credit_ledger (operator_id, client_id, entry_type, amount, note)
    values (v_operator, p_client, 'adjust', v_delta, 'plan upgrade proration');
  end if;
  -- delta ≤ 0: no clawback — already-granted credits stand (spec 02).

  update clients set plan_id = p_new_plan where id = p_client;

  select credit_balance into v_balance from clients where id = p_client;
  return v_balance;
end;
$$;

-- ── fn_claim_invite ──────────────────────────────────────────────────────
-- Post-signup: binds the authenticated user to the invited client row.
create function fn_claim_invite(p_token uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client uuid;
begin
  if auth.uid() is null then
    raise exception 'fn_claim_invite: authentication required';
  end if;

  update clients
     set auth_user_id = auth.uid(),
         status = 'active'
   where invite_token = p_token
     and auth_user_id is null
  returning id into v_client;

  if v_client is null then
    raise exception 'fn_claim_invite: invalid or already claimed invite';
  end if;

  return v_client;
end;
$$;

-- ── fn_read_credential ───────────────────────────────────────────────────
-- Vault read path (spec 03): service role only, invoked by the
-- credential-vault edge function AFTER fresh re-auth. The edge function
-- passes the verified operator id (the service JWT carries no sub, so the
-- caller identity must be an explicit argument). Writes exactly one audit
-- row per read; rejects revoked credentials.
create function fn_read_credential(p_credential uuid, p_purpose text, p_operator uuid)
returns table (ciphertext bytea, label text, entry_method entry_method)
language plpgsql
security definer
set search_path = public
as $$
declare
  cred record;
begin
  if not fn_is_service_session() then
    raise exception 'fn_read_credential: service role required';
  end if;
  if p_purpose is null or length(trim(p_purpose)) = 0 then
    raise exception 'fn_read_credential: purpose is required';
  end if;

  select * into cred from access_credentials ac where ac.id = p_credential;
  if not found then
    raise exception 'fn_read_credential: unknown credential %', p_credential;
  end if;
  if cred.operator_id <> p_operator then
    raise exception 'fn_read_credential: credential belongs to a different operator';
  end if;
  if cred.revoked_at is not null then
    raise exception 'fn_read_credential: credential has been revoked';
  end if;

  insert into credential_access_log (operator_id, credential_id, accessed_by, purpose)
  values (cred.operator_id, cred.id, p_operator, p_purpose);

  return query select cred.ciphertext, cred.label, cred.entry_method;
end;
$$;

-- ── fn_notify_low_credit ─────────────────────────────────────────────────
-- Spec 02 low-credit trigger, called by complete-walk after a successful
-- debit. Deduped: skipped while an unread low_credit for the client exists.
-- Returns true when notifications were inserted.
create function fn_notify_low_credit(p_client uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client record;
  v_threshold int;
begin
  if not fn_is_service_session() then
    raise exception 'fn_notify_low_credit: service role required';
  end if;

  select c.id, c.operator_id, c.full_name, c.credit_balance
    into v_client
    from clients c where c.id = p_client;
  if not found then
    raise exception 'fn_notify_low_credit: unknown client %', p_client;
  end if;

  select low_credit_threshold into v_threshold
    from operators where id = v_client.operator_id;

  if v_client.credit_balance > v_threshold then
    return false;
  end if;

  if exists (select 1 from notifications
              where client_id = p_client
                and type = 'low_credit'
                and read_at is null) then
    return false;
  end if;

  insert into notifications (operator_id, client_id, type, title, body)
  values
    (v_client.operator_id, p_client, 'low_credit', 'You are low on walk credits',
     format('Your credit balance is %s. Top up or wait for your next cycle.', v_client.credit_balance)),
    (v_client.operator_id, null, 'low_credit', format('%s is low on credits', v_client.full_name),
     format('%s has %s credit(s) remaining.', v_client.full_name, v_client.credit_balance));

  return true;
end;
$$;
