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
  foreach t in array array[
    'operators','plans','clients','properties','access_credentials',
    'credential_access_log','pets','service_types','recurring_schedules',
    'schedule_pets','walks','walk_pets','walk_gps_points','walk_photos',
    'credit_ledger','payments','notifications','stripe_events'
  ] loop
    begin
      execute format('select count(*) from %I', t) into n;
      if n <> 0 then
        raise exception 'FAIL: anon sees % rows in %', n, t;
      end if;
    exception when insufficient_privilege then
      null;  -- expected
    end;
  end loop;

  begin
    perform fn_grant_credits('99999999-0000-4000-c000-00000000000a', 1, 'anon grant');
    raise exception 'FAIL: anon executed fn_grant_credits';
  exception when insufficient_privilege then
    null;  -- expected
  end;

  reset session authorization;
  raise notice 'security 5 (anon denied everywhere): OK';
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

  select fn_claim_invite('99999999-9999-4999-a999-999999999999') into v_client;
  if v_client <> '99999999-0000-4000-c000-00000000000f' then
    raise exception 'FAIL: claim returned wrong client';
  end if;
  if (select status from clients where id = v_client) <> 'active' then
    raise exception 'FAIL: claim did not activate client';
  end if;
  -- second claim of the same token fails
  begin
    perform fn_claim_invite('99999999-9999-4999-a999-999999999999');
    raise exception 'FAIL: double claim succeeded';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;
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

  -- Booking for another client is invisible/blocked by RLS.
  begin
    insert into walks (operator_id, client_id, property_id, service_type_id,
                       scheduled_date, window_start, window_end, status)
    values ('99999999-0000-4000-a000-000000000001', '99999999-0000-4000-c000-0000000000a2',
            v_prop, v_service, current_date + 10, '10:00', '11:00', 'scheduled');
    raise exception 'FAIL: client booked a walk for another client';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
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
  end;

  -- Clients may not touch other columns even on their own scheduled walks.
  begin
    update walks set notes = 'client-forged note'
     where id = '99999999-0000-4000-2000-000000000009';
    raise exception 'FAIL: client updated walk fields other than status';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
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
  perform fn_apply_invoice_paid(v_cli, 10, 'in_smoke_full', 9000, 'USD', null);
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
  perform fn_apply_invoice_paid(v_cli, 10, 'in_smoke_full', 9000, 'USD', null);
  select count(*) into v_n from credit_ledger
   where entry_type = 'grant' and stripe_invoice_id = 'in_smoke_full';
  if v_n <> 1 then
    raise exception 'FAIL: replayed invoice.paid after a refund produced % grants, expected 1', v_n;
  end if;

  -- ── 4. Partial refund floors at the balance and reports the shortfall ──
  perform fn_apply_invoice_paid(v_cli, 10, 'in_smoke_part', 9000, 'USD', null);
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


rollback;

do $$ begin raise notice 'SMOKE PASS'; end $$;
