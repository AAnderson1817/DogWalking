-- Sanpo smoke suite (phase 00).
-- Run: psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/smoke.sql
--
-- Personas are simulated with SET LOCAL SESSION AUTHORIZATION (so
-- session_user really changes) plus request.jwt.claims, exactly as
-- PostgREST populates them. The whole run happens inside one transaction
-- and rolls back, leaving the database untouched.
--
-- Fixture uuid namespace: 99999999-….

begin;

-- ═══ Fixtures (as postgres) ═══════════════════════════════════════════════
do $$
begin
  insert into auth.users (id, email) values
    ('99999999-0000-4000-a000-000000000001', 'smoke-op1@sanpo.test'),
    ('99999999-0000-4000-a000-000000000002', 'smoke-op2@sanpo.test'),
    ('99999999-0000-4000-a000-000000000003', 'smoke-client-a@sanpo.test');

  insert into operators (id, business_name, display_name, email) values
    ('99999999-0000-4000-a000-000000000001', 'Smoke Walks 1', 'Op1', 'smoke-op1@sanpo.test'),
    ('99999999-0000-4000-a000-000000000002', 'Smoke Walks 2', 'Op2', 'smoke-op2@sanpo.test');

  insert into plans (id, operator_id, name, credits_per_cycle, price_pence, cycle,
                     rollover_policy, rollover_cap, rollover_expiry_days, overage_rate_pence)
  values
    ('99999999-0000-4000-b000-000000000001', '99999999-0000-4000-a000-000000000001',
     'Smoke none', 5, 5000, 'monthly', 'none', null, null, 2000),
    ('99999999-0000-4000-b000-000000000002', '99999999-0000-4000-a000-000000000001',
     'Smoke capped', 5, 5000, 'monthly', 'capped', 3, 30, 2000),
    ('99999999-0000-4000-b000-000000000003', '99999999-0000-4000-a000-000000000001',
     'Smoke unlimited', 5, 5000, 'monthly', 'unlimited', null, null, 2000);

  -- A: main scenario client (auth-linked). A2: zero-balance overage client.
  -- B/C/D: rollover policy fixtures. E: expiry-sweep fixture.
  insert into clients (id, operator_id, auth_user_id, full_name, status, plan_id) values
    ('99999999-0000-4000-c000-00000000000a', '99999999-0000-4000-a000-000000000001',
     '99999999-0000-4000-a000-000000000003', 'Smoke Client A', 'active',
     '99999999-0000-4000-b000-000000000002'),
    ('99999999-0000-4000-c000-0000000000a2', '99999999-0000-4000-a000-000000000001',
     null, 'Smoke Client A2', 'active', '99999999-0000-4000-b000-000000000001'),
    ('99999999-0000-4000-c000-00000000000b', '99999999-0000-4000-a000-000000000001',
     null, 'Smoke Client B', 'active', '99999999-0000-4000-b000-000000000001'),
    ('99999999-0000-4000-c000-00000000000c', '99999999-0000-4000-a000-000000000001',
     null, 'Smoke Client C', 'active', '99999999-0000-4000-b000-000000000002'),
    ('99999999-0000-4000-c000-00000000000d', '99999999-0000-4000-a000-000000000001',
     null, 'Smoke Client D', 'active', '99999999-0000-4000-b000-000000000003'),
    ('99999999-0000-4000-c000-00000000000e', '99999999-0000-4000-a000-000000000001',
     null, 'Smoke Client E', 'active', '99999999-0000-4000-b000-000000000002'),
    ('99999999-0000-4000-c000-0000000000f2', '99999999-0000-4000-a000-000000000002',
     null, 'Smoke Client F2', 'active', null);

  insert into properties (id, operator_id, client_id, label) values
    ('99999999-0000-4000-d000-00000000000a', '99999999-0000-4000-a000-000000000001',
     '99999999-0000-4000-c000-00000000000a', 'A home'),
    ('99999999-0000-4000-d000-0000000000a2', '99999999-0000-4000-a000-000000000001',
     '99999999-0000-4000-c000-0000000000a2', 'A2 home'),
    ('99999999-0000-4000-d000-00000000000e', '99999999-0000-4000-a000-000000000001',
     '99999999-0000-4000-c000-00000000000e', 'E home'),
    ('99999999-0000-4000-d000-0000000000f2', '99999999-0000-4000-a000-000000000002',
     '99999999-0000-4000-c000-0000000000f2', 'F2 home');

  insert into pets (id, operator_id, client_id, name) values
    ('99999999-0000-4000-e000-00000000000a', '99999999-0000-4000-a000-000000000001',
     '99999999-0000-4000-c000-00000000000a', 'Smoke Pet A'),
    ('99999999-0000-4000-e000-0000000000a2', '99999999-0000-4000-a000-000000000001',
     '99999999-0000-4000-c000-0000000000a2', 'Smoke Pet A2'),
    ('99999999-0000-4000-e000-0000000000f2', '99999999-0000-4000-a000-000000000002',
     '99999999-0000-4000-c000-0000000000f2', 'Smoke Pet F2');

  insert into access_credentials (id, operator_id, property_id, entry_method, ciphertext, label)
  values ('99999999-0000-4000-f000-000000000001', '99999999-0000-4000-a000-000000000001',
          '99999999-0000-4000-d000-00000000000a', 'door_code',
          decode('00010203040506070809101112131415161718191a1b1c1dff', 'hex'),
          'Smoke front door');

  -- Weekday walk for A (default 30-min service, cost 1, no surcharge).
  insert into walks (id, operator_id, client_id, property_id, service_type_id,
                     scheduled_date, window_start, window_end, status)
  select '99999999-0000-4000-2000-000000000001', '99999999-0000-4000-a000-000000000001',
         '99999999-0000-4000-c000-00000000000a', '99999999-0000-4000-d000-00000000000a',
         st.id, date '2026-07-01', '10:00', '11:00', 'in_progress'
    from service_types st
   where st.operator_id = '99999999-0000-4000-a000-000000000001' and st.is_default;

  -- Walk for A2 on the 60-minute service (cost 2). A2 will hold 1 credit:
  -- insufficient but nonzero, so the overage assertions can detect a
  -- partial-debit or balance-zeroing regression.
  insert into walks (id, operator_id, client_id, property_id, service_type_id,
                     scheduled_date, window_start, window_end, status)
  select '99999999-0000-4000-2000-000000000002', '99999999-0000-4000-a000-000000000001',
         '99999999-0000-4000-c000-0000000000a2', '99999999-0000-4000-d000-0000000000a2',
         st.id, date '2026-07-01', '10:00', '11:00', 'in_progress'
    from service_types st
   where st.operator_id = '99999999-0000-4000-a000-000000000001'
     and st.name = 'Private walk 60';

  -- Weekend-surcharge service + Saturday walk for A.
  insert into service_types (id, operator_id, name, duration_minutes, credit_cost,
                             weekend_surcharge_credits)
  values ('99999999-0000-4000-3000-000000000001', '99999999-0000-4000-a000-000000000001',
          'Smoke weekend walk', 30, 1, 1);

  insert into walks (id, operator_id, client_id, property_id, service_type_id,
                     scheduled_date, window_start, window_end, status)
  values ('99999999-0000-4000-2000-000000000003', '99999999-0000-4000-a000-000000000001',
          '99999999-0000-4000-c000-00000000000a', '99999999-0000-4000-d000-00000000000a',
          '99999999-0000-4000-3000-000000000001',
          date '2026-07-04', '10:00', '11:00', 'scheduled');  -- a Saturday

  -- Walk for E to exercise post-lot debit consumption in the expiry sweep.
  insert into walks (id, operator_id, client_id, property_id, service_type_id,
                     scheduled_date, window_start, window_end, status)
  select '99999999-0000-4000-2000-000000000004', '99999999-0000-4000-a000-000000000001',
         '99999999-0000-4000-c000-00000000000e', '99999999-0000-4000-d000-00000000000e',
         st.id, date '2026-07-01', '10:00', '11:00', 'in_progress'
    from service_types st
   where st.operator_id = '99999999-0000-4000-a000-000000000001' and st.is_default;

  raise notice 'fixtures: OK';
end $$;

-- ═══ Credit scenario (service persona) ════════════════════════════════════
do $$
declare
  r record;
  v_balance int;
  v_rows int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local session authorization service_role;

  -- grant 10 → balance 10
  select fn_grant_credits('99999999-0000-4000-c000-00000000000a', 10, 'smoke grant')
    into v_balance;
  if v_balance <> 10 then
    raise exception 'FAIL: grant expected balance 10, got %', v_balance;
  end if;

  -- debit walk (cost 1) → 'debited', balance 9
  select * into r from fn_debit_walk('99999999-0000-4000-2000-000000000001');
  if r.outcome <> 'debited' or r.cost <> 1 or r.new_balance <> 9 then
    raise exception 'FAIL: debit expected (debited,1,9), got (%,%,%)', r.outcome, r.cost, r.new_balance;
  end if;

  -- idempotent re-debit: same outcome, no new ledger row
  select count(*) into v_rows from credit_ledger
   where walk_id = '99999999-0000-4000-2000-000000000001';
  select * into r from fn_debit_walk('99999999-0000-4000-2000-000000000001');
  if r.outcome <> 'debited' or r.cost <> 1 then
    raise exception 'FAIL: re-debit not idempotent: (%,%)', r.outcome, r.cost;
  end if;
  if (select count(*) from credit_ledger
       where walk_id = '99999999-0000-4000-2000-000000000001') <> v_rows then
    raise exception 'FAIL: re-debit inserted a second ledger row';
  end if;

  -- insufficient balance (1 < cost 2) → 'overage', balance unchanged at 1,
  -- NO debit entry — invariant 3: never partial credit consumption.
  perform fn_grant_credits('99999999-0000-4000-c000-0000000000a2', 1, 'smoke a2 partial');
  select * into r from fn_debit_walk('99999999-0000-4000-2000-000000000002');
  if r.outcome <> 'overage' or r.cost <> 2 or r.new_balance <> 1 then
    raise exception 'FAIL: overage expected (overage,2,1), got (%,%,%)', r.outcome, r.cost, r.new_balance;
  end if;
  if exists (select 1 from credit_ledger
              where client_id = '99999999-0000-4000-c000-0000000000a2'
                and entry_type = 'debit') then
    raise exception 'FAIL: overage wrote a debit ledger entry';
  end if;
  if (select credit_balance from clients
       where id = '99999999-0000-4000-c000-0000000000a2') <> 1 then
    raise exception 'FAIL: overage mutated the balance';
  end if;
  if not (select is_overage from walks
           where id = '99999999-0000-4000-2000-000000000002') then
    raise exception 'FAIL: overage flag not set on walk';
  end if;
  -- idempotent overage re-call
  select * into r from fn_debit_walk('99999999-0000-4000-2000-000000000002');
  if r.outcome <> 'overage' then
    raise exception 'FAIL: overage re-call not idempotent';
  end if;

  -- weekend surcharge: cost = 1 + 1 on a Saturday walk
  if fn_walk_cost('99999999-0000-4000-2000-000000000003') <> 2 then
    raise exception 'FAIL: weekend walk cost expected 2';
  end if;

  raise notice 'credit scenario (service): OK';
end $$;

-- adjust +2 as the OPERATOR persona (authenticated; body tenancy check)
do $$
declare
  v_balance int;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000000001","role":"authenticated"}', true);
  set local session authorization authenticated;

  select fn_adjust_credits('99999999-0000-4000-c000-00000000000a', 2, 'smoke adjust')
    into v_balance;
  if v_balance <> 11 then
    raise exception 'FAIL: adjust expected balance 11, got %', v_balance;
  end if;

  -- over-negative adjustment rejected
  begin
    perform fn_adjust_credits('99999999-0000-4000-c000-00000000000a', -999, 'smoke bad adjust');
    raise exception 'FAIL: negative-overshoot adjust was not rejected';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%adjustment would make balance negative%' then
      raise exception 'FAIL: negative-overshoot adjust was not rejected — rejected for the wrong reason: %', sqlerrm;
    end if;
  end;

  reset session authorization;
  raise notice 'adjust (operator persona): OK';
end $$;

-- adjust by the WRONG operator persona must be rejected by the body check
do $$
begin
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000000002","role":"authenticated"}', true);
  set local session authorization authenticated;
  begin
    perform fn_adjust_credits('99999999-0000-4000-c000-00000000000a', 1, 'smoke cross-tenant');
    raise exception 'FAIL: cross-tenant adjust was not rejected';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%caller is not the operator of this client%' then
      raise exception 'FAIL: cross-tenant adjust was not rejected — rejected for the wrong reason: %', sqlerrm;
    end if;
  end;
  reset session authorization;
  raise notice 'cross-tenant adjust rejection: OK';
end $$;

-- ═══ Rollover policies (fresh fixture clients) ════════════════════════════
do $$
declare
  v_balance int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local session authorization service_role;

  -- none: 7 → expire all → 0, then new-cycle grant 5
  perform fn_grant_credits('99999999-0000-4000-c000-00000000000b', 7, 'cycle 1');
  select fn_apply_rollover('99999999-0000-4000-c000-00000000000b') into v_balance;
  if v_balance <> 0 then
    raise exception 'FAIL: rollover(none) expected 0, got %', v_balance;
  end if;
  select fn_grant_credits('99999999-0000-4000-c000-00000000000b', 5, 'cycle 2') into v_balance;
  if v_balance <> 5 then
    raise exception 'FAIL: post-rollover grant expected 5, got %', v_balance;
  end if;

  -- capped (cap 3): 10 → excess expiry −7, re-book pair (−3/+3 lot) → 3, +5 → 8
  perform fn_grant_credits('99999999-0000-4000-c000-00000000000c', 10, 'cycle 1');
  select fn_apply_rollover('99999999-0000-4000-c000-00000000000c') into v_balance;
  if v_balance <> 3 then
    raise exception 'FAIL: rollover(capped) expected 3, got %', v_balance;
  end if;
  if (select count(*) from credit_ledger
       where client_id = '99999999-0000-4000-c000-00000000000c'
         and entry_type = 'rollover' and amount = 3 and expires_at is not null) <> 1 then
    raise exception 'FAIL: capped rollover lot missing';
  end if;
  select fn_grant_credits('99999999-0000-4000-c000-00000000000c', 5, 'cycle 2') into v_balance;
  if v_balance <> 8 then
    raise exception 'FAIL: capped post-grant expected 8, got %', v_balance;
  end if;

  -- unlimited: 9 → rollover is a no-op, balance persists
  perform fn_grant_credits('99999999-0000-4000-c000-00000000000d', 9, 'cycle 1');
  select fn_apply_rollover('99999999-0000-4000-c000-00000000000d') into v_balance;
  if v_balance <> 9 then
    raise exception 'FAIL: rollover(unlimited) expected 9, got %', v_balance;
  end if;
  if exists (select 1 from credit_ledger
              where client_id = '99999999-0000-4000-c000-00000000000d'
                and entry_type in ('rollover', 'expiry')) then
    raise exception 'FAIL: rollover(unlimited) wrote entries';
  end if;

  raise notice 'rollover policies: OK';
end $$;

-- ═══ Expiry sweep on an expired lot ═══════════════════════════════════════
do $$
declare
  v_swept int;
  v_balance int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local session authorization service_role;

  -- Build client E history: grant 4, then an already-expired rollover lot of
  -- 3 (inserted directly as postgres — test scaffolding the engine cannot
  -- produce, since real lots always expire in the future), then a debit of 1
  -- that conceptually consumes from the lot.
  perform fn_grant_credits('99999999-0000-4000-c000-00000000000e', 4, 'cycle 1');

  reset session authorization;  -- postgres: direct insert of the expired lot
  insert into credit_ledger (operator_id, client_id, entry_type, amount, expires_at, note)
  values ('99999999-0000-4000-a000-000000000001', '99999999-0000-4000-c000-00000000000e',
          'rollover', 3, now() - interval '1 day', 'smoke: pre-expired lot');

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local session authorization service_role;

  perform fn_debit_walk('99999999-0000-4000-2000-000000000004');  -- consumes 1

  -- Lot 3, consumed 1 ⇒ remaining 2 expires. Balance 4+3−1=6 → 4.
  select fn_expire_credits() into v_swept;
  if v_swept <> 1 then
    raise exception 'FAIL: expiry sweep expected 1 client, got %', v_swept;
  end if;
  select credit_balance into v_balance from clients
   where id = '99999999-0000-4000-c000-00000000000e';
  if v_balance <> 4 then
    raise exception 'FAIL: post-sweep balance expected 4, got %', v_balance;
  end if;

  -- Sweep is idempotent: the expiry row now supersedes the lot.
  select fn_expire_credits() into v_swept;
  if v_swept <> 0 then
    raise exception 'FAIL: second sweep expected 0, got %', v_swept;
  end if;

  raise notice 'expiry sweep: OK';
end $$;

-- ═══ Ledger chain integrity (spec 02) ═════════════════════════════════════
do $$
declare
  v_violations int;
begin
  reset session authorization;
  -- seq is the authoritative chain order: it is assigned while the writer
  -- holds the per-client row lock, so it always reflects application order
  -- (created_at alone cannot: now() is transaction start time).
  with ordered as (
    select client_id, amount, balance_after,
           lag(balance_after) over (partition by client_id order by seq) as prev
      from credit_ledger)
  select count(*) into v_violations
    from ordered
   where balance_after <> coalesce(prev, 0) + amount;
  if v_violations <> 0 then
    raise exception 'FAIL: % ledger chain violations', v_violations;
  end if;
  raise notice 'ledger chain integrity: OK (0 violations)';
end $$;

-- ═══ Security assertion 1: cross-client isolation ═════════════════════════
-- As client A's JWT: A2's rows across clients/pets/walks/ledger → 0 rows.
do $$
declare
  n int;
begin
  reset session authorization;
  -- Give A2 some ledger history so the isolation test is not vacuous.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local session authorization service_role;
  perform fn_grant_credits('99999999-0000-4000-c000-0000000000a2', 3, 'smoke a2 grant');
  reset session authorization;

  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000000003","role":"authenticated"}', true);
  set local session authorization authenticated;

  -- sanity: client A sees own row
  select count(*) into n from clients where id = '99999999-0000-4000-c000-00000000000a';
  if n <> 1 then raise exception 'FAIL: client A cannot see own client row'; end if;

  select count(*) into n from clients where id = '99999999-0000-4000-c000-0000000000a2';
  if n <> 0 then raise exception 'FAIL: client A sees client A2 row'; end if;
  select count(*) into n from pets where client_id = '99999999-0000-4000-c000-0000000000a2';
  if n <> 0 then raise exception 'FAIL: client A sees A2 pets'; end if;
  select count(*) into n from walks where client_id = '99999999-0000-4000-c000-0000000000a2';
  if n <> 0 then raise exception 'FAIL: client A sees A2 walks'; end if;
  select count(*) into n from credit_ledger where client_id = '99999999-0000-4000-c000-0000000000a2';
  if n <> 0 then raise exception 'FAIL: client A sees A2 ledger'; end if;

  reset session authorization;
  raise notice 'security 1 (cross-client isolation): OK';
end $$;

-- ═══ Security assertion 2: balance unforgeable even by the operator ═══════
do $$
begin
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000000001","role":"authenticated"}', true);
  set local session authorization authenticated;
  begin
    update clients set credit_balance = 999
     where id = '99999999-0000-4000-c000-00000000000a';
    raise exception 'FAIL: operator updated credit_balance directly';
  exception when insufficient_privilege then
    null;  -- expected
  end;
  reset session authorization;
  raise notice 'security 2 (credit_balance unforgeable): OK';
end $$;

-- ═══ Security assertion 3: ciphertext unreadable, metadata readable ═══════
do $$
declare
  n int;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000000001","role":"authenticated"}', true);
  set local session authorization authenticated;
  begin
    perform ciphertext from access_credentials
     where id = '99999999-0000-4000-f000-000000000001';
    raise exception 'FAIL: operator read access_credentials.ciphertext';
  exception when insufficient_privilege then
    null;  -- expected
  end;
  select count(*) into n from (
    select id, label from access_credentials
     where id = '99999999-0000-4000-f000-000000000001') s;
  if n <> 1 then
    raise exception 'FAIL: operator cannot read credential metadata';
  end if;
  -- 0013: INSERT of ciphertext is also denied (plaintext-into-vault via
  -- PostgREST); only the credential-vault edge fn (service role) writes it.
  begin
    insert into access_credentials
      (operator_id, property_id, entry_method, ciphertext, label)
    values ('99999999-0000-4000-a000-000000000001',
            '99999999-0000-4000-d000-00000000000a', 'door_code',
            '\x00'::bytea, 'smuggled');
    raise exception 'FAIL: operator inserted access_credentials.ciphertext';
  exception when insufficient_privilege then
    null;  -- expected
  end;
  reset session authorization;
  raise notice 'security 3 (ciphertext column privilege): OK';
end $$;

-- ═══ Security assertion 3b: one live overage payment per walk (0013) ══════
do $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into payments (operator_id, client_id, walk_id, type, amount_pence,
                        currency, status)
  values ('99999999-0000-4000-a000-000000000001',
          '99999999-0000-4000-c000-00000000000a',
          '99999999-0000-4000-2000-000000000001', 'overage', 2500, 'USD', 'succeeded');
  begin
    insert into payments (operator_id, client_id, walk_id, type, amount_pence,
                          currency, status)
    values ('99999999-0000-4000-a000-000000000001',
            '99999999-0000-4000-c000-00000000000a',
            '99999999-0000-4000-2000-000000000001', 'overage', 2500, 'USD', 'pending');
    raise exception 'FAIL: second live overage payment for one walk was accepted';
  exception when unique_violation then
    null;  -- expected
  end;
  -- a failed attempt row is still allowed (re-charge path)
  insert into payments (operator_id, client_id, walk_id, type, amount_pence,
                        currency, status)
  values ('99999999-0000-4000-a000-000000000001',
          '99999999-0000-4000-c000-00000000000a',
          '99999999-0000-4000-2000-000000000001', 'overage', 2500, 'USD', 'failed');
  raise notice 'security 3b (overage payment uniqueness): OK';
end $$;

-- ═══ Security assertion 3c: tenant consistency on known UUIDs (0014) ═════
do $$
declare
  v_service_op1 uuid;
  v_service_op2 uuid;
  v_walk uuid;
begin
  select id into v_service_op1 from service_types
   where operator_id = '99999999-0000-4000-a000-000000000001' and is_default;
  select id into v_service_op2 from service_types
   where operator_id = '99999999-0000-4000-a000-000000000002' and is_default;

  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000000001","role":"authenticated"}', true);
  set local session authorization authenticated;

  begin
    insert into walks (operator_id, client_id, property_id, service_type_id,
                       scheduled_date, window_start, window_end, status)
    values ('99999999-0000-4000-a000-000000000001',
            '99999999-0000-4000-c000-0000000000f2',
            '99999999-0000-4000-d000-00000000000a',
            v_service_op1, date '2026-07-08', '10:00', '11:00', 'scheduled');
    raise exception 'FAIL: cross-tenant client UUID accepted on walk';
  exception when raise_exception then
    if sqlerrm not like 'tenant consistency:%' then raise; end if;
  end;

  begin
    insert into walks (operator_id, client_id, property_id, service_type_id,
                       scheduled_date, window_start, window_end, status)
    values ('99999999-0000-4000-a000-000000000001',
            '99999999-0000-4000-c000-00000000000a',
            '99999999-0000-4000-d000-0000000000a2',
            v_service_op1, date '2026-07-08', '10:00', '11:00', 'scheduled');
    raise exception 'FAIL: wrong-client property UUID accepted on walk';
  exception when raise_exception then
    if sqlerrm not like 'tenant consistency:%' then raise; end if;
  end;

  begin
    insert into walks (operator_id, client_id, property_id, service_type_id,
                       scheduled_date, window_start, window_end, status)
    values ('99999999-0000-4000-a000-000000000001',
            '99999999-0000-4000-c000-00000000000a',
            '99999999-0000-4000-d000-00000000000a',
            v_service_op2, date '2026-07-08', '10:00', '11:00', 'scheduled');
    raise exception 'FAIL: cross-tenant service UUID accepted on walk';
  exception when raise_exception then
    if sqlerrm not like 'tenant consistency:%' then raise; end if;
  end;

  insert into walks (operator_id, client_id, property_id, service_type_id,
                     scheduled_date, window_start, window_end, status)
  values ('99999999-0000-4000-a000-000000000001',
          '99999999-0000-4000-c000-00000000000a',
          '99999999-0000-4000-d000-00000000000a',
          v_service_op1, date '2026-07-08', '10:00', '11:00', 'scheduled')
  returning id into v_walk;

  begin
    insert into walk_pets (walk_id, pet_id, operator_id)
    values (v_walk, '99999999-0000-4000-e000-0000000000f2',
            '99999999-0000-4000-a000-000000000001');
    raise exception 'FAIL: cross-tenant pet UUID accepted on walk_pet';
  exception when raise_exception then
    if sqlerrm not like 'tenant consistency:%' then raise; end if;
  end;

  reset session authorization;
  raise notice 'security 3c (tenant consistency known UUIDs): OK';
end $$;

-- ═══ Security assertion 4: direct ledger insert denied ════════════════════
do $$
begin
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000000001","role":"authenticated"}', true);
  set local session authorization authenticated;
  begin
    insert into credit_ledger (operator_id, client_id, entry_type, amount)
    values ('99999999-0000-4000-a000-000000000001',
            '99999999-0000-4000-c000-00000000000a', 'grant', 100);
    raise exception 'FAIL: operator inserted into credit_ledger directly';
  exception when insufficient_privilege then
    null;  -- expected
  end;
  reset session authorization;
  raise notice 'security 4 (ledger insert denied): OK';
end $$;

-- ═══ Security assertion 5: anon gets nothing ══════════════════════════════
do $$
declare
  t text;
  n int;
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local session authorization anon;
  -- From the CATALOGUE, not a literal list (review M31). The array this
  -- replaces was the 18 tables that existed in 0002, copied from
  -- 0004_security.sql, so the suite was structurally incapable of noticing
  -- `plan_change_intents`, `vault_rate_limit_attempts` or `job_runs` — all of
  -- which had been added since, two of them with no RLS at all. A test that
  -- enumerates what it checks can only ever check what somebody remembered.
  for t in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' order by c.relname
  loop
    begin
      execute format('select count(*) from %I', t) into n;
      if n <> 0 then
        raise exception 'FAIL: anon sees % rows in %', n, t;
      end if;
    exception when insufficient_privilege then
      null;  -- expected
    end;
  end loop;

  -- The loop must have had something to iterate. An empty catalogue query
  -- passes every assertion inside it and proves nothing — the vacuity failure
  -- this repository keeps finding.
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r') < 18 then
    raise exception 'FAIL: the anon sweep found fewer tables than 0002 created';
  end if;

  begin
    perform fn_grant_credits('99999999-0000-4000-c000-00000000000a', 1, 'anon grant');
    raise exception 'FAIL: anon executed fn_grant_credits';
  exception when insufficient_privilege then
    null;  -- expected
  end;

  reset session authorization;
  raise notice 'security 5 (anon denied everywhere): OK';
end $$;

-- ═══ Security assertion 6: RLS covers every table, now and later ══════════
-- The anon sweep above tests GRANTS: a table with no grant to `anon` raises
-- insufficient_privilege and the loop swallows it, so an unprotected table
-- passes that sweep. Verified — adding a grantless table left it green.
--
-- RLS is a separate control and needs its own assertion, and it needs to live
-- HERE rather than only in 0032. A migration's assertion runs once, when that
-- migration applies; a table added in 0033 would apply cleanly and 0032 would
-- never look again. This runs after every migration, on every CI database job.
do $$
declare
  missing text;
  exempt text[] := array[]::text[];  -- nothing is exempt; add a name AND a reason
begin
  select string_agg(c.relname, ', ' order by c.relname) into missing
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and not (c.relrowsecurity and c.relforcerowsecurity)
     and not (c.relname = any (exempt));
  if missing is not null then
    raise exception 'FAIL: RLS not enabled+forced on: % (invariant 7)', missing;
  end if;
  raise notice 'security 6 (RLS enabled+forced on every public table): OK';
end $$;

-- ═══ Settled failures stop needing attention (0034, review M3) ════════════
do $$
declare
  v_op uuid := '99999999-0000-4000-a000-000000000001';
  v_cl uuid := '99999999-0000-4000-c000-00000000000a';
  v_walk uuid;
  v_failed uuid;
  v_other uuid;
