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
/**
 * Is this endpoint one of the push services this system will POST to?
 *
 * Codex review on PR #85, and the finding is a server-side request forgery:
 * registration accepted ANY https url and `send-notification` then POSTed to
 * it from the edge runtime, with the outcome readable back off
 * `notifications.push_last_error`. Any authenticated caller could therefore
 * probe HTTPS services reachable from a shared runtime and read the answer.
 *
 * This file shipped a device QUOTA instead, on the stated ground that a host
 * allowlist would be brittle across providers. That priced the cost of having
 * one and not the cost of not having one: a quota bounds how much outbound
 * work a caller can cause and says nothing whatever about where it goes,
 * which is the whole of the finding. Both are kept — the comment on the quota
 * below is corrected to say so.
 *
 * Refusing here rather than only at send time is what makes the failure
 * legible: the person toggling notifications on gets an error naming their
 * push service, instead of a switch that reads "on" and never delivers. The
 * residual — a browser whose push service is not listed cannot enable push —
 * is stated in docs/spec/01 rather than discovered.
 *
 * `immutable` because it is a pure function of its argument, which also lets
 * it be used in a CHECK or an index later without a rewrite.
 */
create function fn_is_push_service_endpoint(p_endpoint text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  -- Kept in step with PUSH_SERVICE_HOSTS / PUSH_SERVICE_HOST_SUFFIXES in
  -- supabase/functions/_lib/webpush.ts by app/scripts/push-service-hosts.test.ts.
  -- Two enforcement points is deliberate; two DIFFERENT lists would be the
  -- payment_status drift this repository has already paid for once.
  v_hosts text[] := array[
    'fcm.googleapis.com',                 -- Chrome, Chromium, Brave, Opera, Edge on Android
    'updates.push.services.mozilla.com',  -- Firefox
    'web.push.apple.com'                  -- Safari
  ];
  -- The leading dot is load-bearing: without it '.notify.windows.com' also
  -- admits 'evilnotify.windows.com', which anyone can register.
  v_suffixes text[] := array[
    '.notify.windows.com',                -- Edge / WNS, e.g. wns2-by3p.notify.windows.com
    '.push.apple.com',                    -- Apple regional
    '.push.services.mozilla.com'          -- Mozilla autopush regional
  ];
  v_authority text;
  v_suffix    text;
begin
  if p_endpoint is null then
    return false;
  end if;
  -- Everything between the scheme and the first '/', '?' or '#' — the whole
  -- AUTHORITY, userinfo and port included, deliberately not parsed apart.
  -- 'https://fcm.googleapis.com@evil.example/' has a host of 'evil.example'
  -- and reads to a skimming human as a Google domain; comparing the entire
  -- authority means that string matches nothing, which is the answer that
  -- cannot be got subtly wrong. A non-default port fails for the same reason.
  --
  -- lower() over the WHOLE endpoint, not just the authority, because the
  -- scheme is case-insensitive too and this regex is not. That and the :443
  -- strip below exist because the two implementations of this rule DISAGREED
  -- on two inputs when they were first written, measured rather than
  -- reasoned about: `URL` normalises both away, so the sender accepted
  -- 'HTTPS://fcm.googleapis.com/…' and 'https://fcm.googleapis.com:443/…'
  -- while this refused them. Neither was a hole — registration was the
  -- stricter side, so no row could carry one — but "one list, one rule" is
  -- the entire claim these two halves make, and a security control whose two
  -- implementations differ is one nobody can reason about.
  -- scripts/check-push-endpoint-parity.sh is the gate that found it.
  v_authority := substring(lower(p_endpoint) from '^https://([^/?#]+)');
  if v_authority is null then
    return false;
  end if;
  -- The default port, which `URL` deletes. Only this one: an explicit 8080
  -- would open every internal service reachable on an allowlisted name.
  v_authority := regexp_replace(v_authority, ':443$', '');
  if v_authority = any (v_hosts) then
    return true;
  end if;
  foreach v_suffix in array v_suffixes loop
    -- right(), not LIKE: a suffix is compared as text, so no character in it
    -- can ever be read as a wildcard.
    if right(v_authority, length(v_suffix)) = v_suffix then
      return true;
    end if;
  end loop;
  return false;
end;
$$;

revoke all on function fn_is_push_service_endpoint(text) from public, anon;

comment on function fn_is_push_service_endpoint(text) is
  'Whether an endpoint names a browser push service this system will POST to '
  '(0049). The send side enforces the same list from '
  'supabase/functions/_lib/webpush.ts; the two are pinned together by '
  'app/scripts/push-service-hosts.test.ts.';

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
  -- The host, not just the scheme (Codex review on PR #85). See
  -- fn_is_push_service_endpoint: an arbitrary https endpoint here is an SSRF
  -- primitive at send time. Named in the message because the caller supplied
  -- it and is the one who can act on it.
  if not fn_is_push_service_endpoint(p_endpoint) then
    raise exception 'fn_register_push_subscription: % is not a push service this system sends to',
      coalesce(substring(p_endpoint from '^https://([^/?#]+)'), 'that endpoint');
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

  -- Serialize the whole read-modify-write per RECIPIENT, and take the lock
  -- FIRST (Codex review on PR #85, fourth and eighth rounds).
  --
  -- The quota below is a count-then-delete, and under READ COMMITTED each
  -- concurrent transaction sees only the committed rows plus its own insert —
  -- so with nine devices already present, any number of simultaneous calls
  -- each see ten, each delete nothing, and all commit. The quota bounded
  -- nothing against exactly the caller it exists to bound, who can trivially
  -- issue concurrent requests. Same instrument as 0016's vault limiter and
  -- 0048's: an advisory lock on the subject being protected, taken before the
  -- read.
  --
  -- Keyed on the CLIENT where there is one, and only on the operator for an
  -- operator's own devices — not on the pair. A client belongs to exactly one
  -- operator, so the pair says nothing extra about which recipient this is,
  -- and the single-value key is what lets the advisory lock come BEFORE the
  -- `clients` read: the pair cannot be computed until `operator_id` has been
  -- read, which would force clients-row-then-advisory here against 0048's
  -- advisory-then-clients-row. Two functions taking the same two locks in
  -- opposite orders is the 0037 cycle, and this key is derived exactly as
  -- 0048's is, so the two provably cannot interleave into one.
  v_client := my_client_id();
  if v_client is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_client::text, 0));
    -- LOCKED, and `purged_at is null` (Codex review on PR #85, eighth round).
    -- Unlocked and unfiltered, a registration that began before an erasure
    -- inserted its row AFTER `fn_purge_client` had tombstoned the client and
    -- the trigger at the foot of this file had deleted every device it knew
    -- about: an endpoint identifying a browser, surviving the erasure request
    -- H5 exists to honour. Reproduced as concurrency.sh case 8 before this
    -- line existed.
    --
    -- The lock is what closes it, not the predicate: `fn_purge_client` takes
    -- `for update` on this row, so this read waits for it and then re-reads
    -- the committed tombstone. The predicate alone would still race.
    --
    -- Not reachable sequentially — the purge NULLs `auth_user_id`, so
    -- afterwards `my_client_id()` returns null and this branch is never
    -- entered — which is why nothing but an interleave finds it.
    select operator_id into v_operator
      from clients
     where id = v_client and purged_at is null
       for no key update;
    if v_operator is null then
      raise exception 'fn_register_push_subscription: this client record has been erased';
    end if;
  else
    select id into v_operator from operators where id = auth.uid();
    if v_operator is null then
      raise exception 'fn_register_push_subscription: caller is neither an operator nor a client';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(v_operator::text, 0));
  end if;

  -- The reassignment is CONDITIONAL on presenting the endpoint's existing key
  -- material (Codex review on PR #85). Unconditional, it contradicted this
  -- file's own reasoning two functions down: `fn_remove_push_subscription` is
  -- scoped to the caller precisely because an endpoint is not secret enough to
  -- authorize acting on it — and then this let any authenticated caller who
  -- learned an endpoint claim that row, which silently stops the victim's
  -- notifications AND starts delivering the claimant's onto the victim's
  -- device.
  --
  -- The key check is exactly the right discriminator, because the genuine
  -- shared-device case is "the browser handed back the SAME subscription":
  -- `pushManager.subscribe()` with an existing registration and the same
  -- application server key returns the existing object, so the endpoint and
  -- the keys arrive together. A caller who knows only the endpoint cannot
  -- produce the keys — they never leave the browser that made them, and 0049
  -- withholds them from `authenticated` for this reason among others.
  insert into push_subscriptions (operator_id, client_id, endpoint, p256dh, auth, user_agent)
  values (v_operator, v_client, p_endpoint, p_p256dh, p_auth, p_user_agent)
  on conflict (endpoint) do update
     set operator_id = excluded.operator_id,
         client_id = excluded.client_id,
         auth = excluded.auth,
         user_agent = excluded.user_agent,
         last_seen_at = now(),
         failure_count = 0,
         last_failure_at = null,
         last_error = null
   where push_subscriptions.p256dh = excluded.p256dh
  returning id into v_id;

  if v_id is null then
    -- The endpoint exists under different key material. Either a caller
    -- claiming somebody else's device, or the far rarer case of a browser
    -- recycling an endpoint with a fresh keypair — which this refuses too,
    -- and that residual is recorded in spec 01 rather than guessed at.
    raise exception 'fn_register_push_subscription: endpoint is registered to a different device';
  end if;

  -- Bound the device count per recipient (Codex review on PR #85).
  --
  -- The host check above decides WHERE a request may go; this bounds HOW MUCH.
  -- They are not alternatives, and an earlier version of this comment said
  -- they were — it justified having no host check on the ground that a quota
  -- bounded the damage, which was wrong about what the damage is.
  --
  -- Even with every endpoint a genuine push service, an authenticated caller
  -- can register unbounded real subscriptions. Every later notification loads
  -- ALL of a recipient's rows and POSTs to each one sequentially BEFORE the
  -- email arm runs, so that is unbounded outbound work per notification on a
  -- shared runtime, and it delays or loses the sender's own email.
  --
  -- A quota rather than validation, because it bounds the work regardless of
  -- how an endpoint got there. Ten is far more than a person has (phone,
  -- tablet, two laptops is four) and small enough that the sequential sends
  -- stay bounded.
  --
  -- Evicting the OLDEST rather than refusing the newest: the device in front
  -- of somebody right now is the one that matters, and a refusal would make
  -- an ordinary eleventh browser look broken. `last_seen_at` is the ordering
  -- because re-registration refreshes it, so an actively used device is not
  -- evicted by one that was opened once.
  --
  -- `id <> v_id` is the load-bearing clause, not a belt-and-braces one. Two
  -- registrations inside ONE transaction share a `last_seen_at`, because
  -- `now()` is transaction-constant (the 0028 lesson) — so the ordering
  -- cannot separate them and the row just registered is as likely to be
  -- evicted as any other. Excluding it states the property that actually
  -- matters: registering a device never evicts that device. The `id`
  -- tiebreaker makes the rest deterministic rather than arbitrary.
  delete from push_subscriptions
   where id in (
     select id from push_subscriptions
      where operator_id = v_operator
        and client_id is not distinct from v_client
        and id <> v_id
      order by last_seen_at desc, id desc
      offset 9
   );

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


-- ── The nightly drain has to see push failures too ───────────────────────
--
-- Codex review on PR #85. `deliverPush` records `failed` for a transient push
-- service error and calls it retryable — but `fn_notification_backlog`
-- filtered on `email_status` alone, so a notification whose email SUCCEEDED
-- and whose push failed was never selected again and stayed failed forever.
-- "Retryable" was written down and connected to nothing, which is the shape
-- this repository keeps finding.
--
-- The return type is unchanged on purpose: the caller reads `id` and nothing
-- else, and changing the shape would need a DROP (a `create or replace`
-- cannot alter a return type), which for a function the deploy re-applies is
-- more risk than the widening is worth.
--
-- Built from `pg_get_functiondef` of the live 0029 function rather than from
-- its migration text — the 0040 lesson: a body written from an older source
-- silently deletes whatever a later migration added.
create or replace function fn_notification_backlog(
  p_window interval default '24:00:00'::interval,
  p_max_attempts integer default 5
) returns table(id uuid, email_status email_delivery_status, email_attempts integer, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select n.id, n.email_status, n.email_attempts, n.created_at
    from notifications n
   where n.created_at > now() - p_window
     and (
       (n.email_status in ('pending', 'failed') and n.email_attempts < p_max_attempts)
       or (n.push_status in ('pending', 'failed') and n.push_attempts < p_max_attempts)
     )
   order by n.created_at
$$;


-- ── Giving up has to be visible on the push channel too ──────────────────
--
-- Codex review on PR #85, third round. The widened backlog above excludes a
-- push past `p_max_attempts` or older than `p_window` — but
-- `fn_expire_notification_backlog` touched only the email fields, so such a
-- row simply vanished from the drain: no give-up note in `push_last_error`,
-- no contribution to the abandoned count, and `push_status` left `failed`
-- forever with nothing that would ever look at it again.
--
-- That is the asymmetry of having mirrored H17's four states and its backlog
-- predicate but not its EXPIRY. The whole argument for four states is that a
-- row says what happened to it; a row that stops being retried without
-- recording why says less than the two-state version it replaced.
--
-- Built from `pg_get_functiondef` of the live 0029 function (the 0040 lesson),
-- with the email half byte-identical and a second statement beside it.
create or replace function fn_expire_notification_backlog(
  p_window interval default '24:00:00'::interval,
  p_max_attempts integer default 5
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
  v_email_ids uuid[];
  v_push_ids uuid[];
begin
  if not fn_is_service_session() then
    raise exception 'fn_expire_notification_backlog: service role required';
  end if;

  with expired as (
  update notifications
     set email_status = 'failed',
         email_last_error = coalesce(email_last_error, '')
           || case when email_last_error is null then '' else ' | ' end
           || case
                when email_attempts >= p_max_attempts
                  then format('gave up after %s attempts', email_attempts)
                else format('aged out of the %s retry window', p_window)
              end
   where email_status in ('pending', 'failed')
     and (created_at <= now() - p_window or email_attempts >= p_max_attempts)
     -- Idempotent: a row already carrying a give-up note must not accrue a
     -- second one every night for the rest of time.
     and coalesce(email_last_error, '') not like '%gave up after%'
     and coalesce(email_last_error, '') not like '%aged out of%'
  returning id
  )
  select coalesce(array_agg(id), '{}') into v_email_ids from expired;

  -- The push mirror, with the same idempotence guard for the same reason.
  with expired as (
  update notifications
     set push_status = 'failed',
         push_last_error = coalesce(push_last_error, '')
           || case when push_last_error is null then '' else ' | ' end
           || case
                when push_attempts >= p_max_attempts
                  then format('gave up after %s attempts', push_attempts)
                else format('aged out of the %s retry window', p_window)
              end
   where push_status in ('pending', 'failed')
     and (created_at <= now() - p_window or push_attempts >= p_max_attempts)
     and coalesce(push_last_error, '') not like '%gave up after%'
     and coalesce(push_last_error, '') not like '%aged out of%'
  returning id
  )
  select coalesce(array_agg(id), '{}') into v_push_ids from expired;
  -- One number, because the caller's question is "how many rows were
  -- abandoned tonight" and a row abandoned on both channels is still one row
  -- somebody was not told.
  --
  -- Which is why summing the two counts was wrong (Codex review on PR #85):
  -- a row that expired on BOTH channels appeared in each and was reported
  -- twice, inflating the nightly figure that `fn_run_nightly_jobs` surfaces —
  -- the comment above described the intent and the arithmetic contradicted
  -- it. The DISTINCT union is what the sentence actually says.
  -- `array_agg` in a CTE rather than `returning … into`, which takes ONE row
  -- and raises on more (found by running it, not by reading it — the
  -- migration applied cleanly because PL/pgSQL resolves a body at EXECUTION,
  -- the same reason `fn_book_walk`'s phantom `active` column shipped).
  select count(distinct id) into v_count
    from unnest(v_email_ids || v_push_ids) as id;
  return v_count;
end $$;
