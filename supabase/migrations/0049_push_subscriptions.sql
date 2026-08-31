-- 0049 — device registrations for Web Push, and the delivery state that says
-- whether a person was actually told (review M27).
--
-- ── Why a table at all, and why this shape ───────────────────────────────
--
-- `notifications` already answers "was a row written". It has said nothing
-- about whether anything left the building for the in-app bell's whole life,
-- and H17 fixed exactly half of that: `email_status` and its three siblings
-- record the EMAIL. Push is the other half, and it gets the same four states
-- for the same reason — "not sent" is three different things, and a sweep
-- that cannot tell them apart either retries forever or abandons real
-- failures.
--
-- The states are aggregate PER NOTIFICATION, not per device, because the
-- question a person asks is "was I told", not "did device 3 of 4 accept it":
--
--   pending  nobody has looked at this row yet.
--   sent     at least one of the recipient's devices accepted it. They were
--            told; a second device failing does not make that untrue.
--   skipped  the recipient has no live device registrations. TERMINAL — a
--            person who never turned push on is not a delivery failure, and
--            retrying them nightly forever is how a backlog stops being read.
--   failed   they had devices and every one of them failed. Retryable.
--
-- Per-device health lives on the subscription row instead (`failure_count`),
-- which is the thing that actually decides whether to keep trying an endpoint.
--
-- ── Invariant 7, and the operator's own devices ──────────────────────────
--
-- This IS a tenant table, so it carries `operator_id` and every policy scopes
-- on it. `client_id is null` means "the operator's own device", which is the
-- convention `notifications` already uses (0004) rather than a new one.
--
-- ── The shared-device hazard, which is the reason registration is an RPC ──
--
-- A push endpoint identifies a browser + service-worker registration, not a
-- person. On a shared phone, A signs in and subscribes, signs out, and B signs
-- in and subscribes: the browser can hand back the SAME endpoint. If the
-- registration merely inserted, B collides with A's row, and whichever of the
-- two rows survives decides who receives notifications on that device. A row
-- left attached to A means B's walk reports go to a device A may still own —
-- the qc(1-4) service-worker leak in a new shape, on a channel that pushes
-- a client's name and address onto a lock screen.
--
-- So registration is a definer RPC that upserts on the endpoint and REASSIGNS
-- ownership, rather than an INSERT grant. The endpoint is the identity of the
-- device; the row says who is currently signed in on it. `authenticated` gets
-- no INSERT, UPDATE or DELETE on this table at all — every write goes through
-- a function that decides the persona itself and cannot be handed someone
-- else's operator_id.

create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  -- Invariant 7. `on delete restrict` matches `notifications`: an operator
  -- row is not removable while anything references it.
  operator_id uuid not null references operators (id) on delete restrict,
  -- null ⇒ the operator's own device (the 0004 `notifications` convention).
  -- CASCADE, unlike notifications' restrict: a subscription is device state,
  -- not a record anyone needs to keep, and it carries an endpoint that
  -- identifies a browser.
  client_id uuid null references clients (id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- Per-device health. A transient failure is not a reason to forget a
  -- device; a 404/410 is, and the send path deletes the row outright for
  -- those rather than keeping a tombstone that hoards a dead endpoint.
  failure_count int not null default 0,
  last_failure_at timestamptz,
  last_error text
);

-- The endpoint is the device's identity, and it is what makes the
-- shared-device reassignment above expressible as one statement.
create unique index uq_push_subscriptions_endpoint on push_subscriptions (endpoint);
-- The send path's only query: "who are this notification's devices".
create index idx_push_subscriptions_recipient
  on push_subscriptions (operator_id, client_id);

alter table push_subscriptions enable row level security;
alter table push_subscriptions force row level security;
revoke all on push_subscriptions from public, anon, authenticated;

