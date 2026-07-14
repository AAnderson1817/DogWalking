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
     null, 'Smoke Client E', 'active', '99999999-0000-4000-b000-000000000002');

  insert into properties (id, operator_id, client_id, label) values
    ('99999999-0000-4000-d000-00000000000a', '99999999-0000-4000-a000-000000000001',
     '99999999-0000-4000-c000-00000000000a', 'A home'),
    ('99999999-0000-4000-d000-0000000000a2', '99999999-0000-4000-a000-000000000001',
     '99999999-0000-4000-c000-0000000000a2', 'A2 home'),
    ('99999999-0000-4000-d000-00000000000e', '99999999-0000-4000-a000-000000000001',
     '99999999-0000-4000-c000-00000000000e', 'E home');

  insert into pets (id, operator_id, client_id, name) values
    ('99999999-0000-4000-e000-00000000000a', '99999999-0000-4000-a000-000000000001',
     '99999999-0000-4000-c000-00000000000a', 'Smoke Pet A'),
    ('99999999-0000-4000-e000-0000000000a2', '99999999-0000-4000-a000-000000000001',
     '99999999-0000-4000-c000-0000000000a2', 'Smoke Pet A2');

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

rollback;

do $$ begin raise notice 'SMOKE PASS'; end $$;
