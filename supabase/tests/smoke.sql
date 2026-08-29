-- PawTrail smoke suite (phase 00).
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
    ('99999999-0000-4000-a000-000000000001', 'smoke-op1@pawtrail.dev'),
    ('99999999-0000-4000-a000-000000000002', 'smoke-op2@pawtrail.dev'),
    ('99999999-0000-4000-a000-000000000003', 'smoke-client-a@pawtrail.dev');

  insert into operators (id, business_name, display_name, email) values
    ('99999999-0000-4000-a000-000000000001', 'Smoke Walks 1', 'Op1', 'smoke-op1@pawtrail.dev'),
    ('99999999-0000-4000-a000-000000000002', 'Smoke Walks 2', 'Op2', 'smoke-op2@pawtrail.dev');

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
  values ('99999999-0000-4000-a000-000000000004', 'smoke-claimer@pawtrail.dev');
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
  update clients set phone = '+44 7700 900099'
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
  insert into auth.users (id, email) values (v_auth_f2, 'smoke-client-f2@pawtrail.dev');
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

  -- Sent leaves the backlog.
  update notifications set email_status = 'sent', email_sent_at = now(), email_attempts = 1
   where id = v_n;
  if exists (select 1 from fn_notification_backlog() where id = v_n) then
    raise exception 'FAIL: a sent notification is still in the backlog';
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
  if exists (select 1 from fn_notification_backlog() where id = v_skipped) then
    raise exception 'FAIL: a skipped notification is in the retry backlog';
  end if;

  -- Failed is retryable.
  update notifications set email_status = 'failed', email_attempts = 1,
         email_last_error = 'resend 500' where id = v_n;
  if not exists (select 1 from fn_notification_backlog() where id = v_n) then
    raise exception 'FAIL: a failed notification is not retryable';
  end if;

  raise notice 'email delivery states (0029): OK';
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

  insert into notifications (operator_id, client_id, type, title, body,
                             email_status, email_attempts, email_last_error)
  values ('99999999-0000-4000-a000-000000000001',
          '99999999-0000-4000-c000-00000000000a',
          'walk_complete', 'Attempt ceiling', 'test', 'failed', 5, 'resend 422')
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

  raise notice 'email retry bound and give-up note (0029): OK';
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
  declare
    v_missing text;
  begin
    select string_agg(c.column_name, ', ')
      into v_missing
      from information_schema.columns c
     where c.table_schema = 'public'
       and c.table_name = 'clients'
       and c.column_name <> 'unsubscribe_token'
       and not has_column_privilege('authenticated', 'public.clients', c.column_name, 'SELECT');
    if v_missing is not null then
      raise exception
        'FAIL: clients column(s) not selectable by authenticated: % — add them to the grant list in 0038 (the table-level SELECT was replaced to withhold unsubscribe_token)',
        v_missing;
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
    ('99999999-0000-4000-a000-00000000004a', 'h4-a@pawtrail.dev'),
    ('99999999-0000-4000-a000-00000000004b', 'h4-b@pawtrail.dev');

  -- ── expired invite ──────────────────────────────────────────────────────
  insert into clients (id, operator_id, full_name, status, invite_token, invite_expires_at)
  values ('99999999-0000-4000-c000-0000000000e1', '99999999-0000-4000-a000-000000000001',
          'H4 Expired', 'invited', '99999999-0000-4000-e000-000000000001',
          now() - interval '1 day');

  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-00000000004a","role":"authenticated","email":"h4-a@pawtrail.dev"}', true);
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
    '{"sub":"99999999-0000-4000-a000-00000000004a","role":"authenticated","email":"h4-a@pawtrail.dev"}', true);
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
          'H4 Bound', 'h4-a@pawtrail.dev', 'invited', '99999999-0000-4000-e000-000000000003');

  perform set_config('request.jwt.claims',
    '{"sub":"99999999-0000-4000-a000-00000000004b","role":"authenticated","email":"h4-b@pawtrail.dev"}', true);
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
    '{"sub":"99999999-0000-4000-a000-00000000004a","role":"authenticated","email":"  H4-A@PawTrail.dev "}', true);
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
         and attempted_email = 'h4-b@pawtrail.dev') <> 1 then
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
    '{"sub":"99999999-0000-4000-a000-00000000004b","role":"authenticated","email":"h4-b@pawtrail.dev"}', true);
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
  values (v_cl, v_op, 'Purge Me', 'purge@pawtrail.dev', '+1 555 0100',
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
  insert into auth.users (id, email) values (v_user, 'consent@pawtrail.dev');
  insert into clients (id, operator_id, full_name, email, status, invite_token)
  values (v_cl, v_op, 'Consent Case', 'consent@pawtrail.dev', 'invited',
          '99999999-0000-4000-e000-0000000000c1');

  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated","email":"consent@pawtrail.dev"}', v_user), true);
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
  insert into auth.users (id, email) values (v_user, 'noversion@pawtrail.dev');
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


rollback;

do $$ begin raise notice 'SMOKE PASS'; end $$;