begin
  reset session authorization;

  -- A subscription invoice that failed, then paid.
  insert into payments (operator_id, client_id, type, amount_pence, currency,
                        status, stripe_invoice_id)
  values (v_op, v_cl, 'subscription', 9000, 'USD', 'failed', 'in_smoke_m3')
  returning id into v_failed;

  -- An UNRELATED failure that must not be touched. Without this the test
  -- passes against a trigger that supersedes every failed row it can find,
  -- which would hide real unpaid invoices — the opposite defect, and worse.
  insert into payments (operator_id, client_id, type, amount_pence, currency,
                        status, stripe_invoice_id)
  values (v_op, v_cl, 'subscription', 4200, 'USD', 'failed', 'in_smoke_m3_other')
  returning id into v_other;

  if (select superseded_at from payments where id = v_failed) is not null then
    raise exception 'FAIL: a failure was superseded before anything settled it';
  end if;

  insert into payments (operator_id, client_id, type, amount_pence, currency,
                        status, stripe_invoice_id)
  values (v_op, v_cl, 'subscription', 9000, 'USD', 'succeeded', 'in_smoke_m3');

  if (select superseded_at from payments where id = v_failed) is null then
    raise exception 'FAIL: a paid invoice left its failed row needing attention';
  end if;
  if (select superseded_at from payments where id = v_other) is not null then
    raise exception 'FAIL: an unrelated unpaid invoice was marked settled';
  end if;

  -- The failed row keeps its status: it DID fail, and that is history rather
  -- than something to rewrite. Only whether it still needs attention changes.
  if (select status from payments where id = v_failed) <> 'failed' then
    raise exception 'FAIL: superseding rewrote the payment status';
  end if;

  -- Overage, following the REAL path: the charge flow inserts a `pending`
  -- claim and then UPDATEs that row to `succeeded` (_lib/overage.ts). An
  -- insert-only trigger never sees the success at all. The first version of
  -- this block inserted a succeeded row directly and passed against a trigger
  -- that could not work in production — a fixture that did not match the code
  -- it was standing in for.
  -- A walk with no overage payment yet: uq_overage_payment_per_walk is a
  -- partial index over the claim statuses, so reusing a walk an earlier block
  -- already charged collides before this block can test anything.
  select w.id into v_walk from walks w
   where w.operator_id = v_op and w.client_id = v_cl
     and not exists (select 1 from payments p
                      where p.walk_id = w.id and p.type = 'overage')
   limit 1;
  if v_walk is null then
    raise exception 'FAIL: no uncharged walk available for the overage case';
  end if;
  insert into payments (operator_id, client_id, walk_id, type, amount_pence,
                        currency, status)
  values (v_op, v_cl, v_walk, 'overage', 1800, 'USD', 'failed')
  returning id into v_failed;
  insert into payments (operator_id, client_id, walk_id, type, amount_pence,
                        currency, status)
  values (v_op, v_cl, v_walk, 'overage', 1800, 'USD', 'pending')
  returning id into v_other;
  if (select superseded_at from payments where id = v_failed) is not null then
    raise exception 'FAIL: a pending claim superseded a failure before it settled';
  end if;
  update payments set status = 'succeeded' where id = v_other;
  if (select superseded_at from payments where id = v_failed) is null then
    raise exception 'FAIL: a collected overage left its failed attempt open';
  end if;

  raise notice 'settled failures superseded (0034): OK';
end $$;

-- ═══ fn_account_has_password is not an oracle (0035, review M2) ═══════════
do $$
declare
  v_op1 uuid := '99999999-0000-4000-a000-000000000001';
  v_op2 uuid := '99999999-0000-4000-a000-000000000002';
begin
  reset session authorization;

  -- Service role may ask about anyone: the vault edge function needs it for
  -- the caller, and it runs as service_role with no auth.uid().
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform fn_account_has_password(v_op1);

  -- A signed-in user may ask about THEMSELVES.
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_op1)::text, true);
  set local session authorization authenticated;
  perform fn_account_has_password(v_op1);

  -- ...and about nobody else. Without this the function is an account oracle:
  -- any operator could probe an arbitrary uuid for whether an account exists
  -- and how it signs in, which is precisely the property GoTrue protects by
  -- returning the same error for "wrong password" and "no password".
  begin
    perform fn_account_has_password(v_op2);
    raise exception 'FAIL: fn_account_has_password answered about another account';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%only ask about your own account%' then
      raise exception 'FAIL: cross-account probe rejected for the wrong reason: %', sqlerrm;
    end if;
  end;
  reset session authorization;

  -- And it reports the truth in both directions.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  update auth.users set encrypted_password = null where id = v_op1;
  if fn_account_has_password(v_op1) then
    raise exception 'FAIL: a passwordless account reported a password';
  end if;
  update auth.users set encrypted_password = '$2a$10$fake' where id = v_op1;
  if not fn_account_has_password(v_op1) then
    raise exception 'FAIL: an account with a password reported none';
  end if;
  -- An empty string is not a password either; GoTrue leaves '' behind in some
  -- flows, and treating it as set would put the operator right back in the
  -- loop this migration exists to break.
  update auth.users set encrypted_password = '' where id = v_op1;
  if fn_account_has_password(v_op1) then
    raise exception 'FAIL: an empty encrypted_password reported as set';
  end if;

  raise notice 'fn_account_has_password (0035): OK';
end $$;

-- ═══ Extra guards: claim invite + client partial-column updates ═══════════
do $$
declare
  v_client uuid;
begin
  -- claim invite binds auth user and activates (fixture: fresh invite client)
  reset session authorization;
  insert into auth.users (id, email)
  values ('99999999-0000-4000-a000-000000000004', 'smoke-claimer@sanpo.test');
  insert into clients (id, operator_id, full_name, status, invite_token)
  values ('99999999-0000-4000-c000-00000000000f', '99999999-0000-4000-a000-000000000001',
          'Smoke Claimer', 'invited', '99999999-9999-4999-a999-999999999999');

  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000000004","role":"authenticated"}', true);
  set local session authorization authenticated;

  -- preview shows the invitee without exposing the clients row (0006)
  if (select full_name from fn_preview_invite('99999999-9999-4999-a999-999999999999'))
       is distinct from 'Smoke Claimer' then
    raise exception 'FAIL: invite preview did not return the invitee';
  end if;
  if (select count(*) from fn_preview_invite('99999999-0000-4000-a000-000000000009')) <> 0 then
    raise exception 'FAIL: invite preview leaked rows for a bogus token';
  end if;

  -- 0039 changed the contract: refusals are RETURNED, not raised, because a
  -- raise rolls back the audit row written alongside them.
  select c.client_id into v_client
    from fn_claim_invite('99999999-9999-4999-a999-999999999999') c;
  if v_client <> '99999999-0000-4000-c000-00000000000f' then
    raise exception 'FAIL: claim returned wrong client';
  end if;
  if (select status from clients where id = v_client) <> 'active' then
    raise exception 'FAIL: claim did not activate client';
  end if;
  -- second claim of the same token refuses, and binds nobody
  if (select c.outcome from fn_claim_invite('99999999-9999-4999-a999-999999999999') c)
       <> 'already_claimed' then
    raise exception 'FAIL: double claim was not reported as already_claimed';
  end if;
  if (select c.client_id from fn_claim_invite('99999999-9999-4999-a999-999999999999') c)
       is not null then
    raise exception 'FAIL: a refused claim returned a client id';
  end if;
  if (select auth_user_id from clients where id = v_client)
       <> '99999999-0000-4000-a000-000000000004' then
    raise exception 'FAIL: a second claim rebound the client';
  end if;
  reset session authorization;

  -- client persona may update contact fields but not notes/status
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000000003","role":"authenticated"}', true);
  set local session authorization authenticated;
  update clients set phone = '+1 312 555 0199'
   where id = '99999999-0000-4000-c000-00000000000a';
  begin
    update clients set notes = 'client-forged note'
     where id = '99999999-0000-4000-c000-00000000000a';
    raise exception 'FAIL: client updated operator notes';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%may update contact fields only%' then
      raise exception 'FAIL: client updated operator notes — rejected for the wrong reason: %', sqlerrm;
    end if;
  end;
  reset session authorization;

  raise notice 'invite claim + partial-column guards: OK';
end $$;

-- ═══ Portal booking & cancellation policies (0008) ════════════════════════
do $$
declare
  v_walk uuid;
  v_prop uuid := '99999999-0000-4000-d000-00000000000a';
  v_service uuid;
begin
  reset session authorization;
  select id into v_service from service_types
   where operator_id = '99999999-0000-4000-a000-000000000001' and is_default;

  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000000003","role":"authenticated"}', true);
  set local session authorization authenticated;

  -- Client A books a one-off walk far in the future → allowed.
  insert into walks (operator_id, client_id, property_id, service_type_id,
                     scheduled_date, window_start, window_end, status)
  values ('99999999-0000-4000-a000-000000000001', '99999999-0000-4000-c000-00000000000a',
          v_prop, v_service, current_date + 10, '10:00', '11:00', 'scheduled')
  returning id into v_walk;

  -- ...and may cancel it (well before the 12 h cutoff).
  update walks set status = 'cancelled' where id = v_walk;
  if (select status from walks where id = v_walk) <> 'cancelled' then
    raise exception 'FAIL: client could not cancel own future walk';
  end if;

  -- Booking for another client is blocked by RLS.
  --
  -- Review M34: this used client A's property (`v_prop`) with client A2's id,
  -- so the TENANT-CONSISTENCY TRIGGER raised first — P0001, "walk property
  -- must belong to client/operator" — and RLS was never the control under
  -- test. Weakening the policy's `client_id` predicate would not have failed
  -- it. Probed to confirm before changing anything, rather than inferred.
  --
  -- A2's own property makes the trigger happy, so the only thing left to
  -- refuse is the policy. Pinned to 42501 for the same reason: `when others`
  -- would go green again the moment some other control fired first.
  begin
    insert into walks (operator_id, client_id, property_id, service_type_id,
                       scheduled_date, window_start, window_end, status)
    values ('99999999-0000-4000-a000-000000000001', '99999999-0000-4000-c000-0000000000a2',
            '99999999-0000-4000-d000-0000000000a2', v_service,
            current_date + 10, '10:00', '11:00', 'scheduled');
    raise exception 'FAIL: client booked a walk for another client';
  exception when insufficient_privilege then
    null;  -- RLS refused, which is the control this asserts
  end;

  -- Cancelling inside the cutoff window is rejected by the guard.
  reset session authorization;
  insert into walks (id, operator_id, client_id, property_id, service_type_id,
                     scheduled_date, window_start, window_end, status)
  values ('99999999-0000-4000-2000-000000000009', '99999999-0000-4000-a000-000000000001',
          '99999999-0000-4000-c000-00000000000a', v_prop, v_service,
          current_date, localtime(0), localtime(0) + interval '1 hour', 'scheduled');

  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000000003","role":"authenticated"}', true);
  set local session authorization authenticated;
  begin
    update walks set status = 'cancelled'
     where id = '99999999-0000-4000-2000-000000000009';
    raise exception 'FAIL: client cancelled inside the cutoff window';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%contact your walker to cancel%' then
      raise exception 'FAIL: client cancelled inside the cutoff window — rejected for the wrong reason: %', sqlerrm;
    end if;
  end;

  -- Clients may not touch other columns even on their own scheduled walks.
  begin
    update walks set notes = 'client-forged note'
     where id = '99999999-0000-4000-2000-000000000009';
    raise exception 'FAIL: client updated walk fields other than status';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%may only cancel scheduled walks%' then
      raise exception 'FAIL: client updated walk fields other than status — rejected for the wrong reason: %', sqlerrm;
    end if;
  end;

  reset session authorization;
  raise notice 'portal booking & cutoff guards: OK';
end $$;

-- ═══ Plan-change intents: supersede, one-pending, idempotent apply (0018) ══
do $$
declare
  v_client uuid := '99999999-0000-4000-c000-00000000000a';
  v_op uuid := '99999999-0000-4000-a000-000000000001';
  v_plan_b uuid := '99999999-0000-4000-b000-000000000002';
  v_plan_c uuid := '99999999-0000-4000-b000-000000000003';
  v_intent1 uuid;
  v_key1 text;
  v_intent1_replay uuid;
  v_key1_replay text;
  v_intent2 uuid;
  v_balance1 int;
  v_balance2 int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local session authorization service_role;

  -- Record an intent, then replay the identical request: same intent AND the
  -- same Stripe idempotency key must come back (retry replays, not re-issues).
  select o_intent_id, o_idempotency_key into v_intent1, v_key1
    from fn_record_plan_change_intent(v_op, v_client, v_op, null, v_plan_b, 'sub_smoke', 0.5);
  select o_intent_id, o_idempotency_key into v_intent1_replay, v_key1_replay
    from fn_record_plan_change_intent(v_op, v_client, v_op, null, v_plan_b, 'sub_smoke', 0.5);
  if v_intent1 <> v_intent1_replay or v_key1 <> v_key1_replay then
    raise exception 'FAIL: identical plan-change request did not reuse the pending intent';
  end if;

  -- A different target supersedes: old pending intent gone, exactly one left.
  select o_intent_id into v_intent2
    from fn_record_plan_change_intent(v_op, v_client, v_op, null, v_plan_c, 'sub_smoke', 0.5);
  if exists (select 1 from plan_change_intents where id = v_intent1) then
    raise exception 'FAIL: superseded intent still present';
  end if;
  if (select count(*) from plan_change_intents where client_id = v_client and status = 'pending') <> 1 then
    raise exception 'FAIL: expected exactly one pending intent per client';
  end if;

  -- The partial unique index blocks a second pending intent outright.
  begin
    insert into plan_change_intents (operator_id, client_id, requested_by, new_plan_id,
                                     stripe_update_idempotency_key, remaining_fraction)
    values (v_op, v_client, v_op, v_plan_b, 'smoke-dup-key', 0.5);
    raise exception 'FAIL: second pending intent accepted despite unique index';
  exception when unique_violation then
    null;
  end;

  -- Apply is idempotent on replay: same event, same intent → one plan change.
  select fn_apply_plan_change_intent(v_intent2, 'evt_smoke_intent') into v_balance1;
  select fn_apply_plan_change_intent(v_intent2, 'evt_smoke_intent_retry') into v_balance2;
  if v_balance1 <> v_balance2 then
    raise exception 'FAIL: replayed intent apply changed the balance (% -> %)', v_balance1, v_balance2;
  end if;
  if (select plan_id from clients where id = v_client) <> v_plan_c then
    raise exception 'FAIL: applied intent did not move the client to the target plan';
  end if;
  if (select status from plan_change_intents where id = v_intent2) <> 'applied' then
    raise exception 'FAIL: applied intent not marked applied';
  end if;

  reset session authorization;
  raise notice 'plan-change intents (0018): OK';
end $$;

