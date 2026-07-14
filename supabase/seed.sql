-- Dev-only demo data (never applied in production).
-- One operator, two clients (one subscribed with credits, one invited),
-- properties, pets, a dummy-ciphertext credential, plans, a recurring
-- schedule, and one completed walk with GPS points + a ledger history
-- built through the credit-engine functions so the chain stays valid.

begin;

-- Auth users (operator + claimed client). Fixed uuids for dev ergonomics.
insert into auth.users (id, email) values
  ('00000000-0000-4000-a000-000000000001', 'demo-operator@pawtrail.dev'),
  ('00000000-0000-4000-a000-000000000002', 'amelia@pawtrail.dev')
on conflict (id) do nothing;

-- Operator (trigger seeds the two default service types).
insert into operators (id, business_name, display_name, email, phone)
values ('00000000-0000-4000-a000-000000000001', 'Pine & Paws', 'Sam', 'demo-operator@pawtrail.dev', '+44 7700 900001');

-- Plans.
insert into plans (id, operator_id, name, credits_per_cycle, price_pence, cycle,
                   rollover_policy, rollover_cap, rollover_expiry_days, overage_rate_pence)
values
  ('00000000-0000-4000-b000-000000000001', '00000000-0000-4000-a000-000000000001',
   'Weekly 5', 5, 9000, 'monthly', 'capped', 3, 30, 2200),
  ('00000000-0000-4000-b000-000000000002', '00000000-0000-4000-a000-000000000001',
   'Weekly 3', 3, 6000, 'monthly', 'none', null, null, 2400);

-- Clients: Amelia (claimed, subscribed), Ben (invited, no plan).
insert into clients (id, operator_id, auth_user_id, full_name, email, phone, status,
                     invite_token, stripe_customer_id, plan_id, subscription_status,
                     stripe_subscription_id)
values
  ('00000000-0000-4000-c000-000000000001', '00000000-0000-4000-a000-000000000001',
   '00000000-0000-4000-a000-000000000002', 'Amelia Hart', 'amelia@pawtrail.dev',
   '+44 7700 900002', 'active', '11111111-1111-4111-a111-111111111111',
   'cus_demo_amelia', '00000000-0000-4000-b000-000000000001', 'active', 'sub_demo_amelia'),
  ('00000000-0000-4000-c000-000000000002', '00000000-0000-4000-a000-000000000001',
   null, 'Ben Osei', 'ben@pawtrail.dev', '+44 7700 900003', 'invited',
   '22222222-2222-4222-a222-222222222222', null, null, 'none', null);

-- Properties.
insert into properties (id, operator_id, client_id, label, address_line1, city, postcode,
                        access_notes_public, lat, lng)
values
  ('00000000-0000-4000-d000-000000000001', '00000000-0000-4000-a000-000000000001',
   '00000000-0000-4000-c000-000000000001', 'Home', '14 Larchfield Road', 'London', 'SE23 2AB',
   'Side gate sticks — lift while pushing.', 51.4419, -0.0533),
  ('00000000-0000-4000-d000-000000000002', '00000000-0000-4000-a000-000000000001',
   '00000000-0000-4000-c000-000000000002', 'Flat', '2B Hillmore Court', 'London', 'SE6 4QT',
   'Buzz flat 2B, lift on the left.', 51.4372, -0.0175);

-- Pets.
insert into pets (id, operator_id, client_id, name, breed, size, temperament,
                  feeding_notes, is_reactive, is_escape_risk)
values
  ('00000000-0000-4000-e000-000000000001', '00000000-0000-4000-a000-000000000001',
   '00000000-0000-4000-c000-000000000001', 'Biscuit', 'Cocker Spaniel', 'medium',
   'Friendly, pulls at squirrels.', 'Half cup kibble after walk.', false, false),
  ('00000000-0000-4000-e000-000000000002', '00000000-0000-4000-a000-000000000001',
   '00000000-0000-4000-c000-000000000001', 'Pickle', 'Terrier mix', 'small',
   'Wary of large dogs.', null, true, false),
  ('00000000-0000-4000-e000-000000000003', '00000000-0000-4000-a000-000000000001',
   '00000000-0000-4000-c000-000000000002', 'Nova', 'Whippet', 'medium',
   'Gentle, hates rain.', null, false, true);

-- One credential row with dummy ciphertext (12-byte iv + 16-byte tag + ct).
insert into access_credentials (id, operator_id, property_id, entry_method, ciphertext,
                                label, key_location_hint)
