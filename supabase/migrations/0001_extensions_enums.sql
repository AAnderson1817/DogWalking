-- 0001 — extensions and enums (spec 01)

create extension if not exists pgcrypto;

create type entry_method as enum (
  'key_on_file', 'lockbox', 'smart_lock', 'door_code', 'buzzer_fob'
);

create type walk_status as enum (
  'scheduled', 'in_progress', 'completed', 'cancelled', 'no_show'
);

create type ledger_entry_type as enum (
  'grant', 'debit', 'adjust', 'rollover', 'expiry'
);

create type payment_type as enum (
  'subscription', 'overage', 'topup'
);

create type payment_status as enum (
  'pending', 'succeeded', 'failed', 'refunded'
);

create type client_status as enum (
  'invited', 'active', 'paused', 'archived'
);

create type subscription_status as enum (
  'none', 'active', 'paused', 'past_due', 'cancelled'
);

create type pet_size as enum (
  'small', 'medium', 'large', 'giant'
);

create type rollover_policy as enum (
  'none', 'capped', 'unlimited'
);

create type billing_cycle as enum (
  'weekly', 'monthly'
);

create type notification_type as enum (
  'walk_complete', 'low_credit', 'renewal_upcoming', 'payment_failed',
  'walk_scheduled', 'walk_cancelled'
);