-- ── fn_book_walk (0019) ───────────────────────────────────────────────────
-- Review B1 / issue #9: 0013 shipped this RPC filtering `service_types ...
-- and active`, a column that has never existed, so every client self-booking
-- raised 42703. Nothing here called it, so CI stayed green for the entire
-- life of the bug. The happy path below IS the regression test: run it
-- against 0013 and it fails with undefined_column.
do $$
declare
  v_walk uuid;
  v_today date := (now() at time zone 'America/Chicago')::date;
  v_before int;
begin
  reset session authorization;
  -- Counted as a delta, not an absolute: an earlier fixture already books
  -- client A a one-off walk on current_date (the cancellation-cutoff block),
  -- so any absolute expectation here would be wrong the moment fixtures move.
  select count(*) into v_before from walks
   where client_id = '99999999-0000-4000-c000-00000000000a'
     and schedule_id is null;

  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000000003","role":"authenticated"}', true);
  set local session authorization authenticated;

  -- Happy path: client A books their own property, their own pet, their
  -- operator's service, today.
  select fn_book_walk(
    '99999999-0000-4000-d000-00000000000a',  -- property: client A's
    '99999999-0000-4000-3000-000000000001',  -- service: operator A's
    v_today,
    '09:00', '10:00',
    array['99999999-0000-4000-e000-00000000000a']::uuid[]  -- pet: client A's
  ) into v_walk;

  if v_walk is null then
    raise exception 'FAIL: fn_book_walk returned null';
  end if;
  if not exists (
    select 1 from walks
     where id = v_walk
       and client_id = '99999999-0000-4000-c000-00000000000a'
       and operator_id = '99999999-0000-4000-a000-000000000001'
       and property_id = '99999999-0000-4000-d000-00000000000a'
       and service_type_id = '99999999-0000-4000-3000-000000000001'
       and scheduled_date = v_today
       and status = 'scheduled'
       and schedule_id is null) then
    raise exception 'FAIL: booked walk row is wrong or missing';
  end if;
  -- One-off bookings carry no schedule, so chk_walks_origin (0013) exempts
  -- them from origin_date. Pin that, or a future NOT NULL breaks booking.
  if (select origin_date from walks where id = v_walk) is not null then
    raise exception 'FAIL: one-off booking should not carry an origin_date';
  end if;
  if (select count(*) from walk_pets where walk_id = v_walk) <> 1 then
    raise exception 'FAIL: booked walk did not get exactly one walk_pets row';
  end if;

  -- Each rejection asserts the SPECIFIC error, not merely that something
  -- failed. The file's usual idiom swallows any exception that is not
  -- prefixed FAIL:, which would have passed happily against the broken 0013
  -- function — a call that dies of 42703 undefined_column looks identical to
  -- a call that was correctly refused. Pinning the message is what makes the
  -- unknown-service case below a real regression test rather than a
  -- tautology: against 0013 it fails, reporting the phantom column.

  -- Rejection: property belonging to a different client of the same operator.
  begin
    perform fn_book_walk(
      '99999999-0000-4000-d000-0000000000a2',  -- client A2's property
      '99999999-0000-4000-3000-000000000001', v_today, '09:00', '10:00',
      array['99999999-0000-4000-e000-00000000000a']::uuid[]);
    raise exception 'FAIL: booked against another client''s property';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%property does not belong to caller%' then
      raise exception 'FAIL: foreign property rejected for the wrong reason: %', sqlerrm;
    end if;
  end;

  -- Rejection: pet belonging to a different client.
  begin
    perform fn_book_walk(
      '99999999-0000-4000-d000-00000000000a',
      '99999999-0000-4000-3000-000000000001', v_today, '09:00', '10:00',
      array['99999999-0000-4000-e000-0000000000a2']::uuid[]);  -- client A2's pet
    raise exception 'FAIL: booked with another client''s pet';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%pet does not belong to caller%' then
      raise exception 'FAIL: foreign pet rejected for the wrong reason: %', sqlerrm;
    end if;
  end;

  -- Rejection: a service id that does not exist. THIS is the branch the
  -- phantom `active` predicate lived in. Against 0013 the call dies of
  -- undefined_column rather than reaching the intended raise, so this
  -- assertion is the negative-path regression test for B1.
  begin
    perform fn_book_walk(
      '99999999-0000-4000-d000-00000000000a',
      '99999999-0000-4000-3000-0000000000ff', v_today, '09:00', '10:00',
      array['99999999-0000-4000-e000-00000000000a']::uuid[]);
    raise exception 'FAIL: booked against an unknown service';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%unknown service%' then
      raise exception 'FAIL: unknown service rejected for the wrong reason (B1 regression?): %', sqlerrm;
    end if;
  end;

  -- Rejection: a date in the past.
  begin
    perform fn_book_walk(
      '99999999-0000-4000-d000-00000000000a',
      '99999999-0000-4000-3000-000000000001', v_today - 1, '09:00', '10:00',
      array['99999999-0000-4000-e000-00000000000a']::uuid[]);
    raise exception 'FAIL: booked a walk in the past';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%date must be today or later%' then
      raise exception 'FAIL: past date rejected for the wrong reason: %', sqlerrm;
    end if;
  end;

  -- Rejection: no pets.
  begin
    perform fn_book_walk(
      '99999999-0000-4000-d000-00000000000a',
      '99999999-0000-4000-3000-000000000001', v_today, '09:00', '10:00',
      array[]::uuid[]);
    raise exception 'FAIL: booked a walk with no pets';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    -- array_length on a zero-length array returns NULL, which is what the
    -- function's guard tests — so this also pins that behaviour.
    if sqlerrm not like '%at least one pet required%' then
      raise exception 'FAIL: empty pet array rejected for the wrong reason: %', sqlerrm;
    end if;
  end;

  -- Every rejection must leave nothing behind. The foreign-pet case is the
  -- one that matters: it inserts the walk and only then fails inside the pet
  -- loop, so this asserts PL/pgSQL's exception-block subtransaction actually
  -- rolled that insert back. Exactly one new row across all six calls.
  if (select count(*) from walks
       where client_id = '99999999-0000-4000-c000-00000000000a'
         and schedule_id is null) <> v_before + 1 then
    raise exception 'FAIL: expected exactly one new walk, got % (was %)',
      (select count(*) from walks
        where client_id = '99999999-0000-4000-c000-00000000000a'
          and schedule_id is null), v_before;
  end if;

  reset session authorization;
  raise notice 'fn_book_walk (0019): OK';
end $$;

-- ── Realtime walk-channel authorization (0020) ───────────────────────────
-- The live-GPS topic `walk:{id}` was public: readable AND writable by any
-- holder of the anon key (review H1). 0020 makes it a private channel gated
-- by realtime.messages policies. This asserts the full matrix on
-- fn_walk_channel_access — which is where the rule actually lives — and then
-- proves the two policies are wired to it, in both directions.
--
-- Both directions on purpose. A policy that denies everyone would pass a
-- suite that only checks that attackers are refused, and would take live GPS
-- off every real walk.
do $$
declare
  v_op_a    uuid := '99999999-0000-4000-a000-000000000001';
  v_op_b    uuid := '99999999-0000-4000-a000-000000000002';
  v_auth_a  uuid := '99999999-0000-4000-a000-000000000003';  -- client A's login
  v_auth_f2 uuid := '99999999-0000-4000-a000-000000000005';  -- client F2's login
  v_walk_a  uuid := '99999999-0000-4000-2000-000000000001';  -- op A / client A
  v_walk_b  uuid := '99999999-0000-4000-2000-0000000000b1';  -- op B / client F2
  v_topic_a text;
  v_topic_b text;
  v_seen    int;
begin
  v_topic_a := 'walk:' || v_walk_a;
  v_topic_b := 'walk:' || v_walk_b;

  -- A second tenant with a signed-in client, so "another operator's client"
  -- is a real persona and not an absence.
  insert into auth.users (id, email) values (v_auth_f2, 'smoke-client-f2@sanpo.test');
  insert into service_types (id, operator_id, name, duration_minutes, credit_cost)
  values ('99999999-0000-4000-3000-0000000000b1', v_op_b, 'Smoke B walk', 30, 1);
  insert into walks (id, operator_id, client_id, property_id, service_type_id,
                     scheduled_date, window_start, window_end, status)
  values (v_walk_b, v_op_b, '99999999-0000-4000-c000-0000000000f2',
          '99999999-0000-4000-d000-0000000000f2',
          '99999999-0000-4000-3000-0000000000b1',
          date '2026-07-01', '10:00', '11:00', 'in_progress');
  update clients set auth_user_id = v_auth_f2
   where id = '99999999-0000-4000-c000-0000000000f2';

  -- ── The rule itself ────────────────────────────────────────────────────
  -- receive, then send, for each persona against walk A's topic.
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_op_a), true);
  if not fn_walk_channel_access(v_topic_a, false) then
    raise exception 'FAIL: the walk''s own operator cannot receive on its topic';
  end if;
  if not fn_walk_channel_access(v_topic_a, true) then
    raise exception 'FAIL: the walk''s own operator cannot send on its topic';
  end if;

  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_auth_a), true);
  if not fn_walk_channel_access(v_topic_a, false) then
    raise exception 'FAIL: the walk''s own client cannot receive on its topic';
  end if;
  -- The client is an audience, not a participant: letting them send would let
  -- them fabricate the proof of service the product sells.
  if fn_walk_channel_access(v_topic_a, true) then
    raise exception 'FAIL: the client can SEND on the walk topic';
  end if;

  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_op_b), true);
  if fn_walk_channel_access(v_topic_a, false) then
    raise exception 'FAIL: a foreign operator can receive on another tenant''s walk';
  end if;
  if fn_walk_channel_access(v_topic_a, true) then
    raise exception 'FAIL: a foreign operator can SEND on another tenant''s walk';
  end if;

  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_auth_f2), true);
  if fn_walk_channel_access(v_topic_a, false) then
    raise exception 'FAIL: another operator''s client can receive on this walk';
  end if;
  -- ...and is still allowed on their own, so the denial above is tenancy and
  -- not a blanket refusal.
  if not fn_walk_channel_access(v_topic_b, false) then
    raise exception 'FAIL: a client cannot receive on their own walk topic';
  end if;

  -- Anonymous: no sub claim at all.
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  if fn_walk_channel_access(v_topic_a, false) then
    raise exception 'FAIL: an anonymous caller can receive on a walk topic';
  end if;

  -- ── Malformed and unknown topics ───────────────────────────────────────
  -- A cast error inside an RLS policy on a shared platform table would break
  -- every channel, not just ours, so these must return false rather than
  -- raise. Each is also a rejection in its own right.
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_op_a), true);
  if fn_walk_channel_access('walk:not-a-uuid', false) then
    raise exception 'FAIL: a malformed topic was authorized';
  end if;
  if fn_walk_channel_access('presence:' || v_walk_a, false) then
    raise exception 'FAIL: a non-walk topic namespace was authorized';
  end if;
  if fn_walk_channel_access('walk:99999999-0000-4000-2000-0000000000ff', false) then
    raise exception 'FAIL: a topic for a nonexistent walk was authorized';
  end if;
  if fn_walk_channel_access(null, false) then
    raise exception 'FAIL: a null topic was authorized';
  end if;

  -- ── The policies are actually wired to it ──────────────────────────────
  -- Everything above tests the function. These two prove realtime.messages
  -- consults it: without the policies the function could be perfect and the
  -- channel still wide open, which is precisely the shape of the original bug.
  insert into realtime.messages (topic, extension, event, payload, private)
  values (v_topic_a, 'broadcast', 'gps', '{"lat":1,"lng":2}'::jsonb, true);

  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_op_a), true);
  perform set_config('realtime.topic', v_topic_a, true);
  set local session authorization authenticated;
  select count(*) into v_seen from realtime.messages;
  if v_seen <> 1 then
    raise exception 'FAIL: the walk''s operator cannot read its own channel (saw % rows)', v_seen;
  end if;
  insert into realtime.messages (topic, extension, event, payload, private)
  values (v_topic_a, 'broadcast', 'gps', '{"lat":3,"lng":4}'::jsonb, true);
  reset session authorization;

  -- A foreign operator, joining the same topic, sees nothing and cannot send.
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_op_b), true);
  perform set_config('realtime.topic', v_topic_a, true);
  set local session authorization authenticated;
  select count(*) into v_seen from realtime.messages;
  if v_seen <> 0 then
    raise exception 'FAIL: a foreign operator read % rows from another tenant''s channel', v_seen;
  end if;
  begin
    insert into realtime.messages (topic, extension, event, payload, private)
    values (v_topic_a, 'broadcast', 'gps', '{"lat":0,"lng":0}'::jsonb, true);
    raise exception 'FAIL: a foreign operator SENT on another tenant''s channel';
  exception when insufficient_privilege then
    null;
  end;
  reset session authorization;

  -- The client of the walk may receive but not send, through the policies.
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_auth_a), true);
  perform set_config('realtime.topic', v_topic_a, true);
  set local session authorization authenticated;
  select count(*) into v_seen from realtime.messages;
  if v_seen < 1 then
    raise exception 'FAIL: the walk''s client cannot read its channel';
  end if;
  begin
    insert into realtime.messages (topic, extension, event, payload, private)
    values (v_topic_a, 'broadcast', 'ended', '{}'::jsonb, true);
    raise exception 'FAIL: the client SENT on the walk channel';
  exception when insufficient_privilege then
    null;
  end;
  reset session authorization;

  perform set_config('realtime.topic', '', true);
  raise notice 'realtime walk-channel authorization (0020): OK';
end $$;

-- ── Vault key identity and rewrap (0021) ─────────────────────────────────
-- The rotation's whole safety argument rests on these four functions, and on
-- key_id being underivable-from-anything-but-the-blob. The edge function holds
-- the key, so nothing here decrypts; this asserts the parts SQL is responsible
-- for.
do $$
declare
  v_op      uuid := '99999999-0000-4000-a000-000000000001';
  v_prop    uuid := '99999999-0000-4000-d000-00000000000a';
  v_cred    uuid := '99999999-0000-4000-f000-0000000000c1';
  v_kid_a   text := 'a1a2a3a4a5a6a7a8';
  v_kid_b   text := 'b1b2b3b4b5b6b7b8';
  v_blob_a  bytea;
  v_blob_b  bytea;
  v_before  bigint;
  v_ok      boolean;
  r         record;
begin
  -- A well-formed v2 blob under key A, and its replacement under key B.
  v_blob_a := '\x02'::bytea || decode(v_kid_a, 'hex') || decode(repeat('11', 12), 'hex')
              || decode(repeat('22', 16), 'hex');
  v_blob_b := '\x02'::bytea || decode(v_kid_b, 'hex') || decode(repeat('33', 12), 'hex')
              || decode(repeat('44', 16), 'hex');

  select total into v_before from fn_vault_census(v_kid_a);

  insert into access_credentials (id, operator_id, property_id, entry_method, ciphertext, label)
  values (v_cred, v_op, v_prop, 'door_code', v_blob_a, 'Smoke v2 credential');

  -- 1. key_id is derived from the bytes, not asserted by the writer.
  if (select key_id from access_credentials where id = v_cred) <> v_kid_a then
    raise exception 'FAIL: key_id was not derived from the ciphertext';
  end if;

  -- 2. It cannot be forged. Postgres refuses generated columns outright, which
  --    is a stronger guarantee than any grant or trigger, so the census can be
  --    trusted without trusting every writer.
  begin
    update access_credentials set key_id = 'deadbeefdeadbeef' where id = v_cred;
    raise exception 'FAIL: key_id was writable';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    -- Postgres puts "is a generated column" in DETAIL, not the message.
    if sqlerrm not like '%can only be updated to DEFAULT%' then
      raise exception 'FAIL: key_id rejected for the wrong reason: %', sqlerrm;
    end if;
  end;

  -- 3. A pre-v2 blob reports NULL rather than a plausible-looking id, so the
  --    census counts it as unreadable instead of silently claiming it is fine.
  --    (smoke's own fixture at the top of this file is exactly such a row.)
  if (select key_id from access_credentials
       where id = '99999999-0000-4000-f000-000000000001') is not null then
    raise exception 'FAIL: a pre-v2 blob was given a key id';
  end if;

  -- 4. The census adds up. This is the assertion that stops a rotation gate
  --    failing open: "on_other = 0" is also true when nothing is visible, so
  --    the parts must equal the whole.
  select * into r from fn_vault_census(v_kid_a);
  if r.total <> r.on_primary + r.on_other + r.unreadable then
    raise exception 'FAIL: census does not add up (% <> %+%+%)',
      r.total, r.on_primary, r.on_other, r.unreadable;
  end if;
  if r.on_primary < 1 then
    raise exception 'FAIL: census did not see the row it should have';
  end if;

  -- 5. The work queue selects rows not on the current key, and excludes them
  --    once they are.
  if not exists (select 1 from fn_vault_rewrap_batch(v_kid_b, 50) where id = v_cred) then
    raise exception 'FAIL: a row on the old key was not queued for rewrap';
  end if;
  if exists (select 1 from fn_vault_rewrap_batch(v_kid_a, 50) where id = v_cred) then
    raise exception 'FAIL: a row already on the current key was queued';
  end if;

  -- 6. Compare-and-swap: the happy path, then the same call replayed.
  select fn_vault_rewrap_apply(v_cred, v_blob_a, v_blob_b, v_kid_b) into v_ok;
  if not v_ok then raise exception 'FAIL: a correct rewrap was refused'; end if;
  if (select key_id from access_credentials where id = v_cred) <> v_kid_b then
    raise exception 'FAIL: key_id did not follow the rewrapped ciphertext';
  end if;

  select fn_vault_rewrap_apply(v_cred, v_blob_a, v_blob_b, v_kid_b) into v_ok;
  if v_ok then
    raise exception 'FAIL: a stale expectation was accepted — a concurrent rotation would be clobbered';
  end if;

  -- 7. A replacement under a different key than promised is refused, so a bug
  --    in the caller cannot store something nothing can read.
  begin
    perform fn_vault_rewrap_apply(v_cred, v_blob_b, v_blob_a, v_kid_b);
    raise exception 'FAIL: a replacement under the wrong key was accepted';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%expected%' then
      raise exception 'FAIL: wrong-key replacement rejected for the wrong reason: %', sqlerrm;
    end if;
  end;

  -- 8. And a non-v2 replacement.
  begin
    perform fn_vault_rewrap_apply(v_cred, v_blob_b, '\x0001'::bytea, v_kid_b);
    raise exception 'FAIL: a non-v2 replacement was accepted';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%not a v2 blob%' then
      raise exception 'FAIL: non-v2 replacement rejected for the wrong reason: %', sqlerrm;
    end if;
  end;

  -- 9. The canary is the per-environment key pin.
  if fn_vault_set_canary(v_blob_b) <> v_kid_b then
    raise exception 'FAIL: set_canary did not report the key it stored';
  end if;
  if (select key_id from vault_canary) <> v_kid_b then
    raise exception 'FAIL: canary key_id was not derived';
  end if;
  begin
    perform fn_vault_set_canary('\x00'::bytea);
    raise exception 'FAIL: a non-v2 canary was accepted — an unreadable pin is not a pin';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%not a v2 blob%' then
      raise exception 'FAIL: a non-v2 canary was accepted — rejected for the wrong reason: %', sqlerrm;
    end if;
  end;

  delete from access_credentials where id = v_cred;
  raise notice 'vault key identity + rewrap (0021): OK';
end $$;

-- The vault machinery is service-role only: an operator JWT must not be able
-- to census every tenant's credentials, queue a rewrap, or move a pin.
do $$
declare
  v_kid text := 'a1a2a3a4a5a6a7a8';
begin
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000000001","role":"authenticated"}', true);
  set local session authorization authenticated;

  begin
    perform * from fn_vault_census(v_kid);
    raise exception 'FAIL: an operator could run the vault census';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  begin
    perform * from fn_vault_rewrap_batch(v_kid, 1);
    raise exception 'FAIL: an operator could queue a vault rewrap';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  begin
    perform fn_vault_set_canary('\x02'::bytea);
    raise exception 'FAIL: an operator could move the vault key pin';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  -- key_id is not in the operator's column grant either: knowing which key
  -- wrote a row is operational metadata, not tenant data.
  begin
    perform key_id from access_credentials limit 1;
    raise exception 'FAIL: an operator could read key_id';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  begin
    perform * from vault_canary;
    raise exception 'FAIL: an operator could read the vault canary';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  reset session authorization;
  raise notice 'vault machinery is service-role only (0021): OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- fn_reverse_payment + reversal indexes (0023) — review B4
--
-- The negative-path cases assert the SPECIFIC message or the SPECIFIC row
-- count, not merely that something happened. This file's usual "anything
-- non-FAIL passes" idiom would have passed against the broken system: before
-- 0023 a reversal simply did not exist, so "no clawback occurred" and "the
-- clawback was correctly zero" are the same observation.
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_op   uuid := '99999999-0000-4000-a000-000000000001';
  v_cli  uuid := '99999999-0000-4000-c000-00000000000b';   -- rollover 'none'
  v_pay  uuid;
  r      record;
  v_bal  int;
  v_n    int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- ── 1. Full refund of a cycle invoice, credits untouched ───────────────
  perform fn_apply_invoice_paid(v_cli, 10, 'in_smoke_full', 9000, 'USD', null, true);
  select id into v_pay from payments
   where stripe_invoice_id = 'in_smoke_full' and status = 'succeeded';
  select credit_balance into v_bal from clients where id = v_cli;
  if v_bal < 10 then raise exception 'FAIL: setup expected >=10 credits, got %', v_bal; end if;

  select * into r from fn_reverse_payment(v_pay, 'refund', 9000, 'customer changed mind');
  if r.outcome <> 'reversed' then raise exception 'FAIL: expected reversed, got %', r.outcome; end if;
  if r.credits_reversed <> 10 then
    raise exception 'FAIL: full refund should claw back 10, clawed %', r.credits_reversed;
  end if;
  if r.credits_unrecovered <> 0 then
    raise exception 'FAIL: nothing should be unrecovered, got %', r.credits_unrecovered;
  end if;
  if (select status from payments where id = v_pay) <> 'refunded' then
    raise exception 'FAIL: a fully refunded payment must read refunded';
  end if;
  -- invariant 1: the balance moved via the ledger, not a direct write.
  if not exists (select 1 from credit_ledger
                  where client_id = v_cli and entry_type = 'adjust' and amount = -10) then
    raise exception 'FAIL: clawback did not go through the ledger';
  end if;

  -- ── 2. Replay of the same cumulative amount is a no-op ─────────────────
  select * into r from fn_reverse_payment(v_pay, 'refund', 9000, 'duplicate delivery');
  if r.outcome <> 'noop' then
    raise exception 'FAIL: replayed refund should be a noop, got % (clawed %)',
      r.outcome, r.credits_reversed;
  end if;
  select count(*) into v_n from credit_ledger
   where client_id = v_cli and entry_type = 'adjust' and amount = -10;
  if v_n <> 1 then raise exception 'FAIL: replay produced % clawback rows, expected 1', v_n; end if;

  -- ── 3. THE REGRESSION: a refunded invoice must never re-grant ──────────
  -- fn_apply_invoice_paid decided idempotency by looking for a SUCCEEDED
  -- payment on the invoice. Flipping the row to 'refunded' dropped it out of
  -- both that test and its partial unique index, so Stripe's redelivery (it
  -- retries for three days) granted a second cycle of credits.
  --
  -- Asserted on the LEDGER, not the balance: rollover 'none' wipes the
  -- balance before each grant, so the balance reads identically whether or
  -- not the second grant happened. Confirmed against the pre-0023 body — two
  -- grant rows — before this assertion was written.
  perform fn_apply_invoice_paid(v_cli, 10, 'in_smoke_full', 9000, 'USD', null, true);
  select count(*) into v_n from credit_ledger
   where entry_type = 'grant' and stripe_invoice_id = 'in_smoke_full';
  if v_n <> 1 then
    raise exception 'FAIL: replayed invoice.paid after a refund produced % grants, expected 1', v_n;
  end if;

  -- ── 4. Partial refund floors at the balance and reports the shortfall ──
  perform fn_apply_invoice_paid(v_cli, 10, 'in_smoke_part', 9000, 'USD', null, true);
  select id into v_pay from payments
   where stripe_invoice_id = 'in_smoke_part' and status = 'succeeded';
  insert into credit_ledger (operator_id, client_id, entry_type, amount, note)
    values (v_op, v_cli, 'debit', -9, 'smoke: spent on walks');

  select * into r from fn_reverse_payment(v_pay, 'refund', 4500, 'half back');
  -- half of 9000 bought half of 10 credits = 5 due; only 1 is left.
  if r.credits_reversed <> 1 or r.credits_unrecovered <> 4 then
    raise exception 'FAIL: expected clawed=1 unrecovered=4, got clawed=% unrecovered=%',
      r.credits_reversed, r.credits_unrecovered;
  end if;
  -- A half-refunded payment is not 'refunded'. There is no partial status and
  -- claiming the stronger one would overstate it; refunded_amount_pence carries it.
  if (select status from payments where id = v_pay) <> 'succeeded' then
    raise exception 'FAIL: a partial refund must not flip status to refunded';
  end if;
  if (select refunded_amount_pence from payments where id = v_pay) <> 4500 then
    raise exception 'FAIL: cumulative refunded amount not recorded';
  end if;
  if (select credit_balance from clients where id = v_cli) < 0 then
    raise exception 'FAIL: clawback drove the balance negative';
  end if;

  -- ── 5. Overage reversal moves money only (invariant 3) ─────────────────
  -- A walk is EITHER credit-funded OR charged, so an overage payment bought
  -- no credits and reversing it must leave the ledger completely alone.
  select count(*) into v_n from credit_ledger where client_id = v_cli;
  insert into payments (operator_id, client_id, type, amount_pence, currency, status)
    values (v_op, v_cli, 'overage', 2500, 'USD', 'succeeded') returning id into v_pay;
  select * into r from fn_reverse_payment(v_pay, 'dispute', 2500, 'chargeback');
  if r.credits_reversed <> 0 or r.needs_review then
    raise exception 'FAIL: overage reversal touched credits (clawed=% review=%)',
      r.credits_reversed, r.needs_review;
  end if;
  if (select count(*) from credit_ledger where client_id = v_cli) <> v_n then
    raise exception 'FAIL: overage reversal wrote a ledger row';
  end if;
  if (select status from payments where id = v_pay) <> 'disputed' then
    raise exception 'FAIL: a dispute must read disputed, not refunded';
  end if;

  -- ── 6. An untraceable grant is flagged, never guessed ──────────────────
  -- Grants written before 0023 carry no stripe_invoice_id. Reversal could
  -- reconstruct a number from the plan's current credits_per_cycle, which is
  -- wrong whenever the plan changed between the grant and the refund. It
  -- refuses instead.
  insert into payments (operator_id, client_id, type, amount_pence, currency,
                        status, stripe_invoice_id)
    values (v_op, v_cli, 'subscription', 9000, 'USD', 'succeeded', 'in_smoke_legacy')
    returning id into v_pay;
  select * into r from fn_reverse_payment(v_pay, 'refund', 9000, 'pre-0023 grant');
  if r.credits_reversed <> 0 or not r.needs_review then
    raise exception 'FAIL: untraceable grant should flag review and claw nothing, got clawed=% review=%',
      r.credits_reversed, r.needs_review;
  end if;
  if not (select reversal_needs_review from payments where id = v_pay) then
    raise exception 'FAIL: needs-review flag not persisted for manual reconciliation';
  end if;

  -- ── 7. Refuses to reverse more than was charged ────────────────────────
  begin
    perform fn_reverse_payment(v_pay, 'refund', 999999, 'too much');
    raise exception 'FAIL: reversed more than the charge';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%exceeds charged%' then
      raise exception 'FAIL: wrong error for over-reversal: %', sqlerrm;
    end if;
  end;

  -- ── 8. Rejects an unknown kind ─────────────────────────────────────────
  begin
    perform fn_reverse_payment(v_pay, 'clawback', 100, 'typo');
    raise exception 'FAIL: accepted an unknown reversal kind';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%kind must be refund or dispute%' then
      raise exception 'FAIL: wrong error for bad kind: %', sqlerrm;
    end if;
  end;

  raise notice 'fn_reverse_payment (0023): OK';
end $$;

-- Reversal is service-role only: an operator JWT must not be able to write
-- off their own client's debt, and neither may anon.
do $$
declare v_pay uuid;
begin
  select id into v_pay from payments limit 1;

  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000000001","role":"authenticated"}', true);
  begin
    perform fn_reverse_payment(v_pay, 'refund', 1, 'as operator');
    raise exception 'FAIL: an operator could reverse a payment';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  set local role anon;
  begin
    perform fn_reverse_payment(v_pay, 'refund', 1, 'as anon');
    raise exception 'FAIL: anon could reverse a payment';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  reset role;
  raise notice 'fn_reverse_payment is service-role only (0023): OK';
end $$;

-- L6 (0023): the auto-refund trigger was guarded on `old.status not in
-- (cancelled, no_show)`, which also matches a COMPLETED walk. Marking a
-- delivered walk no_show refunded the credit AND left credits_debited set,
-- so any re-completion would have been free. Narrowed to in_progress, and it
-- now zeroes credits_debited on the way out.
do $$
declare
  v_op    uuid := '99999999-0000-4000-a000-000000000001';
  v_cli   uuid := '99999999-0000-4000-c000-00000000000a';
  v_prop  uuid := '99999999-0000-4000-d000-00000000000a';
  v_walk  uuid;
  v_n     int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  insert into walks (id, operator_id, client_id, property_id, service_type_id,
                     scheduled_date, window_start, window_end,
                     status, credits_debited, origin_date)
  select gen_random_uuid(), v_op, v_cli, v_prop, st.id,
         date '2026-07-02', '10:00', '11:00', 'completed', 1, date '2026-07-02'
    from service_types st
   where st.operator_id = v_op and st.is_default
  returning id into v_walk;

  update walks set status = 'no_show' where id = v_walk;

  select count(*) into v_n from credit_ledger
   where walk_id = v_walk and note = 'auto refund: walk cancelled after debit';
  if v_n <> 0 then
    raise exception 'FAIL: a COMPLETED walk marked no_show was refunded (L6)';
  end if;

  -- and the live case it was actually written for still works
  insert into walks (id, operator_id, client_id, property_id, service_type_id,
                     scheduled_date, window_start, window_end,
                     status, credits_debited, origin_date)
  select gen_random_uuid(), v_op, v_cli, v_prop, st.id,
         date '2026-07-03', '10:00', '11:00', 'in_progress', 1, date '2026-07-03'
    from service_types st
   where st.operator_id = v_op and st.is_default
  returning id into v_walk;

  update walks set status = 'cancelled' where id = v_walk;

  select count(*) into v_n from credit_ledger
   where walk_id = v_walk and note = 'auto refund: walk cancelled after debit';
  if v_n <> 1 then
    raise exception 'FAIL: cancelling a debited in-progress walk did not refund (% rows)', v_n;
  end if;
  if (select credits_debited from walks where id = v_walk) <> 0 then
    raise exception 'FAIL: refunded walk still claims credits_debited — a re-completion would be free';
  end if;

  raise notice 'auto-refund trigger narrowed to in_progress (0023, L6): OK';
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- Stripe Connect: the operator is the merchant of record (0024, review B5)
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_op1 uuid := '99999999-0000-4000-a000-000000000001';
  v_op2 uuid := '99999999-0000-4000-a000-000000000002';
begin
  -- Not connected by default. The money paths read this predicate, so the
  -- default must be "cannot charge" rather than "unknown".
  if fn_operator_can_charge(v_op1) then
    raise exception 'FAIL: a brand-new operator could take payments';
  end if;

  update operators set stripe_account_id = 'acct_smoke_1' where id = v_op1;

  -- An account alone is not enough: Stripe can hold charges while it reviews.
  if fn_operator_can_charge(v_op1) then
    raise exception 'FAIL: could charge before Stripe enabled charges';
  end if;

  update operators set stripe_charges_enabled = true where id = v_op1;
  if not fn_operator_can_charge(v_op1) then
    raise exception 'FAIL: a connected, charges-enabled operator cannot charge';
  end if;

  -- payouts_enabled being false is a payout hold, not a charge hold. Refusing
  -- service then would punish the operator for a review they cannot hurry.
  update operators set stripe_payouts_enabled = false where id = v_op1;
  if not fn_operator_can_charge(v_op1) then
    raise exception 'FAIL: a payout hold stopped charges';
  end if;

  -- Two operators must never share a connected account: that would pool their
  -- revenue into one bank account, which is the defect Connect removes.
  begin
    update operators set stripe_account_id = 'acct_smoke_1' where id = v_op2;
    raise exception 'FAIL: two operators shared one Stripe account';
  exception when unique_violation then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  raise notice 'connect account state (0024): OK';
end $$;

-- The operator may READ their Connect state but never WRITE it. These columns
-- are assertions about what Stripe believes; an operator who could set
-- stripe_charges_enabled by hand could route a client's money to an account
-- Stripe had suspended.
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000000001","role":"authenticated"}', true);

  -- readable
  perform stripe_account_id, stripe_charges_enabled from operators
   where id = '99999999-0000-4000-a000-000000000001';

  begin
    update operators set stripe_charges_enabled = true
     where id = '99999999-0000-4000-a000-000000000001';
    raise exception 'FAIL: an operator could enable their own charges';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  begin
    update operators set stripe_account_id = 'acct_theirs'
     where id = '99999999-0000-4000-a000-000000000001';
    raise exception 'FAIL: an operator could repoint their Stripe account';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  reset role;
  raise notice 'connect state is read-only to operators (0024): OK';
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- Subscription state gates billable work (0026, review H9 + owner decision)
--
-- The materializer consulted ONE subscription predicate ('<> paused') and
-- fn_book_walk consulted NONE — it gated on clients.status, which is the
-- lifecycle column, not the billing one. A cancelled or past-due client kept
-- having walks generated nightly and could still self-book.
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_op    uuid := '99999999-0000-4000-a000-000000000001';
  v_cli   uuid := '99999999-0000-4000-c000-00000000000b';
  v_prop  uuid;
  v_sched uuid;
  v_before int;
  v_after  int;
  v_state  text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  insert into properties (id, operator_id, client_id, label)
  values (gen_random_uuid(), v_op, v_cli, 'B home 0026') returning id into v_prop;

  insert into recurring_schedules (operator_id, client_id, property_id,
                                   service_type_id, days_of_week, window_start,
                                   window_end, start_date, active)
  select v_op, v_cli, v_prop, st.id, array[1,2,3,4,5,6,7], '09:00', '10:00',
         current_date, true
    from service_types st where st.operator_id = v_op and st.is_default
  returning id into v_sched;

  -- Each non-serving state must generate ZERO walks. Asserted per state
  -- rather than once, because the predicate is an allow-list and a mistake in
  -- it would let exactly one state through.
  foreach v_state in array array['cancelled', 'past_due', 'paused'] loop
    delete from walks where schedule_id = v_sched;
    update clients set subscription_status = v_state::subscription_status where id = v_cli;
    perform fn_materialize_walks(7);
    select count(*) into v_after from walks where schedule_id = v_sched;
    if v_after <> 0 then
      raise exception 'FAIL: subscription_status % generated % walks', v_state, v_after;
    end if;
  end loop;

  -- ...and an active one still does, or the gate is just broken.
  delete from walks where schedule_id = v_sched;
  update clients set subscription_status = 'active' where id = v_cli;
  perform fn_materialize_walks(7);
  select count(*) into v_after from walks where schedule_id = v_sched;
  if v_after = 0 then
    raise exception 'FAIL: an active subscription generated no walks — the gate is too tight';
  end if;

  -- 'none' must keep working. It is the state of a client who never
  -- subscribed, whom the operator may bill outside Sanpo; excluding it would
  -- have broken every pre-subscription client the moment 0026 applied.
  delete from walks where schedule_id = v_sched;
  update clients set subscription_status = 'none' where id = v_cli;
  perform fn_materialize_walks(7);
  select count(*) into v_after from walks where schedule_id = v_sched;
  if v_after = 0 then
    raise exception 'FAIL: subscription_status none generated no walks';
  end if;

  delete from walks where schedule_id = v_sched;
  delete from recurring_schedules where id = v_sched;
  delete from properties where id = v_prop;
  update clients set subscription_status = 'active' where id = v_cli;
  raise notice 'materializer honours subscription state (0026): OK';
end $$;

-- fn_book_walk refuses a non-serving subscription. Runs as the CLIENT, since
-- the function reads auth.uid().
do $$
declare
  v_cli   uuid := '99999999-0000-4000-c000-00000000000a';
  v_prop  uuid := '99999999-0000-4000-d000-00000000000a';
  v_svc   uuid;
  v_pet   uuid;
  v_walk  uuid;
  v_state text;
begin
  select id into v_svc from service_types
   where operator_id = '99999999-0000-4000-a000-000000000001' and is_default;
  select id into v_pet from pets where client_id = v_cli limit 1;
  if v_pet is null then
    insert into pets (operator_id, client_id, name)
    values ('99999999-0000-4000-a000-000000000001', v_cli, 'Smoke pet 0026')
    returning id into v_pet;
  end if;

  foreach v_state in array array['cancelled', 'past_due'] loop
    update clients set subscription_status = v_state::subscription_status where id = v_cli;

    set local role authenticated;
    perform set_config('request.jwt.claims',
      '{"sub":"99999999-0000-4000-a000-000000000003","role":"authenticated"}', true);
    begin
      perform fn_book_walk(v_prop, v_svc, current_date + 1, '09:00', '10:00', array[v_pet]);
      raise exception 'FAIL: a % client booked a walk', v_state;
    exception when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      -- The specific message, not merely "something was refused". Before 0026
      -- this function raised nothing at all for these states, and a booking
      -- that fails for an unrelated reason must not read as a pass.
      if sqlerrm not like '%booking is closed until it is settled%' then
        raise exception 'FAIL: wrong refusal for %: %', v_state, sqlerrm;
      end if;
    end;
    reset role;
  end loop;

  -- An active client still books, or the gate is simply broken.
  update clients set subscription_status = 'active' where id = v_cli;
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000000003","role":"authenticated"}', true);
  v_walk := fn_book_walk(v_prop, v_svc, current_date + 1, '09:00', '10:00', array[v_pet]);
  if v_walk is null then raise exception 'FAIL: an active client could not book'; end if;
  reset role;

  raise notice 'fn_book_walk honours subscription state (0026): OK';
end $$;

-- Rollover belongs to a renewal, never to the first invoice. On policy 'none'
-- fn_apply_rollover books an expiry for the WHOLE balance, so running it on
-- subscription_create destroyed any credit granted before billing started.
do $$
declare
  v_cli uuid := '99999999-0000-4000-c000-00000000000b';   -- rollover 'none'
  v_bal int;
  v_expiries int;
  v_after_expiries int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- An operator grants a goodwill balance before the first invoice.
  perform fn_grant_credits(v_cli, 6, 'smoke: pre-subscription goodwill');
  select credit_balance into v_bal from clients where id = v_cli;
  if v_bal < 6 then raise exception 'FAIL: setup grant did not land (%)', v_bal; end if;

  -- Deltas, not ambient conditions. This client already carries expiry rows
  -- from the reversal block earlier in this same transaction, so "an expiry
  -- exists" and "an expiry happened recently" are both true regardless — the
  -- first draft of this test failed for exactly that reason.
  select count(*) into v_expiries from credit_ledger
   where client_id = v_cli and entry_type = 'expiry';

  -- First invoice: grants the cycle and must NOT expire the goodwill.
  perform fn_apply_invoice_paid(v_cli, 5, 'in_first_0026', 9000, 'USD', null, false);

  select count(*) into v_after_expiries from credit_ledger
   where client_id = v_cli and entry_type = 'expiry';
  if v_after_expiries <> v_expiries then
    raise exception 'FAIL: the first invoice ran rollover and expired % credit lot(s)',
      v_after_expiries - v_expiries;
  end if;
  if (select credit_balance from clients where id = v_cli) <> v_bal + 5 then
    raise exception 'FAIL: expected the goodwill (%) plus a 5-credit cycle, got %',
      v_bal, (select credit_balance from clients where id = v_cli);
  end if;

  -- A renewal DOES roll over, or the flag has simply switched the feature off.
  perform fn_apply_invoice_paid(v_cli, 5, 'in_renew_0026', 9000, 'USD', null, true);
  select count(*) into v_after_expiries from credit_ledger
   where client_id = v_cli and entry_type = 'expiry';
  if v_after_expiries = v_expiries then
    raise exception 'FAIL: a renewal did not run rollover at all';
  end if;

  raise notice 'rollover runs on renewals only (0026): OK';
end $$;

-- A plan must state what an extra walk costs (owner decision).
do $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  begin
    insert into plans (operator_id, name, credits_per_cycle, price_pence, cycle,
                       rollover_policy, overage_rate_pence)
    values ('99999999-0000-4000-a000-000000000001', 'Zero overage', 4, 4000,
            'monthly', 'none', 0);
    raise exception 'FAIL: a plan with a zero overage rate was accepted';
  exception when check_violation then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;
  raise notice 'overage rate must be positive (0026): OK';
end $$;


-- ═══ GPS gap marks (0027) ════════════════════════════════════════════════
-- The column must exist, default to "no gap", and be writable by the
-- operator's own device — which is the only thing that can observe one, since
-- the stored timestamps cannot tell a suspended watch apart from an operator
-- standing at a crossing.
do $$
declare
  v_walk uuid;
  v_service uuid;
  v_default boolean;
  v_marked boolean;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into v_service from service_types
   where operator_id = '99999999-0000-4000-a000-000000000001' and is_default;

  insert into walks (operator_id, client_id, property_id, service_type_id,
                     scheduled_date, window_start, window_end, status)
  values ('99999999-0000-4000-a000-000000000001',
          '99999999-0000-4000-c000-00000000000a',
          '99999999-0000-4000-d000-00000000000a',
          v_service, date '2026-07-09', '10:00', '11:00', 'in_progress')
  returning id into v_walk;

  -- An insert that says nothing about gaps asserts there was none. Every row
  -- written before 0027 means exactly that, which is why nothing is
  -- backfilled: a guessed gap is indistinguishable from an observed one.
  insert into walk_gps_points (walk_id, operator_id, recorded_at, lat, lng)
  values (v_walk, '99999999-0000-4000-a000-000000000001', now(), 51.5, -0.1)
  returning gap_before into v_default;
  if v_default is not false then
    raise exception 'FAIL: gap_before defaulted to % rather than false', v_default;
  end if;

  insert into walk_gps_points (walk_id, operator_id, recorded_at, lat, lng, gap_before)
  values (v_walk, '99999999-0000-4000-a000-000000000001', now(), 51.51, -0.1, true)
  returning gap_before into v_marked;
  if v_marked is not true then
    raise exception 'FAIL: gap_before did not persist';
  end if;

  if (select count(*) from walk_gps_points where walk_id = v_walk and gap_before) <> 1 then
    raise exception 'FAIL: expected exactly one marked point on the trail';
  end if;

  raise notice 'gps gap marks (0027): OK';
end $$;


-- ═══ Nightly job schedule + heartbeat (0028) ═════════════════════════════
-- The job that generates every walk on every calendar, and runs the daily
-- credit-expiry sweep, used to exist only as a hand-typed dashboard entry.
do $$
declare
  v_job record;
begin
  select jobname, schedule, command into v_job
    from cron.job where jobname = 'sanpo-nightly';
  if not found then
    raise exception 'FAIL: no sanpo-nightly cron job — the schedule is unversioned again';
  end if;
  if v_job.schedule <> '0 3 * * *' then
    raise exception 'FAIL: sanpo-nightly runs on % rather than 0 3 * * *', v_job.schedule;
  end if;
  if v_job.command not like '%fn_run_nightly_jobs%' then
    raise exception 'FAIL: sanpo-nightly runs "%" — not the nightly entry point', v_job.command;
  end if;
  raise notice 'nightly cron job is scheduled (0028): OK';
end $$;

-- The run leaves a row behind, which is the only way anything can answer
-- "did it run last night?".
do $$
declare
  v_before int;
  v_result jsonb;
  v_row record;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select count(*) into v_before from job_runs where job_name = 'nightly';

  v_result := fn_run_nightly_jobs(14);

  if (select count(*) from job_runs where job_name = 'nightly') <> v_before + 1 then
    raise exception 'FAIL: the run recorded no heartbeat row';
  end if;

  -- By id, never by timestamp: started_at defaults to now(), which is the
  -- TRANSACTION start, so every row written in this smoke run carries the
  -- same one and `order by started_at desc` picks an arbitrary row. That is
  -- how the first version of the block below passed against the bug.
  select * into v_row from job_runs where id = (v_result ->> 'run_id')::uuid;
  if not found then
    raise exception 'FAIL: the result run_id does not match any heartbeat row';
  end if;
  if not v_row.ok then
    raise exception 'FAIL: a clean run was recorded as not ok (%)', v_row.error;
  end if;
  if v_row.finished_at is null then
    raise exception 'FAIL: a completed run has no finished_at';
  end if;
  if (v_row.detail ->> 'horizon_days')::int <> 14 then
    raise exception 'FAIL: the heartbeat did not record the horizon it used';
  end if;
  if v_result ? 'expiry_error' is false then
    raise exception 'FAIL: the result does not carry expiry_error';
  end if;

  raise notice 'nightly run records a heartbeat (0028): OK';
end $$;

-- 0036 · a clean nightly run records NO error.
--
-- This sits HERE, above the block that breaks `fn_expire_credits` for the rest
-- of the transaction, because a clean run is the only place `error is null`
-- can be asserted — and that assertion is load-bearing: 0036 changed
-- `error = v_expiry_error` to `nullif(concat_ws(' | ', …), '')` so two failing
-- sweeps cannot hide behind each other, and without the `nullif` a quiet night
-- would record the empty string instead of null.
--
-- That the sweep is actually CALLED is proved with the 0036 fixtures further
-- down, by a stale walk the nightly run has to flag. Asserting the reporting
-- key here would not prove it: `v_stale_walks` initialises to 0, so a
-- nightly run with the sweep deleted outright still reports the key.
do $$
declare
  v_result jsonb;
  v_row record;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_result := fn_run_nightly_jobs(14);

  select * into v_row from job_runs where id = (v_result ->> 'run_id')::uuid;
  if not v_row.ok then
    raise exception 'FAIL: the nightly run went not-ok with the sweep wired in (%)', v_row.error;
  end if;
  if v_row.error is not null then
    raise exception 'FAIL: a clean run recorded "%" instead of no error', v_row.error;
  end if;

  raise notice 'a clean nightly run records no error (0036): OK';
end $$;

-- The fix, stated as a test: a failing expiry sweep must NOT stop walks being
-- generated, and must NOT be silent. The old code did the first and got the
-- second exactly backwards — `if (!sweep.error) expired = …` meant a
-- permanently failing sweep read identically to a quiet night, so clients kept
-- credits they had been billed for and stopped paying overage.
do $$
declare
  v_result jsonb;
  v_row record;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- Break the sweep for the duration of this transaction. The outer rollback
  -- puts the real one back.
  create or replace function fn_expire_credits() returns int
  language plpgsql security definer set search_path = public as $broken$
  begin
    raise exception 'simulated expiry failure';
  end;
  $broken$;

  -- A different horizon, so this run generates walks the earlier ones did not
  -- already create: "created > 0" has to mean work happened, not that an
  -- idempotent no-op returned zero.
  v_result := fn_run_nightly_jobs(21);

  if (v_result ->> 'expiry_error') is null then
    raise exception 'FAIL: the sweep failure was swallowed — expiry_error is null';
  end if;
  if (v_result ->> 'expiry_error') not like '%simulated expiry failure%' then
    raise exception 'FAIL: expiry_error does not name the failure: %', v_result ->> 'expiry_error';
  end if;
  if (v_result ->> 'created')::int = 0 then
    raise exception 'FAIL: a failing sweep stopped walk generation';
  end if;

  select * into v_row from job_runs where id = (v_result ->> 'run_id')::uuid;
  if v_row.ok then
    raise exception 'FAIL: a run whose sweep failed was recorded as ok';
  end if;
  if v_row.error is null then
    raise exception 'FAIL: the heartbeat row did not record the error';
  end if;

  raise notice 'a failing expiry sweep is loud, not fatal (0028): OK';
end $$;

-- Staleness has to fail CLOSED. A project where the job has never run is
-- precisely the state this check exists to catch, so "no successful run" must
-- read as stale rather than as unknown.
do $$
declare
  v_stale boolean;
  v_last timestamptz;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select stale into v_stale from fn_job_health() where job_name = 'nightly';
  if v_stale then
    raise exception 'FAIL: a run seconds ago was reported stale';
  end if;

  -- Older than the window: what a cron that stopped firing looks like.
  update job_runs set started_at = now() - interval '30 hours' where job_name = 'nightly';
  select stale, last_success into v_stale, v_last
    from fn_job_health() where job_name = 'nightly';
  if not v_stale then
    raise exception 'FAIL: a 30-hour-old last success was not reported stale';
  end if;

  -- Never run at all: a fresh project, or one restored without the schedule.
  delete from job_runs;
  select stale, last_success into v_stale, v_last
    from fn_job_health() where job_name = 'nightly';
  if not v_stale then
    raise exception 'FAIL: a job that has NEVER succeeded was not reported stale';
  end if;
  if v_last is not null then
    raise exception 'FAIL: last_success should be null when nothing has ever succeeded';
  end if;

  raise notice 'job health fails closed (0028): OK';
end $$;

-- Same rule as every other cross-tenant function (invariant 5).
--
-- `set local role` is load-bearing, not decoration. fn_is_service_session()
-- also returns true for `session_user = 'postgres'`, which is what psql
-- connects as — so setting request.jwt.claims alone leaves the guard
-- satisfied and the block passes without testing anything.
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000000001","role":"authenticated"}', true);
  begin
    perform fn_run_nightly_jobs(14);
    raise exception 'FAIL: an operator ran the nightly job';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  set local role anon;
  begin
    perform fn_run_nightly_jobs(14);
    raise exception 'FAIL: anon ran the nightly job';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  -- The heartbeat is not readable by the API roles either: it is a
  -- cross-tenant table, and every row names how much work every operator
  -- had generated for them.
  begin
    perform count(*) from job_runs;
    raise exception 'FAIL: anon read the job_runs heartbeat';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  raise notice 'nightly job is service-role only (0028): OK';
end $$;


-- ═══ Email delivery state (0029) ═════════════════════════════════════════
-- `notifications` recorded whether the in-app bell had a row and nothing about
-- whether the email ever left. A Resend outage lost it permanently with
-- nothing on the row to show it.
do $$
declare
  v_n uuid;
  v_skipped uuid;
  v_status email_delivery_status;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  insert into notifications (operator_id, client_id, type, title, body)
  values ('99999999-0000-4000-a000-000000000001',
          '99999999-0000-4000-c000-00000000000a',
          'walk_complete', 'Walk report ready', 'test')
  returning id, email_status into v_n, v_status;

  -- A fresh row is owed an email. Anything else and the backlog cannot find it.
  if v_status <> 'pending' then
    raise exception 'FAIL: a new notification starts as % rather than pending', v_status;
  end if;
  if not exists (select 1 from fn_notification_backlog() where id = v_n) then
    raise exception 'FAIL: a pending notification is not in the backlog';
  end if;

  -- Sent leaves the backlog — but since 0049 "sent" means BOTH channels are
  -- settled, not just email. A row whose email went out and whose push has
  -- never been attempted is still owed a push, and the predicate says so;
  -- asserting on email alone here would now be asserting the old semantics.
  update notifications set email_status = 'sent', email_sent_at = now(), email_attempts = 1
   where id = v_n;
  if not exists (select 1 from fn_notification_backlog() where id = v_n) then
    raise exception 'FAIL: a row owed a push left the backlog because its email was sent (0049)';
  end if;
  update notifications set push_status = 'skipped' where id = v_n;
  if exists (select 1 from fn_notification_backlog() where id = v_n) then
    raise exception 'FAIL: a notification with both channels settled is still in the backlog';
  end if;

  -- Skipped is TERMINAL. An operator-only notification, or a client with no
  -- address, must never be retried — retrying forever is the failure mode of a
  -- naive "sent_at is null" sweep.
  --
  -- A FRESH row, deliberately: reusing the one above would leave email_sent_at
  -- set from the 'sent' step, so a naive sweep would exclude it for the wrong
  -- reason and this assertion would pass against the very implementation it
  -- exists to reject. Confirmed: it did.
  insert into notifications (operator_id, client_id, type, title, body, email_status)
  values ('99999999-0000-4000-a000-000000000001', null,
          'walk_scheduled', 'Operator-only', 'test', 'skipped')
  returning id into v_skipped;
  -- Settle the push channel too, or this row sits in the backlog for a reason
  -- that has nothing to do with the rule under test (0049).
  update notifications set push_status = 'skipped' where id = v_skipped;
  if exists (select 1 from fn_notification_backlog() where id = v_skipped) then
    raise exception 'FAIL: a skipped notification is in the retry backlog';
  end if;

  -- Failed is retryable. Push stays settled from above, so this assertion is
  -- about the EMAIL channel, which is what it claims to be about.
  update notifications set email_status = 'failed', email_attempts = 1,
         email_last_error = 'resend 500' where id = v_n;
  if not exists (select 1 from fn_notification_backlog() where id = v_n) then
    raise exception 'FAIL: a failed notification is not retryable';
  end if;

  -- 0049, Codex review on PR #85: a row whose EMAIL succeeded and whose PUSH
  -- failed is still owed something. The predicate filtered on email_status
  -- alone, so such a row was never selected again and stayed failed forever —
  -- "retryable" written down and connected to nothing.
  update notifications
     set email_status = 'sent', email_attempts = 1, email_last_error = null,
         push_status = 'failed', push_attempts = 1
   where id = v_n;
  if not exists (select 1 from fn_notification_backlog() where id = v_n) then
    raise exception 'FAIL: a notification owed only a PUSH retry is not in the backlog (0049)';
  end if;

  -- And both terminal means done: neither channel is owed anything.
  update notifications set push_status = 'sent', push_sent_at = now() where id = v_n;
  if exists (select 1 from fn_notification_backlog() where id = v_n) then
    raise exception 'FAIL: a fully delivered notification is still in the backlog (0049)';
  end if;

  -- The attempt ceiling applies per channel, or a push that will never
  -- succeed is retried every night forever (the 0029 rule).
  update notifications set push_status = 'failed', push_attempts = 99 where id = v_n;
  if exists (select 1 from fn_notification_backlog() where id = v_n) then
    raise exception 'FAIL: a push past the attempt ceiling is still retried (0049)';
  end if;

  raise notice 'email delivery states (0029) + push backlog (0049): OK';
end $$;

-- Retrying has to stop. Without a bound, a permanently-rejected recipient is
-- attempted every night forever and the backlog never empties.
do $$
declare
  v_n uuid;
  v_abandoned int;
  v_err text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  delete from notifications
   where operator_id = '99999999-0000-4000-a000-000000000001'
     and title = 'Walk report ready';

  -- `push_status = 'skipped'` settles the OTHER channel, so this block is
  -- about the email attempt ceiling — which is what it claims to be about.
  -- Without it 0049's widened backlog selects the row for its never-attempted
  -- push and the assertion fails for a reason unrelated to the rule.
  insert into notifications (operator_id, client_id, type, title, body,
                             email_status, email_attempts, email_last_error,
                             push_status)
  values ('99999999-0000-4000-a000-000000000001',
          '99999999-0000-4000-c000-00000000000a',
          'walk_complete', 'Attempt ceiling', 'test', 'failed', 5, 'resend 422',
          'skipped')
  returning id into v_n;

  if exists (select 1 from fn_notification_backlog() where id = v_n) then
    raise exception 'FAIL: a row at the attempt ceiling is still being retried';
  end if;

  v_abandoned := fn_expire_notification_backlog();
  if v_abandoned < 1 then
    raise exception 'FAIL: the ceiling row was not marked abandoned';
  end if;
  select email_last_error into v_err from notifications where id = v_n;
  if v_err not like '%gave up after%' then
    raise exception 'FAIL: the row does not say it was given up on: %', v_err;
  end if;

  -- Idempotent: a second night must not append a second give-up note forever.
  if fn_expire_notification_backlog() <> 0 then
    raise exception 'FAIL: expiring the backlog twice abandoned the same row again';
  end if;

  -- 0049, Codex review on PR #85: the push channel has to give up VISIBLY
  -- too. The widened backlog excludes a push past the ceiling, so without
  -- this the row just vanishes from the drain — no note, no abandoned count,
  -- `push_status` left 'failed' forever with nothing that will ever look at
  -- it again. The whole argument for four states is that a row says what
  -- happened to it.
  update notifications
     set push_status = 'failed', push_attempts = 99, push_last_error = 'fcm 500'
   where id = v_n;
  if fn_expire_notification_backlog() < 1 then
    raise exception 'FAIL: a push past the attempt ceiling was not abandoned (0049)';
  end if;
  select push_last_error into v_err from notifications where id = v_n;
  if v_err not like '%gave up after%' then
    raise exception 'FAIL: the push does not say it was given up on (0049): %', v_err;
  end if;
  -- Idempotent, for the same reason the email half is.
  if fn_expire_notification_backlog() <> 0 then
    raise exception 'FAIL: expiring twice abandoned the same push again (0049)';
  end if;

  raise notice 'email retry bound and give-up note (0029) + push (0049): OK';
end $$;

-- A row older than the retry window is abandoned too: an email about a walk
-- three weeks ago should not suddenly arrive.
do $$
declare
  v_n uuid;
  v_err text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into notifications (operator_id, client_id, type, title, body,
                             email_status, email_attempts, created_at)
  values ('99999999-0000-4000-a000-000000000001',
          '99999999-0000-4000-c000-00000000000a',
          'walk_complete', 'Stale', 'test', 'failed', 1, now() - interval '5 days')
  returning id into v_n;

  if exists (select 1 from fn_notification_backlog() where id = v_n) then
    raise exception 'FAIL: a 5-day-old notification is still being retried';
  end if;
  perform fn_expire_notification_backlog();
  select email_last_error into v_err from notifications where id = v_n;
  if v_err not like '%aged out%' then
    raise exception 'FAIL: the stale row does not say why it was abandoned: %', v_err;
  end if;

  raise notice 'stale notifications age out (0029): OK';
end $$;

-- The nightly job reports what is still owed.
do $$
declare
  v_result jsonb;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into notifications (operator_id, client_id, type, title, body)
  values ('99999999-0000-4000-a000-000000000001',
          '99999999-0000-4000-c000-00000000000a',
          'payment_failed', 'Card declined', 'test');

  v_result := fn_run_nightly_jobs(14);
  if (v_result ->> 'email_backlog')::int < 1 then
    raise exception 'FAIL: the nightly job reports no email backlog when one exists';
  end if;
  if v_result ? 'emails_abandoned' is false then
    raise exception 'FAIL: the nightly job does not report what it gave up on';
  end if;
  raise notice 'nightly job reports the email backlog (0029): OK';
end $$;

-- ── 0036 · abandoned walks ───────────────────────────────────────────────
-- Review M28. `complete-walk` is the only exit from `in_progress`, so a walk
-- the operator never ended sits there forever: never billed, never reported,
-- and invisible because Today fetches only today's date.
--
-- Every assertion here is about the SWEEP'S BOUNDARIES rather than about it
-- doing something. A sweep that flags everything would satisfy "it flagged the
-- old walk" and would be far worse than the bug: it would put fresh, correct,
-- in-progress walks — the one the operator is on right now — into the
-- needs-attention list on every nightly run.
do $$
declare
  v_service uuid;
  v_fresh uuid;
  v_stale uuid;
  v_done uuid;
  v_flagged int;
  v_first timestamptz;
  v_second timestamptz;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into v_service from service_types
   where operator_id = '99999999-0000-4000-a000-000000000001' and is_default;

  -- Started ten minutes ago: the operator is on the doorstep.
  insert into walks (operator_id, client_id, property_id, service_type_id,
                     scheduled_date, window_start, window_end, status, started_at)
  values ('99999999-0000-4000-a000-000000000001',
          '99999999-0000-4000-c000-00000000000a',
          '99999999-0000-4000-d000-00000000000a',
          v_service, current_date, '10:00', '11:00', 'in_progress',
          now() - interval '10 minutes')
  returning id into v_fresh;

  -- Started yesterday morning and never ended.
  insert into walks (operator_id, client_id, property_id, service_type_id,
                     scheduled_date, window_start, window_end, status, started_at)
  values ('99999999-0000-4000-a000-000000000001',
          '99999999-0000-4000-c000-00000000000a',
          '99999999-0000-4000-d000-00000000000a',
          v_service, current_date - 1, '10:00', '11:00', 'in_progress',
          now() - interval '26 hours')
  returning id into v_stale;

  -- Long-running but FINISHED. `status`, not age, is what makes a walk stale;
  -- a sweep keyed on `started_at` alone would mark completed history.
  insert into walks (operator_id, client_id, property_id, service_type_id,
                     scheduled_date, window_start, window_end, status,
                     started_at, ended_at)
  values ('99999999-0000-4000-a000-000000000001',
          '99999999-0000-4000-c000-00000000000a',
          '99999999-0000-4000-d000-00000000000a',
          v_service, current_date - 1, '10:00', '11:00', 'completed',
          now() - interval '26 hours', now() - interval '25 hours')
  returning id into v_done;

  v_flagged := fn_sweep_abandoned_walks(6);
  if v_flagged < 1 then
    raise exception 'FAIL: the sweep flagged nothing when a 26-hour walk is open';
  end if;

  select abandoned_at into v_first from walks where id = v_stale;
  if v_first is null then
    raise exception 'FAIL: a walk open for 26 hours was not flagged';
  end if;
  if (select abandoned_at from walks where id = v_fresh) is not null then
    raise exception 'FAIL: a walk started ten minutes ago was flagged as abandoned';
  end if;
  if (select abandoned_at from walks where id = v_done) is not null then
    raise exception 'FAIL: a completed walk was flagged as abandoned';
  end if;

  -- Idempotent, and specifically NOT re-stamping. `abandoned_at` answers "how
  -- long has this been sitting there"; a sweep that refreshed it every night
  -- would answer "since yesterday" forever, and the walk would look new.
  perform pg_sleep(0.01);
  if fn_sweep_abandoned_walks(6) <> 0 then
    raise exception 'FAIL: the second sweep re-flagged an already-flagged walk';
  end if;
  select abandoned_at into v_second from walks where id = v_stale;
  if v_second <> v_first then
    raise exception 'FAIL: the second sweep moved abandoned_at from % to %', v_first, v_second;
  end if;

  -- The status is deliberately untouched: completing means billing, and the
  -- operator must still be able to finish this walk with the real numbers.
  if (select status from walks where id = v_stale) <> 'in_progress' then
    raise exception 'FAIL: the sweep changed the walk status — it must stay completable';
  end if;

  -- A walk with no `started_at` never began, so there is nothing to abandon.
  update walks set abandoned_at = null, started_at = null where id = v_stale;
  if fn_sweep_abandoned_walks(6) <> 0 then
    raise exception 'FAIL: a walk that never started was flagged as abandoned';
  end if;

  update walks set started_at = now() - interval '26 hours' where id = v_stale;
  perform fn_sweep_abandoned_walks(6);

  raise notice 'abandoned-walk sweep marks only stale open walks (0036): OK';
end $$;

-- The threshold is an argument, and a nonsense one must refuse rather than
-- quietly sweep the whole table. `p_hours <= 0` makes `now() - interval` land
-- in the future, which would flag every open walk including the current one.
do $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  begin
    perform fn_sweep_abandoned_walks(0);
    raise exception 'FAIL: the sweep accepted a zero-hour threshold';
  exception when raise_exception then
    if sqlerrm not like 'fn_sweep_abandoned_walks: hours must be positive%' then raise; end if;
  end;

  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000000001","role":"authenticated"}', true);
  begin
    perform fn_sweep_abandoned_walks(6);
    raise exception 'FAIL: an operator ran the abandoned-walk sweep';
  exception when insufficient_privilege then null;
       when raise_exception then
         if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  raise notice 'abandoned-walk sweep validates its threshold and its caller (0036): OK';
end $$;

-- A walk that has been flagged is REACHABLE by its operator, and not by
-- anyone else. The sweep is only half the fix: `abandoned_at` exists so the
-- Today screen can show the walk regardless of its date, and a column the
-- operator's own role cannot read would leave the walk exactly as invisible
-- as it was before.
do $$
declare
  v_seen int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000000001","role":"authenticated"}', true);
  select count(*) into v_seen from walks where abandoned_at is not null;
  if v_seen = 0 then
    raise exception 'FAIL: the operator cannot see their own abandoned walk';
  end if;

  -- Operator 2's session. Nothing about a flagged walk crosses the tenant.
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000000002","role":"authenticated"}', true);
  if (select count(*) from walks where abandoned_at is not null) <> 0 then
    raise exception 'FAIL: a foreign operator sees another tenant''s abandoned walk';
  end if;

  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  raise notice 'abandoned walks are visible to their own operator only (0036): OK';
end $$;

-- The nightly run actually CALLS the sweep. A function nothing calls is the
-- same as no function, and this is asserted on the OUTCOME — a stale walk that
-- comes back flagged — rather than on the reporting key, because
-- `v_stale_walks` initialises to 0 and so the key survives deleting the call.
do $$
declare
  v_service uuid;
  v_walk uuid;
  v_result jsonb;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into v_service from service_types
   where operator_id = '99999999-0000-4000-a000-000000000001' and is_default;

  insert into walks (operator_id, client_id, property_id, service_type_id,
                     scheduled_date, window_start, window_end, status, started_at)
  values ('99999999-0000-4000-a000-000000000001',
          '99999999-0000-4000-c000-00000000000a',
          '99999999-0000-4000-d000-00000000000a',
          v_service, current_date - 2, '10:00', '11:00', 'in_progress',
          now() - interval '50 hours')
  returning id into v_walk;

  v_result := fn_run_nightly_jobs(14);

  if (select abandoned_at from walks where id = v_walk) is null then
    raise exception 'FAIL: the nightly run left a 50-hour-old open walk unflagged';
  end if;
  if (v_result ->> 'walks_flagged_abandoned')::int < 1 then
    raise exception 'FAIL: the nightly run does not report what the sweep flagged';
  end if;
  if (select detail ->> 'walks_flagged_abandoned' from job_runs
       where id = (v_result ->> 'run_id')::uuid) is null then
    raise exception 'FAIL: the heartbeat row does not record the abandoned-walk sweep';
  end if;

  raise notice 'nightly run sweeps abandoned walks (0036): OK';
end $$;

-- BOTH advisory sweeps fail at once. `fn_expire_credits` has been broken since
-- the 0028 block far above (the outer rollback is what restores it), so
-- breaking the abandoned-walk sweep here produces exactly the case that
-- `error = coalesce(v_expiry_error, v_stale_error)` gets wrong: it records the
-- first and drops the second, so a permanently failing sweep stays invisible
-- for as long as any other sweep is also failing. That is the 0028 swallow
-- rebuilt one level up, which is why it is asserted rather than reasoned
-- about. This block is deliberately LAST — it leaves the sweep broken.
do $$
declare
  v_result jsonb;
  v_row record;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  create or replace function fn_sweep_abandoned_walks(p_hours int default 6)
  returns int
  language plpgsql security definer set search_path = public as $broken$
  begin
    raise exception 'simulated stale-walk failure';
  end;
  $broken$;

  -- A horizon no earlier run used, so `created > 0` means work happened
  -- rather than an idempotent no-op returning zero.
  v_result := fn_run_nightly_jobs(28);

  if (v_result ->> 'stale_walk_error') not like '%simulated stale-walk failure%' then
    raise exception 'FAIL: the stale-walk failure was swallowed: %', v_result ->> 'stale_walk_error';
  end if;
  if (v_result ->> 'created')::int = 0 then
    raise exception 'FAIL: a failing stale-walk sweep stopped walk generation';
  end if;

  select * into v_row from job_runs where id = (v_result ->> 'run_id')::uuid;
  if v_row.ok then
    raise exception 'FAIL: a run whose stale-walk sweep failed was recorded as ok';
  end if;
  if v_row.error not like '%simulated expiry failure%' then
    raise exception 'FAIL: the expiry failure vanished when a second sweep also failed: %', v_row.error;
  end if;
  if v_row.error not like '%simulated stale-walk failure%' then
    raise exception 'FAIL: the stale-walk failure hid behind the expiry failure: %', v_row.error;
  end if;

  raise notice 'two failing sweeps both reach the heartbeat row (0036): OK';
end $$;

-- A client must not be able to mark their own payment_failed email as sent.
-- 0004 grants `authenticated` only `update (read_at)` — a COLUMN-level grant —
-- so this holds today by design rather than by luck. Asserted because a later
-- table-level `grant update on notifications` would silently remove it.
do $$
declare
  v_n uuid;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into v_n from notifications
   where client_id = '99999999-0000-4000-c000-00000000000a' limit 1;

  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-b000-00000000000a","role":"authenticated"}', true);
  begin
    update notifications set email_status = 'sent' where id = v_n;
    raise exception 'FAIL: a client marked their own notification email as sent';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;
  begin
    update notifications set email_attempts = 99 where id = v_n;
    raise exception 'FAIL: a client rewrote the email attempt count';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  raise notice 'delivery columns are not client-writable (0029): OK';
end $$;

-- Backlog machinery is service-role only (invariant 5).
do $$
begin
  set local role authenticated;
  begin
    perform fn_expire_notification_backlog();
    raise exception 'FAIL: an operator expired the notification backlog';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;
  begin
    perform count(*) from fn_notification_backlog();
    raise exception 'FAIL: an operator read the notification backlog';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  raise notice 'notification backlog is service-role only (0029): OK';
end $$;


-- ═══ Vault audit trail + the hint that was never protected (0030) ════════
-- key_location_hint was an ordinary column with SELECT/INSERT/UPDATE granted
-- to `authenticated`, rendered with no re-auth, no audit row and no rate
-- limit — so a borrowed session returned, for every client, the full address
-- and where the key was hidden. For a lockbox client AES-GCM was protecting
-- the less useful half.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_name = 'access_credentials' and column_name = 'key_location_hint') then
    raise exception 'FAIL: key_location_hint is back — a means of entry in plaintext';
  end if;
  raise notice 'key_location_hint is gone (0030): OK';
end $$;

-- Every action leaves a row, not just a successful reveal.
do $$
declare
  v_cred uuid := gen_random_uuid();
  v_op uuid := '99999999-0000-4000-a000-000000000001';
  v_prop uuid := '99999999-0000-4000-d000-00000000000a';
  v_actions text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  perform fn_write_credential(v_cred, v_op, v_prop, 'lockbox',
    decode('000102030405060708090a0b101112131415161718191a1b1c1dff', 'hex'),
    'Smoke door', '203.0.113.9', 'smoke/1.0');
  perform fn_rotate_credential(v_cred, v_op,
    decode('0102030405060708090a0b0c101112131415161718191a1b1c1dee', 'hex'),
    null, null, '203.0.113.9', 'smoke/1.0');
  perform fn_log_credential_action(v_cred, v_op, 'reauth_failed', null, '203.0.113.9', 'smoke/1.0', null);
  perform fn_revoke_credential(v_cred, v_op, '203.0.113.9', 'smoke/1.0');

  select string_agg(action::text, ',' order by accessed_at, action) into v_actions
    from credential_access_log where credential_id = v_cred;
  if v_actions is null or v_actions not like '%create%' then
    raise exception 'FAIL: creating a credential wrote no audit row (got %)', v_actions;
  end if;
  if v_actions not like '%rotate%' then
    raise exception 'FAIL: rotating wrote no audit row — the question "who changed my code" is unanswerable';
  end if;
  if v_actions not like '%revoke%' then
    raise exception 'FAIL: revoking wrote no audit row';
  end if;
  if v_actions not like '%reauth_failed%' then
    raise exception 'FAIL: a failed re-auth wrote no audit row';
  end if;

  -- The IP is the half the log never had. Without it the trail cannot
  -- distinguish the operator's own phone from somebody else's browser.
  if not exists (select 1 from credential_access_log
                  where credential_id = v_cred and ip = '203.0.113.9'::inet) then
    raise exception 'FAIL: the caller IP was not recorded';
  end if;
  if not exists (select 1 from credential_access_log
                  where credential_id = v_cred and user_agent = 'smoke/1.0') then
    raise exception 'FAIL: the user agent was not recorded';
  end if;

  raise notice 'every vault action is audited (0030): OK';
end $$;

-- A malformed forwarded-for header must not fail the operation it describes.
do $$
declare
  v_cred uuid := gen_random_uuid();
  v_op uuid := '99999999-0000-4000-a000-000000000001';
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform fn_write_credential(v_cred, v_op, '99999999-0000-4000-d000-00000000000a', 'door_code',
    decode('000102030405060708090a0b101112131415161718191a1b1c1dff', 'hex'),
    'Bad IP', 'not-an-ip; DROP', 'smoke/1.0');
  if not exists (select 1 from credential_access_log
                  where credential_id = v_cred and ip is null) then
    raise exception 'FAIL: a malformed IP should be recorded as null, not lose the row';
  end if;
  raise notice 'a malformed IP loses the IP, not the audit row (0030): OK';
end $$;

-- The log is immortal, like the ledger. It had no mutation block at all, so
-- the operator whose reads it records could rewrite or delete them.
do $$
declare
  v_row uuid;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into v_row from credential_access_log limit 1;

  begin
    update credential_access_log set purpose = 'rewritten' where id = v_row;
    raise exception 'FAIL: an audit row was UPDATED';
  exception when raise_exception then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%append-only%' then raise; end if;
  end;

  begin
    delete from credential_access_log where id = v_row;
    raise exception 'FAIL: an audit row was DELETED';
  exception when raise_exception then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%append-only%' then raise; end if;
  end;

  raise notice 'the credential audit log is append-only (0030): OK';
end $$;

-- And no API-role write path: an operator forging a 'read' row would be worse
-- than a missing trail, because it attributes an entry to a time.
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000000001","role":"authenticated"}', true);
  begin
    insert into credential_access_log (operator_id, credential_id, accessed_by, action, purpose)
    values ('99999999-0000-4000-a000-000000000001',
            (select id from access_credentials limit 1),
            '99999999-0000-4000-a000-000000000001', 'read', 'forged');
    raise exception 'FAIL: an operator forged an audit row';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  raise notice 'audit rows cannot be forged by an operator (0030): OK';
end $$;

-- A walk reference must be a visit to THIS property by THIS operator. A
-- mismatched one would make the trail worse than empty: it would attribute an
-- entry to a visit that was somewhere else.
do $$
declare
  v_cred uuid;
  v_foreign_walk uuid;
  v_op uuid := '99999999-0000-4000-a000-000000000001';
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into v_cred from access_credentials
   where operator_id = v_op and revoked_at is null limit 1;
  select id into v_foreign_walk from walks
   where operator_id <> v_op limit 1;

  if v_foreign_walk is not null then
    begin
      perform fn_read_credential(v_cred, 'entry', v_op, null, null, v_foreign_walk);
      raise exception 'FAIL: a reveal was attributed to another operator''s walk';
    exception when raise_exception then
      if sqlerrm like 'FAIL:%' then raise; end if;
      if sqlerrm not like '%not a visit to this property%' then raise; end if;
    end;
  end if;
  raise notice 'a reveal cannot name a walk that was elsewhere (0030): OK';
end $$;

-- The person whose door it is can read the trail. They had no read path at
-- all, which is what made the trail unable to answer their question.
do $$
declare
  v_visible int;
  v_client_user uuid;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select auth_user_id into v_client_user from clients
   where id = '99999999-0000-4000-c000-00000000000a';

  set local role authenticated;
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_client_user), true);

  select count(*) into v_visible from credential_access_log;
  if v_visible = 0 then
    raise exception 'FAIL: the client cannot see any of their own door''s activity';
  end if;

  -- ...and only their own. Every visible row must belong to a credential on a
  -- property this client owns.
  if exists (
    select 1 from credential_access_log l
     where not exists (
       select 1 from access_credentials ac
         join properties p on p.id = ac.property_id
         join clients c on c.id = p.client_id
        where ac.id = l.credential_id and c.auth_user_id = v_client_user)
  ) then
    raise exception 'FAIL: a client can read another household''s door activity';
  end if;

  -- The ciphertext stays unreadable (invariant 2) even though the client can
  -- now select the credential metadata the trail names.
  begin
    perform ciphertext from access_credentials limit 1;
    raise exception 'FAIL: a client read the ciphertext column';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  raise notice 'the client reads their own trail, and no ciphertext (0030): OK';
end $$;

-- Definer functions are service-role only (invariant 5).
do $$
begin
  set local role authenticated;
  begin
    perform fn_write_credential(gen_random_uuid(),
      '99999999-0000-4000-a000-000000000001', '99999999-0000-4000-d000-00000000000a',
      'door_code', decode('00', 'hex'), 'nope', null, null);
    raise exception 'FAIL: an operator called fn_write_credential directly';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;
  begin
    perform fn_log_credential_action(gen_random_uuid(),
      '99999999-0000-4000-a000-000000000001', 'read', 'nope', null, null, null);
    raise exception 'FAIL: an operator wrote an audit row through the logger';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  raise notice 'vault write functions are service-role only (0030): OK';
end $$;

-- ═══ Storage policies (review H20) ════════════════════════════════════════
-- Nine policies govern who reads and writes photographs of customers' homes
-- and pets, and this file contained zero occurrences of "storage" until now.
-- A cross-tenant write hole has already shipped here once and been fixed in
-- 0012; a regression reopening it is a data breach with CI fully green and a
-- staging deploy firing automatically on merge.
--
-- Path convention: {operator_id}/{entity_id}/{uuid}.jpg. Segment 1 is the
-- tenant, segment 2 is the walk or the pet. The shim's storage.foldername has
-- the same semantics as the platform's, so what these assert is the policy
-- rather than the stand-in.
do $$
declare
  v_op_a  text := '99999999-0000-4000-a000-000000000001';
  v_op_b  text := '99999999-0000-4000-a000-000000000002';
  v_pet_a text := '99999999-0000-4000-e000-00000000000a';
  v_pet_f text := '99999999-0000-4000-e000-0000000000f2';
  v_walk_a text := '99999999-0000-4000-2000-000000000001';
  v_walk_b text := '99999999-0000-4000-2000-000000000002';
  v_client_user text := '99999999-0000-4000-a000-000000000003';
  v_seen int;
begin
  -- Fixtures written as service_role, which bypasses RLS: one object per
  -- tenant so the SELECT assertions below have something to fail on.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into storage.objects (bucket_id, name) values
    ('walk-photos', v_op_a || '/' || v_walk_a || '/aaa.jpg'),
    ('walk-photos', v_op_a || '/' || v_walk_b || '/bbb.jpg'),
    ('pet-photos',  v_op_a || '/' || v_pet_a  || '/ccc.jpg'),
    ('pet-photos',  v_op_b || '/' || v_pet_f  || '/ddd.jpg'),
    -- Operator B's folder, operator A's walk id: the L1 shape. Written as
    -- service_role, but operator B could write it themselves — segment 1 is
    -- their own uid, which is all storage_operator_insert asks.
    ('walk-photos', v_op_b || '/' || v_walk_a || '/planted.jpg');

  -- ── Operator A ─────────────────────────────────────────────────────────
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_op_a), true);
  set local session authorization authenticated;

  insert into storage.objects (bucket_id, name)
    values ('walk-photos', v_op_a || '/' || v_walk_a || '/own.jpg');

  begin
    insert into storage.objects (bucket_id, name)
      values ('walk-photos', v_op_b || '/' || v_walk_a || '/stolen.jpg');
    raise exception 'FAIL: operator A wrote into operator B''s storage folder';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  select count(*) into v_seen from storage.objects
   where (storage.foldername(name))[1] = v_op_b;
  if v_seen <> 0 then
    raise exception 'FAIL: operator A can read % of operator B''s objects', v_seen;
  end if;

  select count(*) into v_seen from storage.objects;
  if v_seen = 0 then
    raise exception 'FAIL: operator A can read none of their own objects — the SELECT policy denies everything, so the assertion above proves nothing';
  end if;

  reset role;

  -- ── Client A (bound to operator A, owns walk A and pet A) ──────────────
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_client_user), true);
  set local session authorization authenticated;

  -- Sees their own walk's photos, and only those. walk B belongs to client A2
  -- under the same operator, which is the case a tenant-only check would miss.
  select count(*) into v_seen from storage.objects
   where bucket_id = 'walk-photos'
     and (storage.foldername(name))[2] = v_walk_b;
  if v_seen <> 0 then
    raise exception 'FAIL: client A read % photo(s) of another client''s walk', v_seen;
  end if;

  select count(*) into v_seen from storage.objects
   where bucket_id = 'walk-photos'
     and (storage.foldername(name))[2] = v_walk_a;
  if v_seen = 0 then
    raise exception 'FAIL: client A cannot see their own walk photos';
  end if;

  -- Review L1: a foreign operator planting evidence. Operator B may legally
  -- write into their OWN folder, and `storage_operator_insert` allows it
  -- because segment 1 is B's uid — so the only thing that can refuse the READ
  -- is the client policy checking segment 1 against the walk's own operator.
  -- Nothing leaks out of A here; B injects an image INTO the proof of service
  -- A's client receives, which is why it does not look like a breach.
  if (select count(*) from storage.objects
       where bucket_id = 'walk-photos'
         and (storage.foldername(name))[1] = v_op_b
         and (storage.foldername(name))[2] = v_walk_a) <> 0 then
    raise exception 'FAIL: client A read a walk photo planted in another operator''s folder';
  end if;

  -- THE 0012 regression. The INSERT policy once checked only the pet (segment
  -- 2) and not the operator (segment 1), so a client could write into another
  -- tenant's folder. Both halves are asserted: the legitimate path must work,
  -- or a policy that denies everything would pass the negative case.
  insert into storage.objects (bucket_id, name)
    values ('pet-photos', v_op_a || '/' || v_pet_a || '/mine.jpg');

  begin
    insert into storage.objects (bucket_id, name)
      values ('pet-photos', v_op_b || '/' || v_pet_a || '/crosstenant.jpg');
    raise exception 'FAIL: client wrote a pet photo into another operator''s folder (0012 regression)';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  -- A pet they do not own, in its own operator's folder.
  begin
    insert into storage.objects (bucket_id, name)
      values ('pet-photos', v_op_b || '/' || v_pet_f || '/notmine.jpg');
    raise exception 'FAIL: client wrote a photo for a pet belonging to someone else';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  -- `reset role` does NOT undo `set local session authorization`, and this
  -- block set one. Without this line every block appended after it ran as
  -- `authenticated` — silently, since RLS answers a service-role question with
  -- an empty result rather than an error. Found by a 0038 assertion failing
  -- confusingly; the danger is the assertions it would have passed vacuously.
  reset session authorization;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  raise notice 'storage policies: tenant folder + per-walk + per-pet scoping OK';
end $$;

-- The guard for the above, because the leak is invisible by construction: a
-- block that expects the service role and gets `authenticated` sees an empty
-- table, and "no rows" is what most negative assertions are looking for.
do $$
begin
  if session_user <> 'postgres' then
    raise exception
      'FAIL: a persona leaked out of its block (session_user=%). Every assertion after this point is running as the wrong role — `reset role` does not undo `set local session authorization`.',
      session_user;
  end if;
  raise notice 'no persona leaked out of the storage block: OK';
end $$;



-- ── 0037 · one lock order for walks and clients ──────────────────────────
-- Review M32. `fn_refund_cancelled_debit` is a BEFORE UPDATE trigger on
-- `walks`, so its body runs with the walk tuple already locked and can only
-- reach `clients` afterwards. Any function taking the two locks the other way
-- round completes a deadlock cycle with it.
--
-- Asserted on `pg_get_functiondef` — what Postgres actually installed, after
-- every `create or replace` — rather than on migration text, for the same
-- reason the invariant-1 check moved to the catalogue: a later migration can
-- replace a body, and the file that first defined it never changes.
--
-- Checked for EVERY function that locks both, not just `fn_debit_walk`,
-- because the next one to invert the order will be a new function and a
-- name-specific test would never look at it. `concurrency.sh` case 5 is the
-- behavioural half; this is the half that runs on every commit.
--
-- The extraction is a regex per LOCKING statement, not `position()` on a table
-- name. The first draft used the latter and would have missed the live
-- violation: `fn_debit_walk` opened with an UNLOCKED `from walks where id =
-- p_walk`, so the first mention of `walks` preceded the `clients` lock and the
-- order read as compliant. `[^;]*?` keeps each match inside one statement.
do $$
declare
  r record;
  v_locks text[];
  v_bad text[] := '{}';
  v_scanned int := 0;
begin
  for r in
    select p.oid, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
  loop
    select array_agg(m[1] order by ord) into v_locks
      from regexp_matches(pg_get_functiondef(r.oid),
                          '\m(clients|walks)\M[^;]*?\yfor update\y', 'g')
           with ordinality as t(m, ord);

    if v_locks @> array['clients'] and v_locks @> array['walks'] then
      v_scanned := v_scanned + 1;
      if array_position(v_locks, 'clients') < array_position(v_locks, 'walks') then
        v_bad := v_bad || r.proname;
      end if;
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception
      'FAIL: % locks clients before walks — the cancel-refund trigger cannot, so this deadlocks (0037)',
      array_to_string(v_bad, ', ');
  end if;

  -- Vacuity guard. With no function locking both tables the loop above proves
  -- nothing, which is exactly what a typo in the pattern produces.
  if v_scanned = 0 then
    raise exception 'FAIL: the lock-order check matched no function at all — the pattern is broken';
  end if;

  raise notice 'walks is locked before clients everywhere (0037): OK';
end $$;



-- ── 0038 · email consent and the way out ─────────────────────────────────
-- Review M29. `clients.email` is operator-typed and reconciled with nothing,
-- so one typo sends a stranger a recurring feed of when a named person's house
-- is empty. That person cannot sign in, so every rule here is about an opt-out
-- that works for somebody with no account.
do $$
declare
  v_token uuid;
  v_applied boolean;
  v_email text;
  v_op uuid := '99999999-0000-4000-a000-000000000001';
  v_cli uuid := '99999999-0000-4000-c000-00000000000a';
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  update clients set email = 'Typo.Recipient@Example.TEST' where id = v_cli;
  select unsubscribe_token into v_token from clients where id = v_cli;
  if v_token is null then
    raise exception 'FAIL: no unsubscribe token was issued';
  end if;

  -- Not suppressed to begin with, or the assertions below prove nothing.
  if fn_email_suppressed('typo.recipient@example.test', v_op, 'walk_complete') then
    raise exception 'FAIL: the address is suppressed before anyone unsubscribed';
  end if;

  select o_applied, o_email into v_applied, v_email
    from fn_unsubscribe_by_token(v_token);
  if not v_applied then
    raise exception 'FAIL: a valid token did not unsubscribe';
  end if;

  -- Stored lowercased. The operator typed mixed case; the sender will ask with
  -- whatever case the row holds, and one canonical form is what makes the
  -- unique index the whole rule.
  if v_email <> 'typo.recipient@example.test' then
    raise exception 'FAIL: the suppressed address was not canonicalised: %', v_email;
  end if;

  -- Suppressed for EVERY operator and EVERY type: a stranger asking to stop is
  -- not asking to stop from one business they have never heard of.
  if not fn_email_suppressed('typo.recipient@example.test', v_op, 'walk_complete') then
    raise exception 'FAIL: the address is not suppressed after unsubscribing';
  end if;
  if not fn_email_suppressed('typo.recipient@example.test', v_op, 'payment_failed') then
    raise exception 'FAIL: the unsubscribe did not cover every notification type';
  end if;
  if not fn_email_suppressed('TYPO.recipient@Example.test', v_op, 'walk_complete') then
    raise exception 'FAIL: suppression is case-sensitive — the sender would miss it';
  end if;
  if not fn_email_suppressed(
       'typo.recipient@example.test', '99999999-0000-4000-a000-000000000002', 'walk_complete') then
    raise exception 'FAIL: the unsubscribe did not cover every operator';
  end if;

  -- Somebody else is unaffected.
  if fn_email_suppressed('someone.else@example.test', v_op, 'walk_complete') then
    raise exception 'FAIL: unsubscribing one address suppressed another';
  end if;

  -- Idempotent. A person who clicks twice, or a mail client that prefetches
  -- the link and then posts it, must not hit a unique violation.
  select o_applied into v_applied from fn_unsubscribe_by_token(v_token);
  if not v_applied then
    raise exception 'FAIL: a second unsubscribe reported failure';
  end if;
  if (select count(*) from email_suppressions
       where email = 'typo.recipient@example.test') <> 1 then
    raise exception 'FAIL: unsubscribing twice wrote two rows';
  end if;

  -- An unknown token answers exactly like a known one. An unauthenticated
  -- endpoint that distinguishes them is an oracle for guessing them.
  --
  -- RAISING is an oracle too, and a version that did was the first sabotage
  -- this assertion failed to catch: the DO block simply aborted with the
  -- sabotage's own message, which is not a `FAIL:` line and reads as a broken
  -- suite rather than a broken rule. So the raise is caught here explicitly.
  begin
    select o_applied, o_email into v_applied, v_email
      from fn_unsubscribe_by_token('00000000-0000-4000-8000-000000000000');
  exception when others then
    raise exception
      'FAIL: an unknown token raised "%" — an unauthenticated endpoint that distinguishes a real token from a made-up one is an oracle for guessing them',
      sqlerrm;
  end;
  if v_applied then
    raise exception 'FAIL: an unknown token reported a successful unsubscribe';
  end if;
  if v_email is not null then
    raise exception 'FAIL: an unknown token returned an address: %', v_email;
  end if;

  raise notice 'unsubscribe suppresses the address, for everyone, idempotently (0038): OK';
end $$;

-- The token is a bearer credential for "stop emailing this address", and the
-- suppression list is the record that somebody asked. Neither is the API
-- roles' business — an operator able to DELETE a suppression is the one thing
-- that would make it worthless.
do $$
declare v_n int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000000001","role":"authenticated"}', true);

  begin
    perform unsubscribe_token from clients limit 1;
    raise exception 'FAIL: an operator can read the unsubscribe token';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  begin
    select count(*) into v_n from email_suppressions;
    raise exception 'FAIL: an operator can read the suppression list';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  begin
    delete from email_suppressions;
    raise exception 'FAIL: an operator can delete a suppression';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  begin
    perform fn_unsubscribe_by_token('00000000-0000-4000-8000-000000000000');
    raise exception 'FAIL: an operator called the unsubscribe function directly';
  exception when insufficient_privilege then null;
       when raise_exception then
         if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  -- The rest of the client row is still readable — column privileges, not a
  -- policy, so the token is withheld without withholding the client.
  select count(*) into v_n from clients where id = '99999999-0000-4000-c000-00000000000a';
  if v_n <> 1 then
    raise exception 'FAIL: withholding the token withheld the client row';
  end if;

  -- Every OTHER column is still granted. 0038 replaced the table-level SELECT
  -- with an explicit list, which is fail-closed for columns added later: a new
  -- column silently becomes unreadable and `select("*")` starts failing with a
  -- bare 42501 from PostgREST. This turns that into a sentence naming the
  -- column and the file to add it to.
  --
  -- The withheld set is NAMED, and asserted in both directions. Listing the
  -- exemptions rather than one `<>` keeps the check fail-closed for a column
  -- added later while making each withholding a decision somebody wrote down:
  --   unsubscribe_token  0038 — a bearer credential for "stop emailing this
  --                      address", and listClients() selects *
  --   notes              0043 (L3) — the operator's private note ABOUT the
  --                      client; the portal must not read it
  --   stripe_customer_id / stripe_subscription_id
  --                      0043 (L3) — external billing identifiers with no
  --                      reader in app/src
  declare
    v_withheld text[] := array[
      'unsubscribe_token', 'notes', 'stripe_customer_id', 'stripe_subscription_id'
    ];
    v_missing text;
    v_leaked  text;
  begin
    select string_agg(c.column_name, ', ')
      into v_missing
      from information_schema.columns c
     where c.table_schema = 'public'
       and c.table_name = 'clients'
       and not (c.column_name = any (v_withheld))
       and not has_column_privilege('authenticated', 'public.clients', c.column_name, 'SELECT');
    if v_missing is not null then
      raise exception
        'FAIL: clients column(s) not selectable by authenticated: % — add them to the grant list in the latest migration that narrowed it',
        v_missing;
    end if;

    -- The other direction. Without this the exemption list is a way to make
    -- the check pass by naming a column, rather than a record of one that is
    -- genuinely withheld.
    select string_agg(c, ', ') into v_leaked
      from unnest(v_withheld) c
     where has_column_privilege('authenticated', 'public.clients', c, 'SELECT');
    if v_leaked is not null then
      raise exception
        'FAIL: column(s) listed as withheld are selectable by authenticated: %', v_leaked;
    end if;
  end;

  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  raise notice 'the token and the suppression list are service-role only (0038): OK';
end $$;

-- The client-facing low-credit body no longer states the balance: it is
-- rendered verbatim into an email, and mail is the least private channel this
-- product has. The OPERATOR row keeps its count — that is their own business
-- data and the number is the point of the alert.
do $$
declare
  v_client text;
  v_operator text;
  v_cli uuid := '99999999-0000-4000-c000-00000000000b';
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  delete from notifications where client_id = v_cli and type = 'low_credit';
  update clients set credit_balance = 1 where id = v_cli;
  perform fn_notify_low_credit(v_cli);

  select body into v_client from notifications
   where client_id = v_cli and type = 'low_credit' order by created_at desc limit 1;
  select body into v_operator from notifications
   where client_id is null and type = 'low_credit'
     and title like '%Smoke Client B%' order by created_at desc limit 1;

  if v_client is null or v_operator is null then
    raise exception 'FAIL: fn_notify_low_credit did not raise both notifications';
  end if;
  if v_client ~ '[0-9]' then
    raise exception 'FAIL: the client-facing low-credit body still states a number: %', v_client;
  end if;
  if v_operator !~ '[0-9]' then
    raise exception 'FAIL: the operator-facing low-credit body lost its count: %', v_operator;
  end if;

  raise notice 'the client-facing low-credit email carries no balance (0038): OK';
end $$;

-- ═══ 0039: an invite expires, can be withdrawn, reissued, and is logged ════
--
-- Every branch below was confirmed to FAIL against the pre-0039 function,
-- which claimed unconditionally. The negative cases are the point: a claim
-- that dies of an undefined column is indistinguishable from one correctly
-- refused, so each asserts the SPECIFIC message.
do $$
declare
  v_client   uuid;
  v_token    uuid;
  v_new      uuid;
  v_rows     int;
begin
  reset session authorization;

  insert into auth.users (id, email) values
    ('99999999-0000-4000-a000-00000000004a', 'h4-a@sanpo.test'),
    ('99999999-0000-4000-a000-00000000004b', 'h4-b@sanpo.test');

  -- ── expired invite ──────────────────────────────────────────────────────
  insert into clients (id, operator_id, full_name, status, invite_token, invite_expires_at)
  values ('99999999-0000-4000-c000-0000000000e1', '99999999-0000-4000-a000-000000000001',
          'H4 Expired', 'invited', '99999999-0000-4000-e000-000000000001',
          now() - interval '1 day');

  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-00000000004a","role":"authenticated","email":"h4-a@sanpo.test"}', true);
  set local session authorization authenticated;

  -- the preview must refuse too, or the screen names a real client and a real
  -- business to the holder of a dead link before failing at the last step
  if (select count(*) from fn_preview_invite('99999999-0000-4000-e000-000000000001')) <> 0 then
    raise exception 'FAIL: preview rendered an expired invite';
  end if;

  if (select c.outcome from fn_claim_invite('99999999-0000-4000-e000-000000000001') c)
       <> 'expired' then
    raise exception 'FAIL: an expired invite was not refused as expired';
  end if;
  if (select auth_user_id from clients
       where id = '99999999-0000-4000-c000-0000000000e1') is not null then
    raise exception 'FAIL: an expired invite bound an account anyway';
  end if;
  reset session authorization;

  -- ── revoked invite ──────────────────────────────────────────────────────
  insert into clients (id, operator_id, full_name, status, invite_token, invite_revoked_at)
  values ('99999999-0000-4000-c000-0000000000e2', '99999999-0000-4000-a000-000000000001',
          'H4 Revoked', 'invited', '99999999-0000-4000-e000-000000000002', now());

  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-00000000004a","role":"authenticated","email":"h4-a@sanpo.test"}', true);
  set local session authorization authenticated;
  if (select count(*) from fn_preview_invite('99999999-0000-4000-e000-000000000002')) <> 0 then
    raise exception 'FAIL: preview rendered a revoked invite';
  end if;
  if (select c.outcome from fn_claim_invite('99999999-0000-4000-e000-000000000002') c)
       <> 'revoked' then
    raise exception 'FAIL: a revoked invite was not refused as revoked';
  end if;
  reset session authorization;

  -- ── the forwarded link: right token, wrong person ───────────────────────
  insert into clients (id, operator_id, full_name, email, status, invite_token)
  values ('99999999-0000-4000-c000-0000000000e3', '99999999-0000-4000-a000-000000000001',
          'H4 Bound', 'h4-a@sanpo.test', 'invited', '99999999-0000-4000-e000-000000000003');

  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-00000000004b","role":"authenticated","email":"h4-b@sanpo.test"}', true);
  set local session authorization authenticated;
  if (select c.outcome from fn_claim_invite('99999999-0000-4000-e000-000000000003') c)
       <> 'email_mismatch' then
    raise exception 'FAIL: a forwarded invite was not refused as email_mismatch';
  end if;
  if (select auth_user_id from clients
       where id = '99999999-0000-4000-c000-0000000000e3') is not null then
    raise exception 'FAIL: the wrong address bound the account anyway';
  end if;
  reset session authorization;

  -- ...and the invited address still works, case- and whitespace-insensitively
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-00000000004a","role":"authenticated","email":"  H4-A@Sanpo.Test "}', true);
  set local session authorization authenticated;
  select c.client_id into v_client
    from fn_claim_invite('99999999-0000-4000-e000-000000000003') c;
  if v_client <> '99999999-0000-4000-c000-0000000000e3' then
    raise exception 'FAIL: the invited address could not claim its own invite';
  end if;
  reset session authorization;

  -- ── the log recorded all four, and the operator can read them ───────────
  -- The refusals are the rows that matter, and they are the ones a
  -- log-then-raise implementation silently discards.
  select count(distinct outcome) into v_rows from invite_claim_attempts
   where client_id in ('99999999-0000-4000-c000-0000000000e1',
                       '99999999-0000-4000-c000-0000000000e2',
                       '99999999-0000-4000-c000-0000000000e3')
     and outcome in ('expired', 'revoked', 'email_mismatch', 'claimed');
  if v_rows <> 4 then
    raise exception 'FAIL: expected all four outcomes logged, got % distinct', v_rows;
  end if;
  if (select count(*) from invite_claim_attempts
       where client_id = '99999999-0000-4000-c000-0000000000e3'
         and outcome = 'email_mismatch'
         and attempted_email = 'h4-b@sanpo.test') <> 1 then
    raise exception 'FAIL: the mismatch row does not name the address that tried';
  end if;

  -- append-only, like credit_ledger and credential_access_log
  begin
    update invite_claim_attempts set outcome = 'claimed'
     where client_id = '99999999-0000-4000-c000-0000000000e3';
    raise exception 'FAIL: an audit row was rewritten';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%append-only%' then
      raise exception 'FAIL: audit mutation blocked for the wrong reason: %', sqlerrm;
    end if;
  end;

  -- ── reissue is the operator's, and only for their own client ────────────
  insert into clients (id, operator_id, full_name, status, invite_token, invite_expires_at)
  values ('99999999-0000-4000-c000-0000000000e4', '99999999-0000-4000-a000-000000000001',
          'H4 Reissue', 'invited', '99999999-0000-4000-e000-000000000004',
          now() - interval '1 day');
  select invite_token into v_token from clients
   where id = '99999999-0000-4000-c000-0000000000e4';

  -- a foreign authenticated user cannot mint a token for somebody else's client
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-00000000004b","role":"authenticated","email":"h4-b@sanpo.test"}', true);
  set local session authorization authenticated;
  begin
    perform fn_rotate_invite('99999999-0000-4000-c000-0000000000e4');
    raise exception 'FAIL: a stranger reissued an invite for another operator''s client';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%no unclaimed invite%' then
      raise exception 'FAIL: foreign rotate refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  reset session authorization;

  -- the owning operator can, and it revives an expired invite
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000000001","role":"authenticated"}', true);
  set local session authorization authenticated;
  select fn_rotate_invite('99999999-0000-4000-c000-0000000000e4') into v_new;
  if v_new = v_token then
    raise exception 'FAIL: reissue returned the same token';
  end if;
  if (select invite_expires_at from clients
       where id = '99999999-0000-4000-c000-0000000000e4') <= now() then
    raise exception 'FAIL: reissue left the invite expired';
  end if;

  perform fn_revoke_invite('99999999-0000-4000-c000-0000000000e4');
  if (select invite_revoked_at from clients
       where id = '99999999-0000-4000-c000-0000000000e4') is null then
    raise exception 'FAIL: revoke did not stamp the row';
  end if;
  reset session authorization;

  -- ── the token itself is still unwritable through the API role ───────────
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000000001","role":"authenticated"}', true);
  set local session authorization authenticated;
  begin
    update clients set invite_expires_at = now() + interval '99 years'
     where id = '99999999-0000-4000-c000-0000000000e4';
    raise exception 'FAIL: an operator extended an invite by direct UPDATE';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%permission denied%' then
      raise exception 'FAIL: direct expiry write refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  reset session authorization;

  raise notice 'invite expiry, revocation, binding, reissue and log (0039): OK';
end $$;

-- ═══ 0040: a client can be exported, then destroyed — ledger intact ═══════
do $$
declare
  v_op    uuid := '99999999-0000-4000-a000-000000000001';
  v_cl    uuid := '99999999-0000-4000-c000-0000000000d1';
  v_prop  uuid := '99999999-0000-4000-b000-0000000000d1';
  v_pet   uuid := '99999999-0000-4000-d000-0000000000d1';
  v_walk  uuid := '99999999-0000-4000-f000-0000000000d1';
  v_cred  uuid := '99999999-0000-4000-e000-0000000000d1';
  v_svc   uuid;
  v_ledger_before int;
  v_ledger_after  int;
  v_paths int;
  v_export jsonb;
begin
  reset session authorization;
  select id into v_svc from service_types where operator_id = v_op limit 1;

  insert into clients (id, operator_id, full_name, email, phone, notes, status, auth_user_id)
  values (v_cl, v_op, 'Purge Me', 'purge@sanpo.test', '+1 555 0100',
          'gate sticks in the rain', 'active', null);
  insert into properties (id, operator_id, client_id, label, address_line1, city, postcode,
                          access_notes_public, lat, lng)
  values (v_prop, v_op, v_cl, 'Home', '14 Elm Street', 'Chicago', '60601',
          'side gate, latch is stiff', 41.88, -87.63);
  insert into pets (id, operator_id, client_id, name, medical_notes, medication_notes, photo_path)
  values (v_pet, v_op, v_cl, 'Rex', 'epileptic', 'phenobarbital 2x daily',
          v_op || '/pet/rex.jpg');
  insert into walks (id, operator_id, client_id, property_id, service_type_id,
                     scheduled_date, window_start, window_end, status, notes, origin_date)
  values (v_walk, v_op, v_cl, v_prop, v_svc, current_date - 400,
          '09:00', '10:00', 'completed',
          'left the back door unlocked by mistake', current_date - 400);
  insert into walk_pets (walk_id, pet_id, operator_id) values (v_walk, v_pet, v_op);
  insert into walk_gps_points (walk_id, operator_id, lat, lng, recorded_at)
  values (v_walk, v_op, 41.88, -87.63, now() - interval '400 days');
  insert into walk_photos (walk_id, operator_id, storage_path)
  values (v_walk, v_op, v_op || '/' || v_walk || '/1.jpg');
  -- With its audit row, the way fn_write_credential creates one. Without this
  -- the fixture is a credential no product path could have produced, and the
  -- purge's hardest constraint — credential_access_log is immutable and
  -- RESTRICTs on credential_id — is never exercised. The first version of
  -- this block inserted the credential alone and the purge passed while
  -- raising for every real client.
  insert into access_credentials (id, operator_id, property_id, entry_method, label, ciphertext)
  values (v_cred, v_op, v_prop, 'door_code', 'Front door', repeat('\001', 40)::bytea);
  insert into credential_access_log (operator_id, credential_id, accessed_by, purpose, action)
  values (v_op, v_cred, v_op, 'created', 'create');
  -- money that must survive
  perform fn_grant_credits(v_cl, 3, 'purge fixture');

  select count(*) into v_ledger_before from credit_ledger where client_id = v_cl;
  if v_ledger_before = 0 then
    raise exception 'FAIL: fixture wrote no ledger rows, so survival proves nothing';
  end if;

  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_op), true);
  set local session authorization authenticated;

  -- ── export names the things a person would ask for ────────────────────
  v_export := fn_export_client_data(v_cl);
  if v_export #>> '{client,full_name}' <> 'Purge Me' then
    raise exception 'FAIL: export did not carry the client';
  end if;
  if not (v_export::text like '%14 Elm Street%') then
    raise exception 'FAIL: export omitted the address';
  end if;
  if not (v_export::text like '%phenobarbital%') then
    raise exception 'FAIL: export omitted the medication notes';
  end if;
  if v_export::text like '%\\x00%' then
    raise exception 'FAIL: export leaked vault ciphertext';
  end if;

  -- a foreign operator cannot export it
  reset session authorization;
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000000002","role":"authenticated"}', true);
  set local session authorization authenticated;
  begin
    perform fn_export_client_data(v_cl);
    raise exception 'FAIL: a foreign operator exported another tenant''s client';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%no such client%' then
      raise exception 'FAIL: foreign export refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  begin
    perform fn_purge_client(v_cl);
    raise exception 'FAIL: a foreign operator purged another tenant''s client';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%no such client%' then
      raise exception 'FAIL: foreign purge refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  reset session authorization;

  -- ── purge ─────────────────────────────────────────────────────────────
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_op), true);
  set local session authorization authenticated;

  select count(*) into v_paths from fn_purge_client(v_cl);
  if v_paths <> 2 then
    raise exception 'FAIL: expected 2 storage paths to delete, got %', v_paths;
  end if;
  perform fn_purge_client_photos(v_cl);
  reset session authorization;

  -- ── the sensitive things are gone ─────────────────────────────────────
  if exists (select 1 from walk_gps_points where walk_id = v_walk) then
    raise exception 'FAIL: the GPS trace survived the purge';
  end if;
  -- The secret is destroyed; the row and its audit trail are not, because
  -- credential_access_log is immutable and RESTRICTs on credential_id — and
  -- because letting a purge erase the trail would hand the audited party a way
  -- to erase their own reads.
  if exists (
    select 1 from access_credentials ac join properties p on p.id = ac.property_id
     where p.client_id = v_cl
       and (ac.ciphertext <> repeat('\000', 37)::bytea
            or ac.label is not null
            or ac.revoked_at is null)
  ) then
    raise exception 'FAIL: the door code survived the purge';
  end if;
  if (select key_id from access_credentials where id = v_cred) is not null then
    raise exception 'FAIL: the redacted credential still reads as a live blob';
  end if;
  if not exists (select 1 from credential_access_log where credential_id = v_cred) then
    raise exception 'FAIL: the purge erased the credential audit trail';
  end if;
  if exists (select 1 from pets where client_id = v_cl) then
    raise exception 'FAIL: the medical notes survived the purge';
  end if;
  if exists (select 1 from walk_photos where walk_id = v_walk) then
    raise exception 'FAIL: the photo rows survived the purge';
  end if;
  if (select address_line1 from properties where id = v_prop) is not null then
    raise exception 'FAIL: the address survived the purge';
  end if;
  if (select notes from walks where id = v_walk) is not null then
    raise exception 'FAIL: the walk notes survived the purge';
  end if;
  if (select full_name from clients where id = v_cl) <> 'Deleted client' then
    raise exception 'FAIL: the client was not tombstoned';
  end if;
  if (select email from clients where id = v_cl) is not null then
    raise exception 'FAIL: the email survived the purge';
  end if;
  if (select purged_at from clients where id = v_cl) is null then
    raise exception 'FAIL: the purge left no marker';
  end if;

  -- ── and the money did not move ────────────────────────────────────────
  select count(*) into v_ledger_after from credit_ledger where client_id = v_cl;
  if v_ledger_after <> v_ledger_before then
    raise exception 'FAIL: the purge destroyed % ledger rows',
      v_ledger_before - v_ledger_after;
  end if;
  if not exists (select 1 from walks where id = v_walk) then
    raise exception 'FAIL: the purge deleted a walk the ledger references';
  end if;

  -- ── idempotent: running it again is a no-op, not an error ─────────────
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_op), true);
  set local session authorization authenticated;
  select count(*) into v_paths from fn_purge_client(v_cl);
  if v_paths <> 0 then
    raise exception 'FAIL: a second purge found % paths to delete', v_paths;
  end if;
  reset session authorization;

  raise notice 'client export, purge and ledger survival (0040): OK';
end $$;

-- ═══ 0040: the retention sweep drops old traces and nothing else ══════════
do $$
declare
  v_op   uuid := '99999999-0000-4000-a000-000000000001';
  v_cl   uuid := '99999999-0000-4000-c000-0000000000d2';
  v_prop uuid := '99999999-0000-4000-b000-0000000000d2';
  v_old  uuid := '99999999-0000-4000-f000-0000000000d2';
  v_new  uuid := '99999999-0000-4000-f000-0000000000d3';
  v_live uuid := '99999999-0000-4000-f000-0000000000d4';
  v_svc  uuid;
  v_n    int;
begin
  reset session authorization;
  select id into v_svc from service_types where operator_id = v_op limit 1;

  insert into clients (id, operator_id, full_name, status)
  values (v_cl, v_op, 'Retention Fixture', 'active');
  insert into properties (id, operator_id, client_id, label)
  values (v_prop, v_op, v_cl, 'Home');

  insert into walks (id, operator_id, client_id, property_id, service_type_id,
                     scheduled_date, window_start, window_end, status, origin_date) values
    (v_old,  v_op, v_cl, v_prop, v_svc, current_date - 400, '09:00', '10:00', 'completed',   current_date - 400),
    (v_new,  v_op, v_cl, v_prop, v_svc, current_date - 10,  '09:00', '10:00', 'completed',   current_date - 10),
    -- an in-progress walk older than the window: its trace must NOT be
    -- dropped, or an abandoned walk loses the only record of what happened.
    (v_live, v_op, v_cl, v_prop, v_svc, current_date - 400, '09:00', '10:00', 'in_progress', current_date - 400);
  insert into walk_gps_points (walk_id, operator_id, lat, lng, recorded_at) values
    (v_old,  v_op, 41.0, -87.0, now() - interval '400 days'),
    (v_new,  v_op, 41.0, -87.0, now() - interval '10 days'),
    (v_live, v_op, 41.0, -87.0, now() - interval '400 days');

  v_n := fn_sweep_gps_retention();
  if v_n <> 1 then
    raise exception 'FAIL: sweep dropped % point(s), expected exactly 1', v_n;
  end if;
  if exists (select 1 from walk_gps_points where walk_id = v_old) then
    raise exception 'FAIL: the sweep left a trace past the retention window';
  end if;
  if not exists (select 1 from walk_gps_points where walk_id = v_new) then
    raise exception 'FAIL: the sweep dropped a trace inside the window';
  end if;
  if not exists (select 1 from walk_gps_points where walk_id = v_live) then
    raise exception 'FAIL: the sweep dropped an unfinished walk''s trace';
  end if;

  -- 0 disables it rather than meaning "delete everything today"
  update operators set gps_retention_days = 0 where id = v_op;
  insert into walk_gps_points (walk_id, operator_id, lat, lng, recorded_at)
  values (v_old, v_op, 41.0, -87.0, now() - interval '400 days');
  v_n := fn_sweep_gps_retention();
  if v_n <> 0 then
    raise exception 'FAIL: retention 0 swept % points instead of disabling', v_n;
  end if;
  update operators set gps_retention_days = 365 where id = v_op;

  -- service role only
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_op), true);
  set local session authorization authenticated;
  begin
    perform fn_sweep_gps_retention();
    raise exception 'FAIL: an operator ran the retention sweep';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%service role only%' and sqlerrm not like '%permission denied%' then
      raise exception 'FAIL: sweep refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  reset session authorization;

  raise notice 'GPS retention sweep drops only what it should (0040): OK';
end $$;

-- ═══ 0041: the consent record says WHAT was accepted, and cannot be forged ══
do $$
declare
  v_op   uuid := '99999999-0000-4000-a000-000000000001';
  v_cl   uuid := '99999999-0000-4000-c000-0000000000c1';
  v_user uuid := '99999999-0000-4000-a000-0000000000c1';
  v_res  record;
begin
  reset session authorization;
  insert into auth.users (id, email) values (v_user, 'consent@sanpo.test');
  insert into clients (id, operator_id, full_name, email, status, invite_token)
  values (v_cl, v_op, 'Consent Case', 'consent@sanpo.test', 'invited',
          '99999999-0000-4000-e000-0000000000c1');

  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated","email":"consent@sanpo.test"}', v_user), true);
  set local session authorization authenticated;

  select * into v_res from fn_claim_invite('99999999-0000-4000-e000-0000000000c1', '2026-08-29');
  if v_res.outcome <> 'claimed' then
    raise exception 'FAIL: the claim did not succeed: %', v_res.outcome;
  end if;
  reset session authorization;

  -- the acceptance landed in the SAME transaction as the binding
  if (select notice_version from clients where id = v_cl) <> '2026-08-29' then
    raise exception 'FAIL: the claim recorded no notice version';
  end if;
  if (select notice_accepted_at from clients where id = v_cl) is null then
    raise exception 'FAIL: the claim recorded no acceptance time';
  end if;

  -- an operator cannot stamp consent onto a client's row
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_op), true);
  set local session authorization authenticated;
  begin
    update clients set notice_accepted_at = now(), notice_version = 'forged'
     where id = v_cl;
    raise exception 'FAIL: an operator forged a client''s consent record';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%permission denied%' then
      raise exception 'FAIL: consent forgery refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  reset session authorization;

  raise notice 'consent is recorded by the claim and cannot be forged (0041): OK';
end $$;

-- ═══ 0041: a claim that showed no notice records no acceptance ════════════
-- The absence is the point: stamping now() with a null version would assert an
-- acceptance of a document nobody can look up.
do $$
declare
  v_op   uuid := '99999999-0000-4000-a000-000000000001';
  v_cl   uuid := '99999999-0000-4000-c000-0000000000c2';
  v_user uuid := '99999999-0000-4000-a000-0000000000c2';
  v_res  record;
begin
  reset session authorization;
  insert into auth.users (id, email) values (v_user, 'noversion@sanpo.test');
  insert into clients (id, operator_id, full_name, status, invite_token)
  values (v_cl, v_op, 'No Version', 'invited', '99999999-0000-4000-e000-0000000000c2');

  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_user), true);
  set local session authorization authenticated;
  select * into v_res from fn_claim_invite('99999999-0000-4000-e000-0000000000c2');
  reset session authorization;

  if v_res.outcome <> 'claimed' then
    raise exception 'FAIL: a one-argument claim stopped working: %', v_res.outcome;
  end if;
  if (select notice_accepted_at from clients where id = v_cl) is not null then
    raise exception 'FAIL: an acceptance was recorded for a claim that showed no notice';
  end if;

  raise notice 'no notice shown means no acceptance recorded (0041): OK';
end $$;

-- ═══ 0042: purge a client who CLAIMED, and release a wrong claim ══════════
--
-- The purge block above uses a client that never claimed, so its
-- `delete from invite_claim_attempts` ran against an empty set and the
-- append-only trigger was never reached. Every real client has a `claimed`
-- row. This block is that case, and it fails against 0040/0041.
do $$
declare
  v_op    uuid := '99999999-0000-4000-a000-000000000001';
  v_cl    uuid := '99999999-0000-4000-c000-0000000000f1';
  v_prop  uuid := '99999999-0000-4000-b000-0000000000f1';
  v_user  uuid := '99999999-0000-4000-a000-0000000000f1';
  v_other uuid := '99999999-0000-4000-a000-0000000000f2';
  v_tok   uuid := '99999999-0000-4000-e000-0000000000f1';
  v_new   uuid;
  v_paths int;
begin
  reset session authorization;
  insert into auth.users (id, email) values
    (v_user,  'claimer@sanpo.test'),
    (v_other, 'stranger@sanpo.test');
  insert into clients (id, operator_id, full_name, status, invite_token)
  values (v_cl, v_op, 'Claimed Then Purged', 'invited', v_tok);
  insert into properties (id, operator_id, client_id, label)
  values (v_prop, v_op, v_cl, 'Home');

  -- claim it, which writes the attempt row the purge used to choke on
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated","email":"claimer@sanpo.test"}', v_user), true);
  set local session authorization authenticated;
  if (select c.outcome from fn_claim_invite(v_tok) c) <> 'claimed' then
    raise exception 'FAIL: the fixture claim did not succeed';
  end if;
  reset session authorization;
  if (select count(*) from invite_claim_attempts where client_id = v_cl) = 0 then
    raise exception 'FAIL: fixture wrote no attempt row, so this proves nothing';
  end if;

  -- ── a stranger cannot release somebody else's client ──────────────────
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_other), true);
  set local session authorization authenticated;
  begin
    perform fn_unbind_invite(v_cl);
    raise exception 'FAIL: a stranger released another operator''s client';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%no claimed invite to release%' then
      raise exception 'FAIL: foreign unbind refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  reset session authorization;

  -- ── the operator can, and the old token dies in the same statement ────
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_op), true);
  set local session authorization authenticated;
  select fn_unbind_invite(v_cl) into v_new;
  reset session authorization;

  if v_new = v_tok then
    raise exception 'FAIL: unbind reissued the same token, so the holder can reclaim';
  end if;
  if (select auth_user_id from clients where id = v_cl) is not null then
    raise exception 'FAIL: unbind left the account bound';
  end if;
  if (select status from clients where id = v_cl) <> 'invited' then
    raise exception 'FAIL: unbind did not return the client to invited';
  end if;
  if (select notice_accepted_at from clients where id = v_cl) is not null then
    raise exception 'FAIL: unbind left the wrong claimant''s consent on the record';
  end if;
  -- the old token must be dead, not merely replaced
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated","email":"claimer@sanpo.test"}', v_user), true);
  set local session authorization authenticated;
  if (select c.outcome from fn_claim_invite(v_tok) c) <> 'not_found' then
    raise exception 'FAIL: the released token still resolves';
  end if;
  reset session authorization;

  -- unbinding twice is refused: there is nothing bound to release
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_op), true);
  set local session authorization authenticated;
  begin
    perform fn_unbind_invite(v_cl);
    raise exception 'FAIL: unbind succeeded on an unclaimed client';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%no claimed invite to release%' then
      raise exception 'FAIL: second unbind refused for the wrong reason: %', sqlerrm;
    end if;
  end;

  -- ── and the purge runs for a client carrying attempt rows ─────────────
  select count(*) into v_paths from fn_purge_client(v_cl);
  reset session authorization;
  if exists (select 1 from invite_claim_attempts where client_id = v_cl) then
    raise exception 'FAIL: the purge left the claim attempts behind';
  end if;
  if (select purged_at from clients where id = v_cl) is null then
    raise exception 'FAIL: the purge did not stamp the tombstone';
  end if;

  raise notice 'a claimed invite can be released, and purged (0042): OK';
end $$;

-- ═══ 0042: the attempt log is still append-only for everyone else ═════════
do $$
declare
  v_op uuid := '99999999-0000-4000-a000-000000000001';
  v_id uuid;
begin
  reset session authorization;
  select id into v_id from invite_claim_attempts
   where operator_id = v_op
     and client_id in (select id from clients where purged_at is null)
   limit 1;
  if v_id is null then
    raise exception 'FAIL: no attempt row on a live client, so this proves nothing';
  end if;

  -- delete is permitted ONLY once the client is purged; this one is not
  begin
    delete from invite_claim_attempts where id = v_id;
    raise exception 'FAIL: an attempt row was deleted for a live client';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%append-only%' then
      raise exception 'FAIL: attempt delete blocked for the wrong reason: %', sqlerrm;
    end if;
  end;

  -- update stays blocked unconditionally, purged or not
  begin
    update invite_claim_attempts set outcome = 'claimed' where id = v_id;
    raise exception 'FAIL: an attempt row was rewritten';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%append-only%' then
      raise exception 'FAIL: attempt update blocked for the wrong reason: %', sqlerrm;
    end if;
  end;

  raise notice 'the invite log is still append-only outside a purge (0042): OK';
end $$;

-- ═══ 0043: price snapshot, credential delete, operator-private columns ════
do $$
declare
  v_op   uuid := '99999999-0000-4000-a000-000000000001';
  v_cl   uuid := '99999999-0000-4000-c000-0000000000a1';
  v_prop uuid := '99999999-0000-4000-b000-0000000000a1';
  v_svc  uuid;
  v_walk uuid := '99999999-0000-4000-f000-0000000000a1';
  v_cost int;
begin
  reset session authorization;
  -- A dedicated service, NOT `limit 1` over the operator's services: op 1
  -- also owns 'Smoke weekend walk' (surcharge 1), the walk below is
  -- scheduled `current_date`, and fn_walk_cost adds the surcharge on
  -- Sat/Sun — so an unordered pick made this block red on weekends
  -- whenever the scan happened to return the surcharged row first
  -- (observed live on 2026-08-30, a Sunday; passed on the very next run).
  insert into service_types (id, operator_id, name, duration_minutes, credit_cost)
  values ('99999999-0000-4000-3000-000000000043', v_op, '0043 snapshot walk', 30, 2)
  returning id into v_svc;

  insert into clients (id, operator_id, full_name, status, notes)
  values (v_cl, v_op, 'Snapshot Client', 'active', 'private operator note');
  insert into properties (id, operator_id, client_id, label)
  values (v_prop, v_op, v_cl, 'Home');

  -- ── L7: the price is captured at creation, not read at completion ──────
  update service_types set credit_cost = 2 where id = v_svc;
  insert into walks (id, operator_id, client_id, property_id, service_type_id,
                     scheduled_date, window_start, window_end, status, origin_date)
  values (v_walk, v_op, v_cl, v_prop, v_svc, current_date, '09:00', '10:00',
          'scheduled', current_date);

  if (select cost_credits from walks where id = v_walk) <> 2 then
    raise exception 'FAIL: the walk did not snapshot its price at creation';
  end if;

  -- The operator raises the price AFTER the walk was agreed. The walk keeps
  -- what it was booked at — this is the whole finding.
  update service_types set credit_cost = 9 where id = v_svc;
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_op), true);
  set local session authorization authenticated;
  v_cost := fn_walk_cost(v_walk);
  reset session authorization;
  if v_cost <> 2 then
    raise exception 'FAIL: fn_walk_cost charged the NEW price (%), not the agreed one', v_cost;
  end if;

  -- A walk with no snapshot still costs what the live tables say, which is the
  -- pre-0043 behaviour every existing row relies on.
  update walks set cost_credits = null where id = v_walk;
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_op), true);
  set local session authorization authenticated;
  v_cost := fn_walk_cost(v_walk);
  reset session authorization;
  if v_cost <> 9 then
    raise exception 'FAIL: an unsnapshotted walk did not fall back to the live price (got %)', v_cost;
  end if;
  update service_types set credit_cost = 1 where id = v_svc;

  -- ── L3: the client persona cannot read the operator's private note ─────
  -- Checked through the GRANT rather than a select, because a revoked column
  -- makes `select notes` a 42501 and the point is the privilege itself.
  if has_column_privilege('authenticated', 'public.clients', 'notes', 'SELECT') then
    raise exception 'FAIL: clients.notes is still selectable by the client persona';
  end if;
  -- ...while invite_token is deliberately KEPT: the operator's InvitePanel
  -- builds the claim URL from it, and column privileges are role-wide.
  if not has_column_privilege('authenticated', 'public.clients', 'invite_token', 'SELECT') then
    raise exception 'FAIL: invite_token was revoked — the operator invite surface needs it';
  end if;

  -- ── L4: a credential cannot be hard-deleted around the vault ───────────
  if has_table_privilege('authenticated', 'public.access_credentials', 'DELETE') then
    raise exception 'FAIL: an operator can still hard-delete a credential';
  end if;

  raise notice 'price snapshot, private columns, credential delete (0043): OK';
end $$;

-- ═══ 0044: visit price — snapshot, stamping, and the top-up RPC ═══════════
do $$
declare
  v_op   uuid := '99999999-0000-4000-a000-000000000001';
  v_cl   uuid := '99999999-0000-4000-c000-0000000000b1';
  v_prop uuid := '99999999-0000-4000-b000-0000000000b1';
  v_svc  uuid := '99999999-0000-4000-d000-0000000000b1';
  v_w1   uuid := '99999999-0000-4000-f000-0000000000b1';
  v_w2   uuid := '99999999-0000-4000-f000-0000000000b2';
  v_w3   uuid := '99999999-0000-4000-f000-0000000000b3';
  v_w4   uuid := '99999999-0000-4000-f000-0000000000b4';
  v_w5   uuid := '99999999-0000-4000-f000-0000000000b5';
  v_w6   uuid := '99999999-0000-4000-f000-0000000000b6';
  v_plan uuid := '99999999-0000-4000-e000-0000000000b1';
  v_clp  uuid := '99999999-0000-4000-c000-0000000000b3';
  v_propp uuid := '99999999-0000-4000-b000-0000000000b3';
  v_clc  uuid := '99999999-0000-4000-c000-0000000000b4';
  v_propc uuid := '99999999-0000-4000-b000-0000000000b4';
begin
  reset session authorization;

  insert into clients (id, operator_id, full_name, status)
  values (v_cl, v_op, 'Visit Price Client', 'active');
  insert into properties (id, operator_id, client_id, label)
  values (v_prop, v_op, v_cl, 'Home');
  -- A dedicated service so mutating its price cannot disturb other blocks'
  -- fixtures the way sharing the seeded one would.
  insert into service_types (id, operator_id, name, duration_minutes, credit_cost)
  values (v_svc, v_op, 'PPV smoke walk', 30, 1);

  -- ── Walks created before any price exists carry no snapshot ────────────
  insert into walks (id, operator_id, client_id, property_id, service_type_id,
                     scheduled_date, window_start, window_end, status, origin_date)
  values (v_w1, v_op, v_cl, v_prop, v_svc, current_date + 1, '09:00', '10:00',
          'scheduled', current_date + 1),
         (v_w2, v_op, v_cl, v_prop, v_svc, current_date - 1, '09:00', '10:00',
          'completed', current_date - 1);
  if (select count(*) from walks
       where id in (v_w1, v_w2) and visit_price_pence is not null) <> 0 then
    raise exception 'FAIL: a walk snapshotted a visit price that did not exist';
  end if;

  -- ── Setting the price prices the queue — scheduled, unpriced rows only ──
  update service_types set visit_price_pence = 2500 where id = v_svc;
  if (select visit_price_pence from walks where id = v_w1) is distinct from 2500 then
    raise exception 'FAIL: setting a visit price did not price the scheduled walk';
  end if;
  if (select visit_price_pence from walks where id = v_w2) is not null then
    raise exception 'FAIL: setting a visit price re-priced a walk that already happened';
  end if;

  -- ── A new walk snapshots at INSERT, and later edits do not touch it ─────
  insert into walks (id, operator_id, client_id, property_id, service_type_id,
                     scheduled_date, window_start, window_end, status, origin_date)
  values (v_w3, v_op, v_cl, v_prop, v_svc, current_date + 2, '09:00', '10:00',
          'scheduled', current_date + 2);
  if (select visit_price_pence from walks where id = v_w3) is distinct from 2500 then
    raise exception 'FAIL: the walk did not snapshot the visit price at creation';
  end if;
  update service_types set visit_price_pence = 3500 where id = v_svc;
  if (select visit_price_pence from walks where id = v_w1) is distinct from 2500
     or (select visit_price_pence from walks where id = v_w3) is distinct from 2500 then
    raise exception 'FAIL: editing the visit price rewrote an agreed snapshot';
  end if;

  -- ── Clearing and re-setting fills only what was never priced ───────────
  update service_types set visit_price_pence = null where id = v_svc;
  insert into walks (id, operator_id, client_id, property_id, service_type_id,
                     scheduled_date, window_start, window_end, status, origin_date)
  values (v_w4, v_op, v_cl, v_prop, v_svc, current_date + 3, '09:00', '10:00',
          'scheduled', current_date + 3);
  update service_types set visit_price_pence = 3000 where id = v_svc;
  if (select visit_price_pence from walks where id = v_w4) is distinct from 3000 then
    raise exception 'FAIL: re-setting the price left an unpriced scheduled walk unpriced';
  end if;
  if (select visit_price_pence from walks where id = v_w1) is distinct from 2500 then
    raise exception 'FAIL: re-setting the price rewrote a walk priced at the old rate';
  end if;

  -- ── An ordinary edit also heals a walk the race left unpriced ──────────
  -- The snapshot trigger and the backfill can each miss a walk INSERTed
  -- concurrently with the price edit (documented in 0044), so the trigger
  -- fires on ANY price-bearing edit, fill-only. Simulate the orphan the way
  -- the race produces it: a scheduled walk with a null snapshot while the
  -- service is already priced.
  update walks set visit_price_pence = null where id = v_w4;
  update service_types set visit_price_pence = 3200 where id = v_svc;
  if (select visit_price_pence from walks where id = v_w4) is distinct from 3200 then
    raise exception 'FAIL: a value-to-value price edit did not heal an unpriced walk';
  end if;
  if (select visit_price_pence from walks where id = v_w1) is distinct from 2500 then
    raise exception 'FAIL: the healing edit rewrote an agreed snapshot';
  end if;

  -- ── A LIVE plan client's un-snapshotted walk is never stamped ──────────
  -- A pre-0043 row carries BOTH snapshots null even for a plan client, and
  -- charges correctly through the live plan-rate fallback. Stamping a visit
  -- price onto it would make the visit-price branch beat that fallback: a
  -- plan client billed the cash rate under a "per-visit" label their Stripe
  -- mandate never mentioned. The backfill therefore skips clients whose
  -- plan subscription is live.
  insert into plans (id, operator_id, name, credits_per_cycle, price_pence,
                     cycle, rollover_policy, overage_rate_pence)
  values (v_plan, v_op, 'PPV smoke plan', 10, 9000, 'monthly', 'none', 2200);
  insert into clients (id, operator_id, full_name, status, plan_id, subscription_status)
  values (v_clp, v_op, 'Plan Client PPV', 'active', v_plan, 'active');
  insert into properties (id, operator_id, client_id, label)
  values (v_propp, v_op, v_clp, 'Home');
  insert into walks (id, operator_id, client_id, property_id, service_type_id,
                     scheduled_date, window_start, window_end, status, origin_date)
  values (v_w5, v_op, v_clp, v_propp, v_svc, current_date + 4, '09:00', '10:00',
          'scheduled', current_date + 4);
  if (select overage_rate_pence from walks where id = v_w5) is distinct from 2200 then
    raise exception 'FAIL: a live plan client''s walk did not snapshot the plan rate';
  end if;
  -- Regress it to the pre-0043 shape: both snapshots null.
  update walks set overage_rate_pence = null, visit_price_pence = null where id = v_w5;
  update service_types set visit_price_pence = 3300 where id = v_svc;
  if (select visit_price_pence from walks where id = v_w5) is not null then
    raise exception 'FAIL: a live plan client''s walk was stamped with the cash visit price';
  end if;

  -- ── A DEAD subscription's plan prices nothing (Codex finding, #76) ─────
  -- customer.subscription.deleted keeps plan_id, so a cancelled client
  -- walked as pay-per-visit would otherwise have every new walk stamped
  -- with a rate whose Stripe mandate died with the subscription — while
  -- their card-save mandate names visit prices. The plan rate applies only
  -- while its subscription is live; the visit price takes over.
  insert into clients (id, operator_id, full_name, status, plan_id, subscription_status)
  values (v_clc, v_op, 'Cancelled Client PPV', 'active', v_plan, 'cancelled');
  insert into properties (id, operator_id, client_id, label)
  values (v_propc, v_op, v_clc, 'Home');
  insert into walks (id, operator_id, client_id, property_id, service_type_id,
                     scheduled_date, window_start, window_end, status, origin_date)
  values (v_w6, v_op, v_clc, v_propc, v_svc, current_date + 5, '09:00', '10:00',
          'scheduled', current_date + 5);
  if (select overage_rate_pence from walks where id = v_w6) is not null then
    raise exception 'FAIL: a cancelled client''s walk snapshotted the dead plan''s rate';
  end if;
  if (select visit_price_pence from walks where id = v_w6) is distinct from 3300 then
    raise exception 'FAIL: a cancelled client''s walk did not take the visit price';
  end if;
  -- And the backfill covers them too: an unpriced scheduled walk of a
  -- cancelled-with-plan client is stamped on the next price edit.
  update walks set visit_price_pence = null where id = v_w6;
  update service_types set visit_price_pence = 3400 where id = v_svc;
  if (select visit_price_pence from walks where id = v_w6) is distinct from 3400 then
    raise exception 'FAIL: the backfill skipped a cancelled-with-plan client''s walk';
  end if;
  if (select visit_price_pence from walks where id = v_w5) is not null then
    raise exception 'FAIL: the backfill stamped a LIVE plan client''s walk';
  end if;

  -- ── A zero price is a misconfiguration, not "free" (0026 precedent) ─────
  begin
    update service_types set visit_price_pence = 0 where id = v_svc;
    raise exception 'FAIL: a zero visit price was accepted';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%visit_price_pence_check%' then
      raise exception 'FAIL: zero price rejected for the wrong reason: %', sqlerrm;
    end if;
  end;

  -- ── Privileges: Settings can set the price; nobody can rewrite a snapshot ─
  if not has_column_privilege('authenticated', 'public.service_types',
                              'visit_price_pence', 'UPDATE') then
    raise exception 'FAIL: the operator cannot set a visit price from Settings';
  end if;
  if has_column_privilege('authenticated', 'public.walks',
                          'visit_price_pence', 'UPDATE') then
    raise exception 'FAIL: an API role can rewrite a walk''s visit-price snapshot';
  end if;

  raise notice 'visit price snapshot + queue pricing (0044): OK';
end $$;

-- ═══ 0044: fn_apply_topup — one transaction, one key, reversible ══════════
do $$
declare
  v_op   uuid := '99999999-0000-4000-a000-000000000001';
  v_cl   uuid := '99999999-0000-4000-c000-0000000000b2';
  v_pay  uuid;
  v_applied boolean;
  v_bal  int;
  v_out  record;
begin
  reset session authorization;

  insert into clients (id, operator_id, full_name, status)
  values (v_cl, v_op, 'Topup Client', 'active');

  -- ── An API role cannot reach it at all ─────────────────────────────────
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_op), true);
  set local session authorization authenticated;
  begin
    perform fn_apply_topup(v_cl, 5, 'pi_smoke_denied', 1000);
    raise exception 'FAIL: an API role applied a top-up';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%permission denied%' then
      raise exception 'FAIL: API-role top-up refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  reset session authorization;

  -- ── Happy path: payment row + grant, atomically ────────────────────────
  v_applied := fn_apply_topup(v_cl, 10, 'pi_smoke_topup_1', 5000);
  if not v_applied then
    raise exception 'FAIL: a fresh top-up reported duplicate';
  end if;
  select id into v_pay from payments
   where stripe_payment_intent_id = 'pi_smoke_topup_1' and type = 'topup';
  if v_pay is null then
    raise exception 'FAIL: the top-up wrote no payments row';
  end if;
  if (select status from payments where id = v_pay) <> 'succeeded'
     or (select amount_pence from payments where id = v_pay) <> 5000
     or (select stripe_invoice_id from payments where id = v_pay) <> 'pi_smoke_topup_1' then
    raise exception 'FAIL: the top-up payments row is wrong (status/amount/trace)';
  end if;
  select credit_balance into v_bal from clients where id = v_cl;
  if v_bal <> 10 then
    raise exception 'FAIL: the top-up granted % credits, expected 10', v_bal;
  end if;
  if (select count(*) from credit_ledger
       where client_id = v_cl and entry_type = 'grant'
         and stripe_invoice_id = 'pi_smoke_topup_1') <> 1 then
    raise exception 'FAIL: the top-up grant is not traceable to its payment intent';
  end if;

  -- ── Replay: Stripe redelivers for three days ───────────────────────────
  v_applied := fn_apply_topup(v_cl, 10, 'pi_smoke_topup_1', 5000);
  if v_applied then
    raise exception 'FAIL: a replayed top-up applied twice';
  end if;
  if (select count(*) from payments
       where stripe_payment_intent_id = 'pi_smoke_topup_1' and type = 'topup') <> 1
     or (select credit_balance from clients where id = v_cl) <> 10 then
    raise exception 'FAIL: the replay wrote a second payment or grant';
  end if;

  -- ── A dashboard refund claws the credits back with no topup-specific code
  --    in fn_reverse_payment: the PI id in stripe_invoice_id IS the
  --    grant↔money trace 0023 built. This assertion is what guards that
  --    design decision — drop the trace and the clawback silently stops. ───
  select * into v_out from fn_reverse_payment(v_pay, 'refund', 5000, 'smoke');
  if v_out.outcome <> 'reversed' or v_out.credits_reversed <> 10
     or v_out.needs_review then
    raise exception 'FAIL: top-up refund did not claw back (outcome %, reversed %, review %)',
      v_out.outcome, v_out.credits_reversed, v_out.needs_review;
  end if;
  if (select credit_balance from clients where id = v_cl) <> 0 then
    raise exception 'FAIL: refunded top-up left the credits in the balance';
  end if;

  -- ── Replay AFTER the refund: the 0023 lesson — a reversed row must keep
  --    holding its idempotency slot, or redelivery grants a second batch. ──
  v_applied := fn_apply_topup(v_cl, 10, 'pi_smoke_topup_1', 5000);
  if v_applied or (select credit_balance from clients where id = v_cl) <> 0 then
    raise exception 'FAIL: a redelivery after refund granted a second batch';
  end if;

  -- ── Malformed calls fail before any effect ─────────────────────────────
  begin
    perform fn_apply_topup(v_cl, 0, 'pi_smoke_topup_2', 1000);
    raise exception 'FAIL: a zero-credit top-up was accepted';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%credits must be positive%' then
      raise exception 'FAIL: zero credits rejected for the wrong reason: %', sqlerrm;
    end if;
  end;
  begin
    perform fn_apply_topup(v_cl, 5, '', 1000);
    raise exception 'FAIL: an empty payment intent id was accepted';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%payment intent id required%' then
      raise exception 'FAIL: empty PI rejected for the wrong reason: %', sqlerrm;
    end if;
  end;
  begin
    perform fn_apply_topup(v_cl, 5, 'pi_smoke_topup_3', 0);
    raise exception 'FAIL: a zero-amount top-up was accepted — unrefundable by construction';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%amount must be positive%' then
      raise exception 'FAIL: zero amount rejected for the wrong reason: %', sqlerrm;
    end if;
  end;
  begin
    perform fn_apply_topup('99999999-0000-4000-c000-00000000dead', 5, 'pi_x', 1000);
    raise exception 'FAIL: a top-up for an unknown client was accepted';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%unknown client%' then
      raise exception 'FAIL: unknown client rejected for the wrong reason: %', sqlerrm;
    end if;
  end;

  raise notice 'fn_apply_topup: idempotent, reversible, service-role only (0044): OK';
end $$;


-- ═══ 0045: platform billing state is not self-servable ═════════════════════
--
-- The INSERT grant on operators became a column list, because the table-level
-- grant let a new operator create their own row with trial_ends_at in 2099 or
-- platform_subscription_status = 'active' and never pay — and, pre-existing,
-- forge stripe_charges_enabled at signup. Driven LIVE as authenticated, not
-- read from the catalog: the migration's refuse block already asks
-- has_column_privilege, and asking the same function twice proves nothing.
do $$
declare
  v_trial timestamptz;
begin
  reset session authorization;
  insert into auth.users (id, email) values
    ('99999999-0000-4000-a000-000000003101', 'h31-op1@sanpo.test'),
    ('99999999-0000-4000-a000-000000003102', 'h31-op2@sanpo.test');

  -- Signup in Onboard's exact shape still works under the narrowed grant —
  -- including the terms pair, whose loss would silently stop recording
  -- consent (H6).
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000003101","role":"authenticated","email":"h31-op1@sanpo.test"}', true);
  set local session authorization authenticated;
  begin
    -- Every column Onboard sends, including phone at an explicit NULL: the
    -- key alone puts the column in PostgREST's INSERT list, which requires
    -- the privilege — omitting it here let a grant list without phone pass
    -- every gate while breaking every real signup (adversarial review).
    insert into operators (id, business_name, display_name, email, phone, terms_version, terms_accepted_at)
    values ('99999999-0000-4000-a000-000000003101', 'H31 Walks', 'H31', 'h31-op1@sanpo.test',
            null, '2026-08-29', now());
  exception when others then
    raise exception 'FAIL: the operators INSERT list broke signup in Onboard''s shape: % (%)', sqlerrm, sqlstate;
  end;
  reset session authorization;

  -- The row they got carries the defaulted 14-day trial, not one they chose.
  select trial_ends_at into v_trial from operators
   where id = '99999999-0000-4000-a000-000000003101';
  if v_trial is null
     or v_trial < now() + interval '13 days'
     or v_trial > now() + interval '15 days' then
    raise exception 'FAIL: a fresh operator did not get a 14-day trial (got %)', v_trial;
  end if;

  -- The forbidden columns, one live attempt each. 42501 specifically: a
  -- refusal for any other reason (RLS, constraint) would pass a broken grant.
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000003102","role":"authenticated","email":"h31-op2@sanpo.test"}', true);
  set local session authorization authenticated;
  begin
    insert into operators (id, business_name, display_name, email, trial_ends_at)
    values ('99999999-0000-4000-a000-000000003102', 'Cheat', 'Cheat', 'h31-op2@sanpo.test',
            now() + interval '73 years');
    raise exception 'FAIL: an operator inserted their own trial_ends_at';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlstate <> '42501' then
      raise exception 'FAIL: trial_ends_at insert refused for the wrong reason: % (%)', sqlerrm, sqlstate;
    end if;
  end;
  begin
    insert into operators (id, business_name, display_name, email, platform_subscription_status)
    values ('99999999-0000-4000-a000-000000003102', 'Cheat', 'Cheat', 'h31-op2@sanpo.test', 'active');
    raise exception 'FAIL: an operator inserted their own subscription status';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlstate <> '42501' then
      raise exception 'FAIL: subscription-status insert refused for the wrong reason: % (%)', sqlerrm, sqlstate;
    end if;
  end;
  begin
    insert into operators (id, business_name, display_name, email, stripe_charges_enabled)
    values ('99999999-0000-4000-a000-000000003102', 'Cheat', 'Cheat', 'h31-op2@sanpo.test', true);
    raise exception 'FAIL: an operator forged stripe_charges_enabled at signup (pre-0045 hole)';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlstate <> '42501' then
      raise exception 'FAIL: charges-enabled insert refused for the wrong reason: % (%)', sqlerrm, sqlstate;
    end if;
  end;

  -- ...and the honest shape still goes through for that same user.
  begin
    insert into operators (id, business_name, display_name, email)
    values ('99999999-0000-4000-a000-000000003102', 'H31 Walks 2', 'H31-2', 'h31-op2@sanpo.test');
  exception when others then
    raise exception 'FAIL: the minimal signup shape was refused: % (%)', sqlerrm, sqlstate;
  end;

  -- UPDATE was already a column list; pin that the new columns stayed out.
  begin
    update operators set platform_subscription_status = 'active'
     where id = '99999999-0000-4000-a000-000000003102';
    raise exception 'FAIL: an operator rewrote their own subscription status';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlstate <> '42501' then
      raise exception 'FAIL: subscription-status update refused for the wrong reason: % (%)', sqlerrm, sqlstate;
    end if;
  end;
  reset session authorization;

  raise notice 'operator billing state is not self-servable (0045): OK';
end $$;

-- ═══ 0045: the signup pre-flight answers exactly what the claim would ══════
--
-- fn_invite_signup_check exists so claim-signup can refuse a dead invite
-- BEFORE creating an auth account. Its whole contract is parity: for every
-- outcome, the check's answer equals fn_claim_invite's answer for the same
-- token and email. Driven across both functions here, because the two
-- ladders live in different migrations and nothing else stops them drifting.
do $$
declare
  v_check invite_claim_outcome;
  v_claim invite_claim_outcome;
begin
  reset session authorization;
  insert into clients (id, operator_id, full_name, status, invite_token, invite_expires_at)
  values ('99999999-0000-4000-c000-000000003101', '99999999-0000-4000-a000-000000000001',
          'H31 Expired', 'invited', '99999999-0000-4000-e000-000000003101',
          now() - interval '1 day');
  insert into clients (id, operator_id, full_name, status, invite_token, invite_revoked_at)
  values ('99999999-0000-4000-c000-000000003102', '99999999-0000-4000-a000-000000000001',
          'H31 Revoked', 'invited', '99999999-0000-4000-e000-000000003102', now());
  insert into clients (id, operator_id, full_name, email, status, invite_token)
  values ('99999999-0000-4000-c000-000000003103', '99999999-0000-4000-a000-000000000001',
          'H31 Bound', 'h31-a@sanpo.test', 'invited', '99999999-0000-4000-e000-000000003103'),
         ('99999999-0000-4000-c000-000000003104', '99999999-0000-4000-a000-000000000001',
          'H31 Open', 'h31-a@sanpo.test', 'invited', '99999999-0000-4000-e000-000000003104');
  -- Email NULL is an ordinary product state (Roster stores '' as null): the
  -- FIRST address the pre-flight admits RESERVES the invite (Codex review on
  -- PR #77 — unreserved, one leaked token minted an auth account per address
  -- until expiry), and every later address refuses as email_mismatch on both
  -- sides of the parity. A drifted guard (plain `is distinct from` without
  -- the not-null wrapper) still has its own cell below: it would refuse the
  -- FIRST address too (adversarial review).
  insert into clients (id, operator_id, full_name, status, invite_token)
  values ('99999999-0000-4000-c000-000000003105', '99999999-0000-4000-a000-000000000001',
          'H31 Unbound', 'invited', '99999999-0000-4000-e000-000000003105');
  insert into auth.users (id, email) values
    ('99999999-0000-4000-a000-000000003111', 'h31-a@sanpo.test'),
    ('99999999-0000-4000-a000-000000003112', 'h31-b@sanpo.test'),
    ('99999999-0000-4000-a000-000000003113', 'anyone@sanpo.test');

  -- Parity on every refusal: check as the service session, then the real
  -- claim as a signed-in user with the same email, and the answers match.
  v_check := fn_invite_signup_check('99999999-0000-4000-e000-000000003101', 'h31-a@sanpo.test');
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000003111","role":"authenticated","email":"h31-a@sanpo.test"}', true);
  set local session authorization authenticated;
  select c.outcome into v_claim from fn_claim_invite('99999999-0000-4000-e000-000000003101') c;
  reset session authorization;
  if v_check <> 'expired' or v_check <> v_claim then
    raise exception 'FAIL: expired parity broke — check said %, claim said %', v_check, v_claim;
  end if;

  v_check := fn_invite_signup_check('99999999-0000-4000-e000-000000003102', 'h31-a@sanpo.test');
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000003111","role":"authenticated","email":"h31-a@sanpo.test"}', true);
  set local session authorization authenticated;
  select c.outcome into v_claim from fn_claim_invite('99999999-0000-4000-e000-000000003102') c;
  reset session authorization;
  if v_check <> 'revoked' or v_check <> v_claim then
    raise exception 'FAIL: revoked parity broke — check said %, claim said %', v_check, v_claim;
  end if;

  -- The forwarded link: the pre-flight refuses the wrong address before an
  -- account exists, exactly as the claim would after.
  v_check := fn_invite_signup_check('99999999-0000-4000-e000-000000003103', 'h31-b@sanpo.test');
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000003112","role":"authenticated","email":"h31-b@sanpo.test"}', true);
  set local session authorization authenticated;
  select c.outcome into v_claim from fn_claim_invite('99999999-0000-4000-e000-000000003103') c;
  reset session authorization;
  if v_check <> 'email_mismatch' or v_check <> v_claim then
    raise exception 'FAIL: mismatch parity broke — check said %, claim said %', v_check, v_claim;
  end if;

  if fn_invite_signup_check('99999999-0000-4000-e000-0000000dead1', 'h31-a@sanpo.test')
       <> 'not_found' then
    raise exception 'FAIL: an unknown token was not not_found';
  end if;

  -- The unbound invite admits its FIRST address — and reserves it.
  v_check := fn_invite_signup_check('99999999-0000-4000-e000-000000003105', 'anyone@sanpo.test');
  if v_check <> 'claimed' then
    raise exception 'FAIL: an email-less invite was refused at signup as %', v_check;
  end if;
  if (select email from clients where id = '99999999-0000-4000-c000-000000003105')
       is distinct from 'anyone@sanpo.test' then
    raise exception 'FAIL: the admitted address was not reserved — one leaked token still mints an account per address';
  end if;
  -- The same address again is an idempotent retry (a failed createUser must
  -- be retryable); a DIFFERENT address is the mint hole, closed.
  if fn_invite_signup_check('99999999-0000-4000-e000-000000003105', 'anyone@sanpo.test')
       <> 'claimed' then
    raise exception 'FAIL: the reserved address cannot retry its own signup';
  end if;
  v_check := fn_invite_signup_check('99999999-0000-4000-e000-000000003105', 'else@sanpo.test');
  if v_check <> 'email_mismatch' then
    raise exception 'FAIL: a second address on a reserved invite was admitted as % — unlimited account minting', v_check;
  end if;
  if (select count(*) from invite_claim_attempts
       where client_id = '99999999-0000-4000-c000-000000003105'
         and attempted_by is null
         and outcome = 'email_mismatch'
         and attempted_email = 'else@sanpo.test') <> 1 then
    raise exception 'FAIL: the refused second address left no pre-account log row';
  end if;
  -- Parity holds THROUGH the reservation: the claim now enforces the address
  -- the pre-flight reserved, on the account the pre-flight admitted.
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000003112","role":"authenticated","email":"h31-b@sanpo.test"}', true);
  set local session authorization authenticated;
  select c.outcome into v_claim from fn_claim_invite('99999999-0000-4000-e000-000000003105') c;
  reset session authorization;
  if v_claim <> 'email_mismatch' then
    raise exception 'FAIL: reservation parity broke — check refused else@, claim admitted a third party as %', v_claim;
  end if;
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000003113","role":"authenticated","email":"anyone@sanpo.test"}', true);
  set local session authorization authenticated;
  select c.outcome into v_claim from fn_claim_invite('99999999-0000-4000-e000-000000003105') c;
  reset session authorization;
  if v_claim <> 'claimed' then
    raise exception 'FAIL: the reserved address itself could not claim — reservation over-closed, %', v_claim;
  end if;

  -- The happy path, case- and whitespace-insensitive like the claim — and
  -- on a BOUND invite the check binds no ACCOUNT: it predicts, the claim
  -- decides. (The one thing it may bind is the email of an UNBOUND invite —
  -- the reservation cell above.)
  v_check := fn_invite_signup_check('99999999-0000-4000-e000-000000003104', '  H31-A@Sanpo.Test ');
  if v_check <> 'claimed' then
    raise exception 'FAIL: a live invite for the invited address was refused as %', v_check;
  end if;
  if (select auth_user_id from clients
       where id = '99999999-0000-4000-c000-000000003104') is not null then
    raise exception 'FAIL: the pre-flight bound an account';
  end if;
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000003111","role":"authenticated","email":"h31-a@sanpo.test"}', true);
  set local session authorization authenticated;
  select c.outcome into v_claim from fn_claim_invite('99999999-0000-4000-e000-000000003104') c;
  reset session authorization;
  if v_claim <> 'claimed' then
    raise exception 'FAIL: the claim the pre-flight approved was refused as %', v_claim;
  end if;
  -- ...and now the check reports what the claim made true.
  if fn_invite_signup_check('99999999-0000-4000-e000-000000003104', 'h31-a@sanpo.test')
       <> 'already_claimed' then
    raise exception 'FAIL: a claimed invite did not read already_claimed from the pre-flight';
  end if;

  -- The log: refusals leave pre-account rows (attempted_by null, naming the
  -- address that tried), and the pass leaves none — the real claim writes
  -- the 'claimed' row moments later, and double-logging every legitimate
  -- signup would bury the probes this trail exists to surface.
  -- The pass check comes FIRST: an over-logging implementation trips the
  -- row count too, and this is the sentence that names its actual defect.
  if exists (select 1 from invite_claim_attempts
       where client_id = '99999999-0000-4000-c000-000000003104'
         and attempted_by is null
         and outcome = 'claimed') then
    raise exception 'FAIL: a passing pre-flight was logged — every signup now double-logs';
  end if;
  if (select count(*) from invite_claim_attempts
       where attempted_by is null
         and client_id in ('99999999-0000-4000-c000-000000003101',
                           '99999999-0000-4000-c000-000000003102',
                           '99999999-0000-4000-c000-000000003103',
                           '99999999-0000-4000-c000-000000003104')) <> 4 then
    raise exception 'FAIL: pre-flight refusals were not all logged (expected 4 pre-account rows, got %)',
      (select count(*) from invite_claim_attempts
        where attempted_by is null
          and client_id in ('99999999-0000-4000-c000-000000003101',
                            '99999999-0000-4000-c000-000000003102',
                            '99999999-0000-4000-c000-000000003103',
                            '99999999-0000-4000-c000-000000003104'));
  end if;
  if (select count(*) from invite_claim_attempts
       where client_id = '99999999-0000-4000-c000-000000003103'
         and attempted_by is null
         and outcome = 'email_mismatch'
         and attempted_email = 'h31-b@sanpo.test') <> 1 then
    raise exception 'FAIL: the pre-account mismatch row does not name the address that tried';
  end if;

  -- Service session only: the ladder answers questions about other people's
  -- invites, so an authenticated caller must be refused at the door.
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-000000003111","role":"authenticated","email":"h31-a@sanpo.test"}', true);
  set local session authorization authenticated;
  begin
    perform fn_invite_signup_check('99999999-0000-4000-e000-000000003104', 'h31-a@sanpo.test');
    raise exception 'FAIL: an authenticated caller ran the signup pre-flight';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlstate <> '42501' and sqlerrm not like '%service role required%' then
      raise exception 'FAIL: pre-flight refused for the wrong reason: % (%)', sqlerrm, sqlstate;
    end if;
  end;
  reset session authorization;

  raise notice 'signup pre-flight mirrors the claim ladder (0045): OK';
end $$;


-- ═══ 0046: an erased record cannot be made claimable again ════════════════
--
-- `fn_purge_client` leaves the tombstone safe at rest — email NULL, a fresh
-- invite_token nobody holds, and invite_revoked_at set. `fn_rotate_invite`
-- used to set invite_revoked_at back to NULL and stamp a fresh 14-day expiry,
-- and since a purge also NULLs auth_user_id the tombstone looked exactly like
-- an unclaimed client to it. A NULL email is the ladder rung that admits ANY
-- address, so one press of "Send a new invite" made an erased client claimable
-- by a stranger — whose address the signup pre-flight would then RESERVE onto
-- the tombstone, writing personal data back into a record erased on request.
--
-- The end-to-end assertion is the one that matters, so it is made through
-- `fn_invite_signup_check` rather than by reading the columns: checking
-- invite_revoked_at alone would pass against a rotate that cleared the guard
-- some other way.
do $$
declare
  v_op  uuid := '99999999-0000-4000-a000-000000000001';
  v_cl  uuid := '99999999-0000-4000-c000-0000000000f6';
  v_tok uuid;
  v_n   integer;
begin
  reset session authorization;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into clients (id, operator_id, full_name, status, email,
                       invite_token, invite_expires_at)
  values (v_cl, v_op, '0046 Purge Invite', 'invited', 'f6@sanpo.test',
          '99999999-0000-4000-e000-0000000000f6', now() + interval '7 days');

  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_op), true);
  set local session authorization authenticated;
  select count(*) into v_n from fn_purge_client(v_cl);

  if (select invite_revoked_at from clients where id = v_cl) is null then
    raise exception 'FAIL: the purge left the invite live';
  end if;

  -- The fix. Refused for the same reason as every other miss, so the message
  -- stays a non-oracle over client ids.
  begin
    perform fn_rotate_invite(v_cl);
    raise exception 'FAIL: an invite was reissued for a purged client';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%no unclaimed invite%' then
      raise exception 'FAIL: rotate on a tombstone refused for the wrong reason: %', sqlerrm;
    end if;
  end;

  -- The deliberate asymmetry: revoke KILLS a token, so it must stay reachable.
  -- It is the only in-product remedy for a row that already carried a live
  -- invite before 0046, and refusing it would strand exactly those rows.
  -- Wrapped rather than called bare: if a future change guards revoke too, an
  -- unhandled exception here aborts the suite with the function's own message,
  -- which reads as a broken suite rather than a broken rule (the 0038 lesson).
  begin
    perform fn_revoke_invite(v_cl);
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    raise exception 'FAIL: revoke no longer works on a purged client (%) — it is the only in-product remedy for a row that already carries a live invite', sqlerrm;
  end;
  if (select invite_revoked_at from clients where id = v_cl) is null then
    raise exception 'FAIL: revoke no longer works on a purged client';
  end if;
  reset session authorization;

  -- End to end: the tombstone's token admits nobody.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select invite_token into v_tok from clients where id = v_cl;
  if fn_invite_signup_check(v_tok, 'stranger@example.test') = 'claimed' then
    raise exception 'FAIL: a stranger can claim an erased client';
  end if;
  if (select email from clients where id = v_cl) is not null then
    raise exception 'FAIL: the refused pre-flight still reserved an address onto the tombstone';
  end if;

  raise notice 'a purged client cannot be made claimable again (0046): OK';
end $$;

-- ═══ 0046: the one-click unsubscribe link dies with the address ═══════════
--
-- `unsubscribe_token` is a bearer credential and `fn_unsubscribe_by_token`
-- suppresses whatever address the row holds AT CLICK TIME. So without this,
-- the stranger who received a mistyped email held a link that suppressed the
-- CORRECTED address — terminally, since a suppression is recorded as `skipped`
-- and the nightly drain never retries it.
--
-- The edits are made as the OPERATOR, which is the path that actually happens
-- and the one that proves the grant interaction: `authenticated` may update
-- `email` and may neither read nor write `unsubscribe_token` (0038), so the
-- rotation has to come from the trigger. Each read of the token therefore
-- drops back to the service role — reading it as the operator is itself a
-- permission error, which is the property 0038 exists for.
--
-- Asserted in four directions. The two negatives are the load-bearing ones: a
-- trigger that rotated on every update would pass the positives alone while
-- killing a live unsubscribe path on every unrelated edit.
do $$
declare
  v_op  uuid := '99999999-0000-4000-a000-000000000001';
  v_cl  uuid := '99999999-0000-4000-c000-0000000000f7';
  v_t0 uuid; v_t1 uuid; v_t2 uuid; v_t3 uuid; v_t4 uuid;
begin
  reset session authorization;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into clients (id, operator_id, full_name, status, email)
  values (v_cl, v_op, '0046 Token Rotation', 'invited', 'typo@sanpo.test');
  select unsubscribe_token into v_t0 from clients where id = v_cl;

  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_op), true);

  -- The operator cannot read the token at all — the 0038 property this rests on.
  set local session authorization authenticated;
  begin
    perform unsubscribe_token from clients where id = v_cl;
    raise exception 'FAIL: the operator can read the unsubscribe token';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  -- 1. the address changes -> the old link must die
  update clients set email = 'correct@sanpo.test' where id = v_cl;
  reset session authorization;
  select unsubscribe_token into v_t1 from clients where id = v_cl;
  if v_t1 = v_t0 then
    raise exception 'FAIL: correcting the address left the old unsubscribe link live';
  end if;

  -- 2. capitalisation only -> the same inbox, so the link must survive
  set local session authorization authenticated;
  update clients set email = 'Correct@Sanpo.TEST' where id = v_cl;
  reset session authorization;
  select unsubscribe_token into v_t2 from clients where id = v_cl;
  if v_t2 <> v_t1 then
    raise exception 'FAIL: a capitalisation fix killed a live unsubscribe link';
  end if;

  -- 3. an unrelated column -> untouched
  set local session authorization authenticated;
  update clients set phone = '+1 555-0146' where id = v_cl;
  reset session authorization;
  select unsubscribe_token into v_t3 from clients where id = v_cl;
  if v_t3 <> v_t2 then
    raise exception 'FAIL: an unrelated edit rotated the unsubscribe token';
  end if;

  -- 4. clearing the address counts as a change (NULL against an address)
  set local session authorization authenticated;
  update clients set email = null where id = v_cl;
  reset session authorization;
  select unsubscribe_token into v_t4 from clients where id = v_cl;
  if v_t4 = v_t3 then
    raise exception 'FAIL: clearing the address left the old unsubscribe link live';
  end if;

  raise notice 'the unsubscribe token dies with the address it was sent to (0046): OK';
end $$;

-- ═══ 0046: nothing else may rewrite clients.email in a BEFORE trigger ═════
--
-- The precondition the rotation trigger rests on, made executable (Codex
-- review, PR #80). Postgres fires BEFORE ROW triggers in NAME order and a
-- BEFORE trigger sees only the row image as it stands when it runs, so a
-- trigger sorting after `trg_clients_rotate_unsubscribe_token` that assigns
-- `new.email` would change the address AFTER the comparison and the token
-- would not rotate — a stranger's one-click link would then survive the
-- correction that was supposed to kill it.
--
-- That cannot be closed by construction without an AFTER trigger issuing a
-- second UPDATE on every address change, so it is a precondition instead, and
-- this is what stops it being a precondition nobody checks. It fails the build
-- the moment such a trigger appears, which is the point at which somebody can
-- still choose a different design.
--
-- Honest about what it is: a heuristic over `prosrc`, matching the assignment
-- forms PL/pgSQL actually offers (`new.email :=` and `into ... new.email`). It
-- is not a proof that no trigger can reach the column; it is a tripwire on the
-- ways one plausibly would.
do $$
declare
  v_offenders text;
begin
  reset session authorization;
  select string_agg(p.proname || ' (via ' || tg.tgname || ')', ', ')
    into v_offenders
    from pg_trigger tg
    join pg_proc p on p.oid = tg.tgfoid
   where tg.tgrelid = 'clients'::regclass
     and not tg.tgisinternal
     -- 2 = BEFORE, 4 = ROW  (tgtype bitmask)
     and (tg.tgtype & 2) = 2
     and (tg.tgtype & 1) = 1
     and tg.tgname <> 'trg_clients_rotate_unsubscribe_token'
     and (p.prosrc ~* 'new\s*\.\s*email\s*:='
       or p.prosrc ~* 'into\s+new\s*\.\s*email');

  if v_offenders is not null then
    raise exception
      'FAIL: a BEFORE UPDATE trigger on clients assigns new.email (%) — it may sort after trg_clients_rotate_unsubscribe_token, in which case the unsubscribe token stops rotating on an address change (0046)',
      v_offenders;
  end if;

  raise notice 'nothing else rewrites clients.email in a BEFORE trigger (0046): OK';
end $$;

-- ── 0047: the walk photo integrity record ────────────────────────────────
--
-- Two properties, neither of which is a restatement of the DDL.
--
-- FIRST, `ignoreDuplicates` in both writers is load-bearing for INTEGRITY and
-- not merely for row counts. `complete-walk` replays every photo path from the
-- completion request, and it has paths and no bytes — so it cannot compute a
-- digest and must not invent one. Its upsert is ON CONFLICT DO NOTHING; if it
-- were ever DO UPDATE, replaying a path would blank the digest the browser
-- recorded, and there is no UPDATE grant with which to put it back.
--
-- SECOND, the digest is write-once. That is what makes it a record of the past
-- rather than a description of the present, and it is enforced by the grant.
do $$
declare
  v_walk uuid; v_op uuid; v_sha text := repeat('a', 64); v_after text;
begin
  select id, operator_id into v_walk, v_op from walks limit 1;
  if v_walk is null then raise exception 'FAIL: no walk fixture for the 0047 block'; end if;

  insert into walk_photos (walk_id, operator_id, storage_path, sha256, byte_size)
  values (v_walk, v_op, 'smoke/0047.jpg', v_sha, 4242);

  -- The complete-walk replay, exactly as postgrest issues it for
  -- `ignoreDuplicates: true` — and note it sends the unmentioned columns as
  -- explicit NULLs, which is why DO UPDATE would erase rather than skip.
  insert into walk_photos (walk_id, operator_id, storage_path, taken_at, sha256, byte_size)
  values (v_walk, v_op, 'smoke/0047.jpg', now(), null, null)
  on conflict (walk_id, storage_path) do nothing;

  select sha256 into v_after from walk_photos
   where walk_id = v_walk and storage_path = 'smoke/0047.jpg';
  if v_after is distinct from v_sha then
    raise exception 'FAIL: a completion replay erased the digest recorded at upload (0047) — got %', coalesce(v_after, '<null>');
  end if;

  -- Write-once, by grant. If UPDATE ever appears here the digest stops being
  -- evidence of anything, because its own writer could rewrite it.
  if has_table_privilege('authenticated', 'walk_photos', 'UPDATE') then
    raise exception 'FAIL: authenticated can UPDATE walk_photos, so a recorded digest is rewritable (0047)';
  end if;

  -- The stored form is exactly what the verification script compares against:
  -- `sha256sum` emits lower-case hex, so upper-case or truncated values are
  -- refused at write time rather than discovered at verification time.
  begin
    insert into walk_photos (walk_id, operator_id, storage_path, sha256)
    values (v_walk, v_op, 'smoke/0047-upper.jpg', upper(v_sha));
    raise exception 'FAIL: upper-case hex was accepted into walk_photos.sha256 (0047)';
  exception when check_violation then null;
  end;

  -- A zero-byte object is a failed upload wearing a successful one's clothes.
  begin
    insert into walk_photos (walk_id, operator_id, storage_path, byte_size)
    values (v_walk, v_op, 'smoke/0047-zero.jpg', 0);
    raise exception 'FAIL: byte_size 0 was accepted into walk_photos (0047)';
  exception when check_violation then null;
  end;

  -- And NULL stays legal: rows predating 0047, and rows complete-walk won the
  -- race for, are permanently "not recorded" and must not be refused.
  insert into walk_photos (walk_id, operator_id, storage_path)
  values (v_walk, v_op, 'smoke/0047-null.jpg');

  raise notice 'the walk photo digest survives a completion replay and is write-once (0047): OK';
end $$;

-- ── 0048: the claim-signup rate limit ────────────────────────────────────
--
-- `claim-signup` is the one genuinely public endpoint that creates accounts,
-- and until 0048 nothing bounded it. This block pins the four properties the
-- design rests on; none of them is a restatement of the DDL.
--
-- Note on `now()`: it is TRANSACTION-constant, so every row this block writes
-- carries the same `attempted_at` and the window cannot elapse on its own
-- (the 0028 lesson). The window is therefore crossed by backdating the rows,
-- which is also the only way to test the prune at all.
do $$
declare
  v_op      uuid := '99999999-0000-4000-a000-000000000001';
  v_cl      uuid := '99999999-0000-4000-c000-0000000000f8';
  v_cl2     uuid := '99999999-0000-4000-c000-0000000000f9';
  v_tok     uuid := '99999999-0000-4000-b000-0000000000f8';
  v_tok2    uuid := '99999999-0000-4000-b000-0000000000f9';
  v_cl3     uuid := '99999999-0000-4000-c000-0000000000fa';
  v_tok3    uuid := '99999999-0000-4000-b000-0000000000fa';
  v_unknown uuid := '99999999-0000-4000-b000-00000000dead';
  v_allowed int := 0;
  v_rows    int;
  v_total   int;
  v_ok      boolean;
  i         int;
begin
  reset session authorization;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into clients (id, operator_id, full_name, status, invite_token)
  values (v_cl,  v_op, '0048 Rate Limit',   'invited', v_tok),
         (v_cl2, v_op, '0048 Rate Limit 2', 'invited', v_tok2);

  -- 1. A token matching no client is ALLOWED and records nothing.
  --
  -- Both halves matter. Refusing it would make the limiter a token-existence
  -- oracle — the one thing this ordering exists to avoid, since the endpoint
  -- already answers `not_found` for such a token on request one. And writing
  -- a row would hand an attacker an unbounded growth vector, because the
  -- token is caller-supplied and random uuids are free.
  select count(*) into v_total from invite_signup_attempts;
  for i in 1..5 loop
    -- Wrapped: without the null-client branch the insert hits its NOT NULL and
    -- the function RAISES, which without this reads as a broken suite rather
    -- than as a public endpoint that 500s on every unknown token.
    begin
      v_ok := fn_invite_signup_allow_attempt(p_token => v_unknown);
    exception when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      raise exception 'FAIL: a token matching no client raised "%" (0048) — the endpoint 500s where it should answer not_found', sqlerrm;
    end;
    if not v_ok then
      raise exception 'FAIL: a token matching no client was refused (0048) — the limiter is a token-existence oracle';
    end if;
  end loop;
  if (select count(*) from invite_signup_attempts) <> v_total then
    raise exception 'FAIL: a token matching no client wrote a row (0048) — unbounded growth from a caller-supplied key';
  end if;

  -- 2. A real token gets exactly `p_limit` attempts, then is refused.
  --
  -- Every attempt counts, including the ones that would SUCCEED — a limiter
  -- counting only refusals would leave the correct address unlimited while
  -- every wrong one was refused, which is the oracle wearing the fix's
  -- clothes. That ordering lives in the edge handler; what is pinned here is
  -- that the function itself charges every call.
  for i in 1..10 loop
    if fn_invite_signup_allow_attempt(p_token => v_tok, p_ip => '203.0.113.7') then
      v_allowed := v_allowed + 1;
    end if;
  end loop;
  if v_allowed <> 10 then
    raise exception 'FAIL: the first 10 attempts did not all pass (0048) — % allowed', v_allowed;
  end if;
  for i in 1..3 loop
    if fn_invite_signup_allow_attempt(p_token => v_tok) then
      raise exception 'FAIL: attempt % passed after the budget was spent (0048)', 10 + i;
    end if;
  end loop;

  select count(*) into v_rows from invite_signup_attempts where client_id = v_cl;
  if v_rows <> 10 then
    raise exception 'FAIL: % rows recorded for a 10-attempt budget (0048) — a refused attempt must not be charged twice', v_rows;
  end if;

  -- 3. A second client's budget is its own.
  --
  -- The key is the client the invite belongs to. A limiter keyed on anything
  -- global — or on the caller, whose IP the attacker controls and the victim
  -- does not — would refuse this.
  if not fn_invite_signup_allow_attempt(p_token => v_tok2) then
    raise exception 'FAIL: one client exhausting its budget refused another client (0048)';
  end if;

  -- 4. The window self-heals, and the table has a CEILING.
  --
  -- This is the assertion that makes "no retention sweep is needed" a
  -- property rather than an omission: the function prunes the key's expired
  -- rows before counting, so crossing a window replaces the old rows rather
  -- than adding to them. Without the prune the count would still be correct
  -- (it filters on the cutoff) and the table would grow at 10 rows per client
  -- per hour, forever.
  update invite_signup_attempts
     set attempted_at = now() - interval '2 hours'
   where client_id = v_cl;

  if not fn_invite_signup_allow_attempt(p_token => v_tok) then
    raise exception 'FAIL: the budget did not heal after the window elapsed (0048)';
  end if;
  select count(*) into v_rows from invite_signup_attempts where client_id = v_cl;
  if v_rows > 10 then
    raise exception 'FAIL: % rows for one client after crossing a window (0048) — expired rows are not pruned, so the table has no ceiling', v_rows;
  end if;

  -- 5. A REISSUED invite starts with a fresh budget.
  --
  -- Codex review on PR #84. The budget is keyed on the client and every
  -- reissue path mints a token on the SAME row, so without the reset trigger
  -- a token holder who spent the budget also spent it for the operator's
  -- remedy — and this file's own header listed "the operator can reissue"
  -- as a mitigation for exactly that denial of service. Measured before the
  -- fix: reissue, and the brand-new token was still refused with all ten
  -- rows intact.
  --
  -- Asserted through fn_rotate_invite, which is the path an operator takes,
  -- rather than by updating the column directly — a test that writes the
  -- column itself would pass against a trigger nothing real can reach.
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_op), true);
  v_tok := fn_rotate_invite(v_cl);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select count(*) into v_rows from invite_signup_attempts where client_id = v_cl;
  if v_rows <> 0 then
    raise exception 'FAIL: reissuing the invite left % attempt rows (0048) — the documented remedy for a burned budget does not work, and a purged client keeps IP addresses forever', v_rows;
  end if;
  if not fn_invite_signup_allow_attempt(p_token => v_tok) then
    raise exception 'FAIL: a freshly reissued invite is still rate-limited (0048)';
  end if;

  -- 6. A client deleted mid-attempt must not 500 a PUBLIC endpoint.
  --
  -- The token lookup is unlocked, so an operator deleting an unclaimed client
  -- between it and the insert leaves the FK to raise. Injected deterministically
  -- at exactly that point with a BEFORE INSERT trigger, because the race cannot
  -- be interleaved inside a single RPC call. Measured before the fix: SQLSTATE
  -- 23503 propagated out of the function.
  --
  -- ALLOW is the right answer, not refuse: the caller goes on to the check,
  -- which answers `not_found` — true by then. This is 0045's handling of the
  -- same permitted race, applied to the function in front of it.
  insert into clients (id, operator_id, full_name, status, invite_token)
  values (v_cl3, v_op, '0048 FK Race', 'invited', v_tok3);
  create function _smoke_0048_race() returns trigger language plpgsql as $race$
  begin
    delete from clients where id = new.client_id;
    return new;
  end $race$;
  create trigger _smoke_0048_race before insert on invite_signup_attempts
    for each row execute function _smoke_0048_race();
  begin
    v_ok := fn_invite_signup_allow_attempt(p_token => v_tok3);
  exception when others then
    raise exception 'FAIL: a client vanishing mid-attempt raised % (0048) — the public endpoint 500s where it should answer not_found', sqlstate;
  end;
  drop trigger _smoke_0048_race on invite_signup_attempts;
  drop function _smoke_0048_race();
  if not v_ok then
    raise exception 'FAIL: a vanished client was rate-limited rather than allowed through to not_found (0048)';
  end if;

  -- 7. Service role only, by GRANT.
  set local session authorization authenticated;
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_op), true);
  begin
    perform fn_invite_signup_allow_attempt(p_token => v_tok);
    raise exception 'FAIL: authenticated can execute fn_invite_signup_allow_attempt (0048)';
  exception when insufficient_privilege then null;
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;
  reset session authorization;

  -- 8. And service role only IN THE BODY, which is the half a future GRANT
  -- cannot undo. Granting execute here (rolled back with the suite) is the
  -- only way to reach the body as a non-service caller at all; without this
  -- the body guard would be untested and one `grant execute` away from
  -- letting any signed-in user spend, and inspect, another tenant's budget.
  grant execute on function fn_invite_signup_allow_attempt(uuid, inet, int, int)
    to authenticated;
  set local session authorization authenticated;
  begin
    perform fn_invite_signup_allow_attempt(p_token => v_tok);
    raise exception 'FAIL: the body has no service-role guard (0048) — one GRANT is all that stands in front of it';
  exception when insufficient_privilege then
    raise exception 'FAIL: the grant under test did not take (0048)';
       when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;
  reset session authorization;
  revoke execute on function fn_invite_signup_allow_attempt(uuid, inet, int, int)
    from authenticated;

  -- 9. The ledger itself: RLS on AND forced, no API-role privileges. 0032
  -- exists because `vault_rate_limit_attempts` — the table this one is
  -- modelled on — shipped with a REVOKE and no RLS at all.
  select relrowsecurity and relforcerowsecurity into v_ok
    from pg_class where oid = 'invite_signup_attempts'::regclass;
  if not v_ok then
    raise exception 'FAIL: invite_signup_attempts does not have RLS enabled AND forced (0048)';
  end if;
  if has_table_privilege('anon', 'invite_signup_attempts', 'SELECT, INSERT, UPDATE, DELETE')
     or has_table_privilege('authenticated', 'invite_signup_attempts', 'SELECT, INSERT, UPDATE, DELETE') then
    raise exception 'FAIL: an API role holds a privilege on invite_signup_attempts (0048)';
  end if;

  raise notice 'the public signup endpoint has a per-client budget with a ceiling (0048): OK';
end $$;

-- ── 0049: Web Push device registrations ──────────────────────────────────
--
-- The properties that are not restatements of the DDL. The one that matters
-- most is the shared-device reassignment: a push endpoint identifies a
-- BROWSER, not a person, so two people using one phone can present the same
-- endpoint and whichever row survives decides whose walk reports land on that
-- lock screen.
do $$
declare
  v_op      uuid := '99999999-0000-4000-a000-000000000001';
  v_cl_a    uuid := '99999999-0000-4000-c000-00000000000a';
  v_user_a  uuid;
  v_cl_z    uuid := '99999999-0000-4000-c000-0000000000fb';
  v_user_z  uuid := '99999999-0000-4000-a000-0000000000fb';
  -- Real key material, so the shape validators are exercised rather than
  -- satisfied by a string of the right length (the vector from webpush_test).
  v_p256    text := 'BDgBTGA8idqXEkJjIO5TqUx5Xdo7kLtbB5Guj120hrfbJeOqNo7eN7llZvZlkPieoqyDS81hVBuQc4y8gpRwbJY';
  v_auth    text := 'ZmVkY2JhOTg3NjU0MzIxMA';
  v_shared  text := 'https://fcm.googleapis.com/fcm/send/SHARED-DEVICE';
  v_op_ep   text := 'https://fcm.googleapis.com/fcm/send/OPERATOR-PHONE';
  v_id      uuid;
  v_rows    int;
  v_owner   uuid;
  v_removed boolean;
  i         int;
begin
  reset session authorization;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select auth_user_id into v_user_a from clients where id = v_cl_a;
  insert into auth.users (id, email) values (v_user_z, 'push-z@sanpo.test');
  insert into clients (id, operator_id, auth_user_id, full_name, status)
  values (v_cl_z, v_op, v_user_z, 'Push Client Z', 'active');

  -- 1. The OPERATOR's own device: client_id null, operator_id resolved from
  -- the session rather than supplied.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_op), true);
  v_id := fn_register_push_subscription(v_op_ep, v_p256, v_auth, 'Pixel/Chrome');
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  if (select client_id from push_subscriptions where id = v_id) is not null then
    raise exception 'FAIL: an operator device was recorded against a client (0049)';
  end if;
  if (select operator_id from push_subscriptions where id = v_id) <> v_op then
    raise exception 'FAIL: the operator device was not scoped to its operator (0049)';
  end if;

  -- 2. A CLIENT's device carries both ids, and the operator is derived from
  -- the client rather than trusted from the caller.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_user_a), true);
  v_id := fn_register_push_subscription(v_shared, v_p256, v_auth, 'iPhone/Safari');
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  if (select client_id from push_subscriptions where id = v_id) <> v_cl_a
     or (select operator_id from push_subscriptions where id = v_id) <> v_op then
    raise exception 'FAIL: a client device was not scoped to its client and operator (0049)';
  end if;

  -- 3. THE SHARED DEVICE. Z signs in on the same browser and registers the
  -- SAME endpoint. There must be exactly one row and it must belong to Z —
  -- a row left attached to A sends A's client reports to a phone Z is holding.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_user_z), true);
  perform fn_register_push_subscription(v_shared, v_p256, v_auth, 'iPhone/Safari');
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select count(*) into v_rows from push_subscriptions where endpoint = v_shared;
  select client_id into v_owner from push_subscriptions where endpoint = v_shared limit 1;
  if v_rows <> 1 then
    raise exception 'FAIL: re-registering a shared device left % rows for one endpoint (0049)', v_rows;
  end if;
  if v_owner <> v_cl_z then
    raise exception 'FAIL: a re-registered device still belongs to the PREVIOUS person (0049) — their notifications now reach a phone somebody else is holding';
  end if;

  -- 3b. A foreign caller who learns the endpoint cannot claim it (Codex
  -- review on PR #85). Unconditional reassignment contradicted this file's
  -- own reason for scoping removal — an endpoint is not secret enough to
  -- authorize acting on it — and let anyone stop a victim's notifications
  -- AND start delivering their own onto the victim's device.
  --
  -- The genuine shared-device case presents the SAME key material, because
  -- the browser hands back the same subscription object; a caller who only
  -- knows the endpoint cannot.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_user_a), true);
  begin
    perform fn_register_push_subscription(v_shared, replace(v_p256, 'BDgB', 'BDgC'), v_auth);
    raise exception 'FAIL: a caller knowing only the endpoint claimed another device (0049)';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select client_id into v_owner from push_subscriptions where endpoint = v_shared;
  if v_owner <> v_cl_z then
    raise exception 'FAIL: the refused claim still moved the device (0049)';
  end if;

  -- 4. Removal is scoped to the caller. A must not be able to silence Z's
  -- device by naming its endpoint — endpoints are not secret in any strong
  -- sense, so an unscoped delete is a denial-of-service primitive.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_user_a), true);
  v_removed := fn_remove_push_subscription(v_shared);
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  if v_removed then
    raise exception 'FAIL: one person removed another person''s push subscription (0049)';
  end if;
  if not exists (select 1 from push_subscriptions where endpoint = v_shared) then
    raise exception 'FAIL: the foreign removal deleted the row anyway (0049)';
  end if;

  -- 5. No write grants for the API roles: every write goes through the
  -- definer functions, which decide the persona themselves.
  if has_table_privilege('authenticated', 'push_subscriptions', 'INSERT')
     or has_table_privilege('authenticated', 'push_subscriptions', 'UPDATE')
     or has_table_privilege('authenticated', 'push_subscriptions', 'DELETE')
     or has_table_privilege('anon', 'push_subscriptions', 'SELECT, INSERT, UPDATE, DELETE') then
    raise exception 'FAIL: an API role can write push_subscriptions directly (0049)';
  end if;

  -- 6. The encryption secrets are not selectable.
  if has_column_privilege('authenticated', 'push_subscriptions', 'p256dh', 'SELECT')
     or has_column_privilege('authenticated', 'push_subscriptions', 'auth', 'SELECT') then
    raise exception 'FAIL: a client can read push encryption secrets (0049)';
  end if;

  -- 7. RLS scopes reads to the caller's own devices. Z must not see the
  -- operator's device, and the operator must not see Z's.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_user_z), true);
  select count(*) into v_rows from push_subscriptions;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  if v_rows <> 1 then
    raise exception 'FAIL: a client can see % push subscriptions, not just their own (0049)', v_rows;
  end if;

  -- 8. Erasure. The purge REDACTS the client row rather than deleting it, so
  -- the FK cascade never fires — without the trigger an endpoint identifying
  -- a person's browser survives an erasure request indefinitely.
  update clients set purged_at = now() where id = v_cl_z;
  if exists (select 1 from push_subscriptions where client_id = v_cl_z) then
    raise exception 'FAIL: a purged client kept their device registrations (0049)';
  end if;

  -- 9. Shape validation. A truncated key produces a payload the push service
  -- ACCEPTS and the browser silently never opens, so it is refused at write
  -- time rather than discovered as a notification nobody received.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_op), true);
  begin
    perform fn_register_push_subscription(v_op_ep || '-x', left(v_p256, 40), v_auth);
    raise exception 'FAIL: a truncated p256dh was accepted (0049)';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;
  begin
    perform fn_register_push_subscription('http://insecure.example/x', v_p256, v_auth);
    raise exception 'FAIL: a non-https endpoint was accepted (0049)';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- 10. The new notifications columns are not client-writable. 0004 grants
  -- only `update (read_at)`; a later table-level grant would silently let a
  -- client mark their own payment_failed push as sent.
  if has_column_privilege('authenticated', 'notifications', 'push_status', 'UPDATE')
     or has_column_privilege('authenticated', 'notifications', 'push_sent_at', 'UPDATE') then
    raise exception 'FAIL: a client can rewrite push delivery state (0049)';
  end if;

  -- 11. The device count per recipient is BOUNDED (Codex review on PR #85).
  -- Nothing checks an endpoint belongs to a real push service, so without a
  -- quota one account can register unbounded fabricated endpoints and every
  -- later notification POSTs to each of them, sequentially, before the email
  -- arm runs.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_op), true);
  for i in 1..25 loop
    perform fn_register_push_subscription(
      'https://fcm.googleapis.com/fcm/send/FLOOD-' || i, v_p256, v_auth);
  end loop;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select count(*) into v_rows
    from push_subscriptions where operator_id = v_op and client_id is null;
  if v_rows > 10 then
    raise exception 'FAIL: one recipient holds % device registrations (0049) — the send path POSTs to every one of them before the email', v_rows;
  end if;
  -- And the MOST RECENT survive: evicting the device in front of somebody
  -- right now would be worse than refusing the registration outright.
  if not exists (
    select 1 from push_subscriptions
     where endpoint = 'https://fcm.googleapis.com/fcm/send/FLOOD-25'
  ) then
    raise exception 'FAIL: the newest device was evicted rather than the oldest (0049)';
  end if;

  raise notice 'push subscriptions: persona-scoped, device-reassigning, purged with the client (0049): OK';
end $$;

rollback;

do $$ begin raise notice 'SMOKE PASS'; end $$;
