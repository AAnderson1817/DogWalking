-- 0020 — the live-GPS channel was a public topic, readable AND writable by
-- anyone holding the anon key.
--
-- Review 2026-08 finding H1 (issue #10).
--
-- `useWalkChannel` created the channel as `supabase.channel("walk:" + id)`
-- with no options. `private` defaults to false (confirmed in the installed
-- @supabase/realtime-js 2.110.0, RealtimeChannel.js:102), and Supabase applies
-- authorization ONLY to private channels. The server-side broadcast helper set
-- `private: false` explicitly. No `realtime.messages` policy existed in any of
-- the 19 migrations, and docs/spec/03 did not mention Realtime at all — an
-- omission, not an accepted risk.
--
-- Effect: while a walk is in progress the operator's device broadcast every
-- GPS fix to a topic any holder of the anon key — which is compiled into the
-- shipped bundle — could join from any origin with no account. That is the
-- live position of a named person at a named residential address. The write
-- side is worse: the same topic accepted `send`, and WalkDetail merges
-- `livePoints` straight into the client's map and refetches on an `ended`
-- event, so the proof-of-service the product sells could be fabricated or
-- terminated by a third party. Topics are not enumerable, but a walk UUID is
-- not an authorization control — it leaks through logs, support tickets,
-- screenshots and shared links.
--
-- The durable rows were always correct (walk_gps_points_client_select,
-- 0004_security.sql:309-312), which is exactly why the live stream that
-- bypasses them went unnoticed. This migration gives the stream the same
-- tenancy rules as the table it mirrors.
--
-- ── What this does NOT do ───────────────────────────────────────────────
-- Policies on realtime.messages govern PRIVATE channels. They do not stop a
-- third party opening the same topic as a PUBLIC channel — that is the
-- project-level "Allow public access" setting in the Realtime dashboard,
-- which no migration and no file in this repository can set (there is no
-- [realtime] public-access key in config.toml, and neither deploy workflow
-- runs `supabase config push` — see review H2). Until that toggle is off for
-- a project, this migration hardens our own client and leaves the old public
-- door open for everyone else. docs/dev/realtime-authorization.md has the
-- steps and the verification.

-- ── Guard: RLS must actually be on ──────────────────────────────────────
-- Supabase enables RLS on realtime.messages by default and the platform owns
-- the table, so this migration asserts rather than sets. If the assertion
-- ever fires, the policies below would be silently inert — a security control
-- that looks present and enforces nothing, which is worse than a failed
-- deploy.
do $$
begin
  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'realtime' and c.relname = 'messages' and c.relrowsecurity
  ) then
    raise exception
      'realtime.messages does not have row level security enabled; the walk-channel policies would be inert';
  end if;
end
$$;

-- ── Who may join a walk topic ───────────────────────────────────────────
-- SECURITY DEFINER because the policy runs as `authenticated` and must read
-- `walks` across the tenancy boundary to answer the question at all
-- (invariant 5). Kept as a function rather than inlined into the policies so
-- there is one definition of the rule, it can be tested directly, and the two
-- policies cannot drift apart.
--
-- The topic is parsed defensively: a malformed topic returns false rather
-- than raising, because an error inside an RLS policy on a shared platform
-- table would affect every channel, not just ours. The uuid cast happens only
-- after the regex matches.
create or replace function fn_walk_channel_access(p_topic text, p_send boolean)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_walk uuid;
  v_operator uuid;
  v_client uuid;
  v_me uuid := auth.uid();
begin
  if v_me is null or p_topic is null then
    return false;
  end if;
  if p_topic !~ '^walk:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return false;
  end if;

  v_walk := substring(p_topic from 6)::uuid;

  select operator_id, client_id into v_operator, v_client
    from walks where id = v_walk;
  if not found then
    return false;
  end if;

  -- The operator who owns the walk: send and receive. They are the device
  -- producing the stream.
  if v_operator = v_me then
    return true;
  end if;

  -- Nobody else ever sends. The client is an audience, not a participant;
  -- letting them write would let them fabricate their own proof of service.
  if p_send then
    return false;
  end if;

  -- The client the walk belongs to: receive only. Mirrors
  -- walk_gps_points_client_select on the durable rows.
  return my_client_id() is not null and v_client = my_client_id();
end;
$$;

revoke all on function fn_walk_channel_access(text, boolean) from public, anon;
grant execute on function fn_walk_channel_access(text, boolean) to authenticated;

-- ── Policies ────────────────────────────────────────────────────────────
-- SELECT = permission to receive on the topic, INSERT = permission to send.
-- Realtime evaluates these at connect time with the joining user's JWT.
--
-- These are the only policies on realtime.messages, and RLS is deny-by-default,
-- so every topic that is not `walk:{uuid}` is refused for private channels.
-- That is deliberate: this application opens exactly one kind of channel.
drop policy if exists walk_channel_receive on realtime.messages;
create policy walk_channel_receive on realtime.messages
  for select to authenticated
  using (
    extension = 'broadcast'
    and fn_walk_channel_access((select realtime.topic()), false)
  );

drop policy if exists walk_channel_send on realtime.messages;
create policy walk_channel_send on realtime.messages
  for insert to authenticated
  with check (
    extension = 'broadcast'
    and fn_walk_channel_access((select realtime.topic()), true)
  );
