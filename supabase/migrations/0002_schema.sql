-- 0002 — full schema (spec 01)
-- Conventions: uuid pk default gen_random_uuid() unless noted; created_at on
-- everything; updated_at (trigger-maintained) on mutable tables; every tenant
-- table carries operator_id with an index; money = integer pence; FKs
-- on delete restrict unless noted.

-- ── updated_at maintenance ───────────────────────────────────────────────
create function fn_touch_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ── operators ────────────────────────────────────────────────────────────
-- id = auth.users.id (no default)
create table operators (
  id uuid primary key references auth.users (id) on delete restrict,
  business_name text not null,
  display_name text not null,
  email text not null,
  phone text,
  timezone text not null default 'Europe/London',
  currency char(3) not null default 'GBP',
  low_credit_threshold int not null default 2,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_operators_updated_at
  before update on operators
  for each row execute function fn_touch_updated_at();

-- ── plans ────────────────────────────────────────────────────────────────
create table plans (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references operators (id) on delete restrict,
  name text not null,
  credits_per_cycle int not null check (credits_per_cycle > 0),
  price_pence int not null check (price_pence >= 0),
  cycle billing_cycle not null,
  rollover_policy rollover_policy not null default 'none',
  rollover_cap int null check (rollover_cap is null or rollover_cap >= 0),
  rollover_expiry_days int null check (rollover_expiry_days is null or rollover_expiry_days > 0),
  overage_rate_pence int not null check (overage_rate_pence >= 0),
  stripe_price_id text,
  active bool not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint plans_capped_requires_cap
    check (rollover_policy <> 'capped' or rollover_cap is not null)
);

create index idx_plans_operator on plans (operator_id);

create trigger trg_plans_updated_at
  before update on plans
  for each row execute function fn_touch_updated_at();

-- ── clients ──────────────────────────────────────────────────────────────
create table clients (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references operators (id) on delete restrict,
  auth_user_id uuid null unique references auth.users (id) on delete restrict,
  full_name text not null,
  email text,
  phone text,
  status client_status not null default 'invited',
  notes text,
  invite_token uuid not null default gen_random_uuid() unique,
  stripe_customer_id text,
  plan_id uuid null references plans (id) on delete restrict,
  subscription_status subscription_status not null default 'none',
  stripe_subscription_id text,
  -- Denormalized running balance; written ONLY by the credit-engine
  -- definer functions via the ledger trigger (spec 02/03, invariant 1).
  credit_balance int not null default 0 check (credit_balance >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_clients_operator on clients (operator_id);

create trigger trg_clients_updated_at
  before update on clients
  for each row execute function fn_touch_updated_at();

-- ── properties ───────────────────────────────────────────────────────────
create table properties (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references operators (id) on delete restrict,
  client_id uuid not null references clients (id) on delete restrict,
  label text not null,
  address_line1 text,
  address_line2 text,
  city text,
  postcode text,
  access_notes_public text,
  lat double precision null,
  lng double precision null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_properties_operator on properties (operator_id);
create index idx_properties_client on properties (client_id);

create trigger trg_properties_updated_at
  before update on properties
  for each row execute function fn_touch_updated_at();

-- ── access_credentials ───────────────────────────────────────────────────
-- ciphertext = AES-256-GCM blob iv(12) ‖ tag(16) ‖ ct (spec 03/04).
-- Soft delete via revoked_at (spec 04 authoritative rule): the vault
-- 'delete' action sets revoked_at; the audit log is immortal.
create table access_credentials (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references operators (id) on delete restrict,
  property_id uuid not null references properties (id) on delete restrict,
  entry_method entry_method not null,
  ciphertext bytea not null,
  label text,
  key_location_hint text,
  rotated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_access_credentials_operator on access_credentials (operator_id);
create index idx_access_credentials_property on access_credentials (property_id);

create trigger trg_access_credentials_updated_at
  before update on access_credentials
  for each row execute function fn_touch_updated_at();

-- ── credential_access_log ────────────────────────────────────────────────
-- Append-only audit trail; on delete restrict so the log outlives nothing —
-- credentials are soft-revoked, never hard-deleted (spec 04).
create table credential_access_log (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references operators (id) on delete restrict,
  credential_id uuid not null references access_credentials (id) on delete restrict,
  accessed_by uuid not null,
  purpose text not null check (length(trim(purpose)) > 0),
  accessed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index idx_credential_access_log_operator on credential_access_log (operator_id);
create index idx_credential_access_log_credential on credential_access_log (credential_id);

-- ── pets ─────────────────────────────────────────────────────────────────
create table pets (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references operators (id) on delete restrict,
  client_id uuid not null references clients (id) on delete restrict,
  name text not null,
  breed text,
  size pet_size,
  temperament text,
  medical_notes text,
  feeding_notes text,
  medication_notes text,
  vet_name text,
  vet_phone text,
  is_reactive bool not null default false,
  is_escape_risk bool not null default false,
  photo_path text,
  active bool not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_pets_operator on pets (operator_id);
create index idx_pets_client on pets (client_id);

create trigger trg_pets_updated_at
  before update on pets
  for each row execute function fn_touch_updated_at();

-- ── service_types ────────────────────────────────────────────────────────
create table service_types (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references operators (id) on delete restrict,
  name text not null,
  duration_minutes int not null check (duration_minutes > 0),
  credit_cost int not null check (credit_cost > 0),
  weekend_surcharge_credits int not null default 0 check (weekend_surcharge_credits >= 0),
  is_default bool not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_service_types_operator on service_types (operator_id);

create trigger trg_service_types_updated_at
  before update on service_types
  for each row execute function fn_touch_updated_at();

-- Seed default service types on operator creation (spec 01).
create function fn_seed_operator_defaults() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into service_types
    (operator_id, name, duration_minutes, credit_cost, is_default)
  values
    (new.id, 'Private walk 30', 30, 1, true),
    (new.id, 'Private walk 60', 60, 2, false);
  return new;
end;
$$;

create trigger trg_operators_seed_defaults
  after insert on operators
  for each row execute function fn_seed_operator_defaults();

-- ── recurring_schedules ──────────────────────────────────────────────────
create table recurring_schedules (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references operators (id) on delete restrict,
  client_id uuid not null references clients (id) on delete restrict,
  property_id uuid not null references properties (id) on delete restrict,
  service_type_id uuid not null references service_types (id) on delete restrict,
  days_of_week int[] not null check (days_of_week <@ array[1,2,3,4,5,6,7] and array_length(days_of_week, 1) > 0),
  window_start time not null,
  window_end time not null,
  start_date date not null,
  end_date date null,
  paused_from date null,
  paused_until date null,
  active bool not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_recurring_schedules_operator on recurring_schedules (operator_id);
create index idx_recurring_schedules_client on recurring_schedules (client_id);

create trigger trg_recurring_schedules_updated_at
  before update on recurring_schedules
  for each row execute function fn_touch_updated_at();

create table schedule_pets (
  schedule_id uuid not null references recurring_schedules (id) on delete cascade,
  pet_id uuid not null references pets (id) on delete restrict,
  operator_id uuid not null references operators (id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (schedule_id, pet_id)
);

create index idx_schedule_pets_operator on schedule_pets (operator_id);

-- ── walks ────────────────────────────────────────────────────────────────
create table walks (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references operators (id) on delete restrict,
  client_id uuid not null references clients (id) on delete restrict,
  property_id uuid not null references properties (id) on delete restrict,
  service_type_id uuid not null references service_types (id) on delete restrict,
  schedule_id uuid null references recurring_schedules (id) on delete set null,
  scheduled_date date not null,
  window_start time not null,
  window_end time not null,
  status walk_status not null default 'scheduled',
  started_at timestamptz,
  ended_at timestamptz,
  credits_debited int not null default 0 check (credits_debited >= 0),
  is_overage bool not null default false,
  distance_m int,
  notes text,
  potty_pee bool,
  potty_poo bool,
  fed bool,
  watered bool,
  report_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_walks_operator on walks (operator_id);
create index idx_walks_client on walks (client_id);
create index idx_walks_scheduled_date on walks (operator_id, scheduled_date);
-- Materializer idempotency (spec 01/04).
create unique index uq_walks_schedule_date
  on walks (schedule_id, scheduled_date)
  where schedule_id is not null;

create trigger trg_walks_updated_at
  before update on walks
  for each row execute function fn_touch_updated_at();

create table walk_pets (
  walk_id uuid not null references walks (id) on delete cascade,
  pet_id uuid not null references pets (id) on delete restrict,
  operator_id uuid not null references operators (id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (walk_id, pet_id)
);

create index idx_walk_pets_operator on walk_pets (operator_id);

-- ── walk_gps_points ──────────────────────────────────────────────────────
create table walk_gps_points (
  id uuid primary key default gen_random_uuid(),
  walk_id uuid not null references walks (id) on delete cascade,
  operator_id uuid not null references operators (id) on delete restrict,
  recorded_at timestamptz not null,
  lat double precision not null,
  lng double precision not null,
  accuracy_m real,
  created_at timestamptz not null default now()
);

create index idx_walk_gps_points_walk on walk_gps_points (walk_id, recorded_at);
create index idx_walk_gps_points_operator on walk_gps_points (operator_id);

-- ── walk_photos ──────────────────────────────────────────────────────────
create table walk_photos (
  id uuid primary key default gen_random_uuid(),
  walk_id uuid not null references walks (id) on delete cascade,
  operator_id uuid not null references operators (id) on delete restrict,
  storage_path text not null,
  caption text,
  taken_at timestamptz,
  created_at timestamptz not null default now()
);

create index idx_walk_photos_walk on walk_photos (walk_id);
create index idx_walk_photos_operator on walk_photos (operator_id);

-- ── credit_ledger ────────────────────────────────────────────────────────
-- Append-only single source of truth (spec 02). Sole write path is the
-- credit-engine definer functions (0003); balance_after is computed by the
-- ledger trigger under the per-client row lock.
-- seq: deterministic insert-order tiebreaker for the auditable chain.
-- Spec 02 orders the chain by (created_at, id), but rows written in the
-- same transaction share created_at and random uuids cannot break the tie
-- deterministically — and now() is transaction START time, which under
-- concurrency can disagree with the order the per-client lock was granted.
-- The authoritative chain order is therefore seq (assigned at insert while
-- holding the client lock); created_at uses clock_timestamp() so wall-clock
-- display order matches insert order in practice.
create table credit_ledger (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity unique,
  operator_id uuid not null references operators (id) on delete restrict,
  client_id uuid not null references clients (id) on delete restrict,
  entry_type ledger_entry_type not null,
  amount int not null check (amount <> 0),
  balance_after int not null,
  walk_id uuid null references walks (id) on delete restrict,
  expires_at timestamptz null,
  note text,
  created_at timestamptz not null default clock_timestamp()
);

create index idx_credit_ledger_operator on credit_ledger (operator_id);
create index idx_credit_ledger_client_created on credit_ledger (client_id, created_at desc);

-- ── payments ─────────────────────────────────────────────────────────────
create table payments (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references operators (id) on delete restrict,
  client_id uuid not null references clients (id) on delete restrict,
  walk_id uuid null references walks (id) on delete restrict,
  type payment_type not null,
  amount_pence int not null check (amount_pence >= 0),
  currency char(3) not null default 'GBP',
  stripe_payment_intent_id text,
  stripe_invoice_id text,
  status payment_status not null,
  receipt_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_payments_operator on payments (operator_id);
create index idx_payments_client on payments (client_id);

create trigger trg_payments_updated_at
  before update on payments
  for each row execute function fn_touch_updated_at();

-- ── notifications ────────────────────────────────────────────────────────
-- client_id null ⇒ operator-facing notification.
create table notifications (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references operators (id) on delete restrict,
  client_id uuid null references clients (id) on delete restrict,
  type notification_type not null,
  title text not null,
  body text,
  walk_id uuid null references walks (id) on delete restrict,
  read_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_notifications_operator on notifications (operator_id);
create index idx_notifications_client on notifications (client_id);

create trigger trg_notifications_updated_at
  before update on notifications
  for each row execute function fn_touch_updated_at();

-- ── stripe_events ────────────────────────────────────────────────────────
-- Webhook idempotency ledger; id = Stripe event id (service role only).
create table stripe_events (
  id text primary key,
  type text not null,
  payload jsonb,
  processed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