values
  ('00000000-0000-4000-f000-000000000001', '00000000-0000-4000-a000-000000000001',
   '00000000-0000-4000-d000-000000000001', 'lockbox',
   decode('000102030405060708090a0b101112131415161718191a1b1c1d1e1fdeadbeef', 'hex'),
   'Front door lockbox', 'Left of the porch, behind the planter');

-- Recurring schedule: Biscuit & Pickle, Mon/Wed/Fri lunchtime.
insert into recurring_schedules (id, operator_id, client_id, property_id, service_type_id,
                                 days_of_week, window_start, window_end, start_date)
select '00000000-0000-4000-1000-000000000001', '00000000-0000-4000-a000-000000000001',
       '00000000-0000-4000-c000-000000000001', '00000000-0000-4000-d000-000000000001',
       st.id, array[1,3,5], '12:00', '13:00', current_date - 21
  from service_types st
 where st.operator_id = '00000000-0000-4000-a000-000000000001' and st.is_default;

insert into schedule_pets (schedule_id, pet_id, operator_id) values
  ('00000000-0000-4000-1000-000000000001', '00000000-0000-4000-e000-000000000001',
   '00000000-0000-4000-a000-000000000001'),
  ('00000000-0000-4000-1000-000000000001', '00000000-0000-4000-e000-000000000002',
   '00000000-0000-4000-a000-000000000001');

-- Cycle grant for Amelia through the engine (valid ledger chain).
select fn_grant_credits('00000000-0000-4000-c000-000000000001', 5, 'cycle grant in_demo_001');

-- A completed walk from yesterday, debited through the engine.
insert into walks (id, operator_id, client_id, property_id, service_type_id,
                   scheduled_date, window_start, window_end, status, started_at, ended_at,
                   distance_m, notes, potty_pee, potty_poo, fed, watered)
select '00000000-0000-4000-2000-000000000001', '00000000-0000-4000-a000-000000000001',
       '00000000-0000-4000-c000-000000000001', '00000000-0000-4000-d000-000000000001',
       st.id, current_date - 1, '12:00', '13:00', 'completed',
       (current_date - 1) + time '12:05', (current_date - 1) + time '12:38',
       2140, 'Lovely loop of the park; Biscuit met a labrador friend.',
       true, true, true, false
  from service_types st
 where st.operator_id = '00000000-0000-4000-a000-000000000001' and st.is_default;

insert into walk_pets (walk_id, pet_id, operator_id) values
  ('00000000-0000-4000-2000-000000000001', '00000000-0000-4000-e000-000000000001',
   '00000000-0000-4000-a000-000000000001'),
  ('00000000-0000-4000-2000-000000000001', '00000000-0000-4000-e000-000000000002',
   '00000000-0000-4000-a000-000000000001');

select fn_debit_walk('00000000-0000-4000-2000-000000000001');

-- GPS trail for the completed walk (a small loop).
insert into walk_gps_points (walk_id, operator_id, recorded_at, lat, lng, accuracy_m)
select '00000000-0000-4000-2000-000000000001', '00000000-0000-4000-a000-000000000001',
       (current_date - 1) + time '12:05' + (n || ' seconds')::interval,
       51.4419 + 0.0008 * sin(n / 60.0), -0.0533 + 0.0011 * cos(n / 60.0), 5.0
  from generate_series(0, 1800, 30) as n;

-- A scheduled walk for today (dashboard fixture).
insert into walks (id, operator_id, client_id, property_id, service_type_id,
                   scheduled_date, window_start, window_end, status, schedule_id, origin_date)
select '00000000-0000-4000-2000-000000000002', '00000000-0000-4000-a000-000000000001',
       '00000000-0000-4000-c000-000000000001', '00000000-0000-4000-d000-000000000001',
       st.id, current_date, '12:00', '13:00', 'scheduled',
       '00000000-0000-4000-1000-000000000001', current_date
  from service_types st
 where st.operator_id = '00000000-0000-4000-a000-000000000001' and st.is_default;

-- A subscription payment record for Amelia.
insert into payments (operator_id, client_id, type, amount_pence, status,
                      stripe_invoice_id, receipt_url)
values ('00000000-0000-4000-a000-000000000001', '00000000-0000-4000-c000-000000000001',
        'subscription', 9000, 'succeeded', 'in_demo_001',
        'https://pay.stripe.com/receipts/demo');

commit;