-- Read-only, and NOT the whole row: `p256dh` and `auth` are the payload
-- encryption secrets for that device. Withholding them from the browser that
-- generated them buys little on its own — it is the same-origin owner — but
-- it keeps the blast radius of an XSS to "list my devices" rather than "lift
-- the material needed to forge a payload", and it costs nothing.
--
-- NOTE for api.ts: this is a column-restricted table, so `select("*")` on it
-- raises a bare 42501 for EVERY row — PostgREST does not narrow a wildcard to
-- the columns the caller may read. That is the `fix(client-columns)` defect;
-- `scripts/column-grants.test.ts` is the gate.
grant select (id, operator_id, client_id, endpoint, user_agent, created_at,
              last_seen_at, failure_count, last_failure_at)
  on push_subscriptions to authenticated;

create policy push_subscriptions_operator_select on push_subscriptions
  for select to authenticated
  using (operator_id = auth.uid() and client_id is null);
create policy push_subscriptions_client_select on push_subscriptions
  for select to authenticated
  using (client_id = my_client_id());

comment on table push_subscriptions is
  'Web Push device registrations (0049). Tenant table: operator_id + RLS. '
  'client_id null = the operator''s own device. Writes go only through '
  'fn_register_push_subscription / fn_remove_push_subscription.';


-- ── Delivery state, mirroring H17's email machinery exactly ──────────────

create type push_delivery_status as enum ('pending', 'sent', 'skipped', 'failed');

alter table notifications
  add column if not exists push_status push_delivery_status not null default 'pending',
  add column if not exists push_attempts int not null default 0,
  add column if not exists push_sent_at timestamptz,
  add column if not exists push_last_error text;

-- Partial, for the same reason 0029's is: the backlog only ever wants
-- non-terminal rows, and on a busy operator almost everything is terminal.
create index if not exists idx_notifications_push_backlog
  on notifications (created_at)
  where push_status in ('pending', 'failed');

-- Existing rows are marked terminal, not left pending. Unlike 0029's backfill
-- this is not an admission of ignorance — we know perfectly well that no push
-- was ever sent, because there was no push. The point is that they must not be
-- sent NOW: the first sweep would put "your walk is complete" on a lock screen
-- for a walk from last month, which is the same harm 0029 refused.
update notifications set push_status = 'skipped' where push_status = 'pending';

-- No new API-role grants. 0004 gives `authenticated` only `update (read_at)`
-- on notifications — a COLUMN grant — so these four are unwritable by a client
-- without anything further, exactly as 0029's four are. smoke.sql asserts it,
-- because a later table-level `grant update on notifications` would silently
-- let a client mark their own payment_failed push as sent.


-- ── Registration ─────────────────────────────────────────────────────────

/**
 * Register (or re-register) the calling device.
 *
 * The caller's persona is resolved HERE rather than passed in: an operator
 * registers their own device, a client registers theirs, and neither can name
 * an operator_id. A caller who is neither is refused rather than given a row
 * with a guessed owner.
 *
 * Upsert on the endpoint, reassigning ownership — see the shared-device note
 * in this file's header. Re-registration also resets the failure counters,
 * because a browser handing back an endpoint is the best evidence available
 * that it is alive again.
 */
create function fn_register_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_user_agent text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client uuid;
  v_operator uuid;
  v_id uuid;
