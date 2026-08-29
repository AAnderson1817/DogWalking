-- Supabase-compatibility shim for a bare Postgres 17 cluster.
-- Replicates the parts of the Supabase local stack (roles, auth schema,
-- storage schema, default privileges) that Sanpo's migrations, RLS
-- policies, and smoke tests depend on. Applied by scripts/db-reset.sh
-- BEFORE the project migrations; never shipped to a real Supabase project,
-- where the platform provides all of this.

-- ── Roles ────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

-- ── auth schema ──────────────────────────────────────────────────────────
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text unique,
  encrypted_password text,
  raw_app_meta_data jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- auth.uid()/role()/jwt() exactly as the platform defines them: driven by
-- the request.jwt.claims GUC, which PostgREST (and our smoke tests, via
-- set_config) populate per request/transaction.
create or replace function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

create or replace function auth.role() returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  )
$$;

create or replace function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  )
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.role(), auth.jwt()
  to anon, authenticated, service_role;
grant select on auth.users to service_role;

-- ── storage schema ───────────────────────────────────────────────────────
create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  metadata jsonb,
  path_tokens text[] generated always as (string_to_array(name, '/')) stored,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create or replace function storage.foldername(name text) returns text[]
language sql immutable
as $$
  select (string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1]
$$;

create or replace function storage.filename(name text) returns text
language sql immutable
as $$
  select (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)]
$$;

create or replace function storage.extension(name text) returns text
language sql immutable
as $$
  select reverse(split_part(reverse(storage.filename(name)), '.', 1))
$$;

alter table storage.objects enable row level security;

grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.buckets, storage.objects to service_role;
grant select on storage.buckets to anon, authenticated;
grant select, insert, update, delete on storage.objects to anon, authenticated;

-- ── realtime schema ──────────────────────────────────────────────────────
-- Realtime Authorization is enforced by RLS policies on realtime.messages:
-- a SELECT policy grants permission to RECEIVE on a topic, an INSERT policy
-- to SEND. Realtime evaluates them at connect time by querying the table
-- with the joining user's JWT and rolling the query back.
--
-- The platform provides this table (with RLS already enabled) and the
-- realtime.topic() function, which returns the topic being joined. Neither
-- exists on a bare cluster, so 0020's policies would fail to apply and the
-- authorization matrix would be untestable. This is a faithful stand-in for
-- the parts the policies actually read — not a Realtime implementation.
create schema if not exists realtime;

create table if not exists realtime.messages (
  id bigint generated always as identity primary key,
  topic text not null,
  extension text not null,
  event text,
  payload jsonb,
  private boolean default false,
  inserted_at timestamptz default now()
);

-- On the platform this is enabled by default; 0020 asserts it rather than
-- setting it, because a migration cannot own the platform's table.
alter table realtime.messages enable row level security;

-- The topic the client is asking to join. Realtime sets it per authorization
-- check; smoke tests set it with set_config, exactly as they already do for
-- request.jwt.claims.
create or replace function realtime.topic() returns text
language sql stable
as $$
  select nullif(current_setting('realtime.topic', true), '')
$$;

grant usage on schema realtime to anon, authenticated, service_role;
grant execute on function realtime.topic() to anon, authenticated, service_role;
grant select, insert on realtime.messages to anon, authenticated;
grant all on realtime.messages to service_role;

-- ── Supabase default privileges on public ────────────────────────────────
-- The platform grants broad table access and lets RLS + explicit REVOKEs
-- do the narrowing; our migrations (0004) assume that baseline.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;

-- ── cron schema (pg_cron stand-in) ───────────────────────────────────────
-- 0028 schedules the nightly job with cron.schedule, so the platform's
-- pg_cron extension has to exist for the migration to apply at all. It is not
-- available on a bare cluster and `create extension pg_cron` fails there, so
-- this provides the two functions and the one table 0028 touches.
--
-- Faithful to the interface, NOT an implementation: nothing here ever runs a
-- job. That is the honest boundary — a local stack cannot prove the schedule
-- fires, only that the migration installs it and that the SQL it would run is
-- correct. The latter is what smoke.sql tests, by calling the entry point
-- directly the way the job does.
create schema if not exists cron;

create table if not exists cron.job (
  jobid bigint generated always as identity primary key,
  schedule text not null,
  command text not null,
  nodename text not null default 'localhost',
  nodeport int not null default 5432,
  database text not null default current_database(),
  username text not null default current_user,
  active boolean not null default true,
  jobname text unique
);

create or replace function cron.schedule(job_name text, schedule text, command text)
returns bigint
language plpgsql
as $shim$
declare
  v_id bigint;
begin
  insert into cron.job (jobname, schedule, command)
  values (job_name, schedule, command)
  on conflict (jobname) do update
    set schedule = excluded.schedule, command = excluded.command
  returning jobid into v_id;
  return v_id;
end;
$shim$;

create or replace function cron.unschedule(job_name text)
returns boolean
language plpgsql
as $shim$
begin
  delete from cron.job where jobname = job_name;
  if not found then
    -- pg_cron raises here rather than returning false; 0028 relies on that to
    -- tell "was not scheduled" apart from a real failure.
    raise exception 'could not find valid entry for job "%"', job_name;
  end if;
  return true;
end;
$shim$;

-- pg_cron's own objects are postgres-owned and unreachable by the API roles.
revoke all on schema cron from public;
revoke all on all tables in schema cron from public;