begin
  if p_endpoint is null or length(p_endpoint) < 8 or p_endpoint !~ '^https://' then
    raise exception 'fn_register_push_subscription: endpoint must be an https url';
  end if;
  -- Shape-checked here rather than trusted, because a truncated key produces a
  -- payload the push service ACCEPTS and the browser silently never opens —
  -- the failure mode _lib/webpush.ts exists to make impossible. 65 raw bytes
  -- base64url-encode to 87 characters, 16 bytes to 22.
  if p_p256dh is null or length(p_p256dh) <> 87 then
    raise exception 'fn_register_push_subscription: p256dh must be 87 base64url characters';
  end if;
  if p_auth is null or length(p_auth) < 22 then
    raise exception 'fn_register_push_subscription: auth must be at least 22 base64url characters';
  end if;

  v_client := my_client_id();
  if v_client is not null then
    select operator_id into v_operator from clients where id = v_client;
  else
    select id into v_operator from operators where id = auth.uid();
  end if;
  if v_operator is null then
    raise exception 'fn_register_push_subscription: caller is neither an operator nor a client';
  end if;

  insert into push_subscriptions (operator_id, client_id, endpoint, p256dh, auth, user_agent)
  values (v_operator, v_client, p_endpoint, p_p256dh, p_auth, p_user_agent)
  on conflict (endpoint) do update
     set operator_id = excluded.operator_id,
         client_id = excluded.client_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         user_agent = excluded.user_agent,
         last_seen_at = now(),
         failure_count = 0,
         last_failure_at = null,
         last_error = null
  returning id into v_id;

  return v_id;
end $$;

revoke all on function fn_register_push_subscription(text, text, text, text)
  from public, anon;
grant execute on function fn_register_push_subscription(text, text, text, text)
  to authenticated;

/**
 * Forget this device. Scoped to the caller, so one person cannot silence
 * another's notifications by guessing an endpoint — endpoints are not secret
 * in any strong sense, and a bare `delete where endpoint = $1` would make
 * this a denial-of-service primitive against anyone whose endpoint leaked.
 *
 * Returns whether a row was actually removed, so the caller can tell
 * "unsubscribed" from "there was nothing here" — a distinction the frontend
 * needs on sign-out, where the absence is the ordinary case.
 */
create function fn_remove_push_subscription(p_endpoint text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client uuid := my_client_id();
  v_rows int;
begin
  if v_client is not null then
    delete from push_subscriptions
     where endpoint = p_endpoint and client_id = v_client;
  else
    delete from push_subscriptions
     where endpoint = p_endpoint
       and operator_id = auth.uid()
       and client_id is null;
  end if;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end $$;

revoke all on function fn_remove_push_subscription(text) from public, anon;
grant execute on function fn_remove_push_subscription(text) to authenticated;


-- ── Erasure ──────────────────────────────────────────────────────────────

/**
 * A purged client's devices go with them.
 *
 * `fn_purge_client` REDACTS the client row rather than deleting it (the FK
 * graph forbids deletion — H5), so the `on delete cascade` above never fires
 * on that path and an endpoint identifying a person's browser would survive an
 * erasure request indefinitely. That is the gap the Codex review found in 0048
 * for `invite_signup_attempts`, and this is the same fix applied before it can
 * become the same defect.
 *
 * A trigger rather than a line inside `fn_purge_client`, following 0046 and
 * 0048: a purge path written later gets this without knowing the rule exists,
 * and it avoids a `create or replace` of a ninety-line function to add one
 * statement — the operation that silently dropped 0029's and 0036's additions
 * when 0040 rebuilt that function from an older body.
 *
 * AFTER, with the WHEN clause reading the final row image. A BEFORE trigger
 * sees only the image as it stands when it runs, and `update of purged_at`
 * is evaluated against the columns the STATEMENT names — both hazards Codex
 * found against 0046.
 */
create function fn_forget_purged_push_subscriptions() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from push_subscriptions where client_id = new.id;
  return null;
end $$;

revoke all on function fn_forget_purged_push_subscriptions() from public, anon, authenticated;

create trigger trg_clients_forget_push_subscriptions
  after update on clients
  for each row
  when (old.purged_at is null and new.purged_at is not null)
  execute function fn_forget_purged_push_subscriptions();

-- An inert trigger that deployed cleanly is worse than a failed deploy: the
-- erasure would silently not erase, and nothing would say so (the 0028 rule).
do $$
begin
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'clients'::regclass
       and tgname = 'trg_clients_forget_push_subscriptions'
       and not tgisinternal
  ) then
    raise exception '0049: the purge trigger was not installed — refusing';
  end if;
end $$;
