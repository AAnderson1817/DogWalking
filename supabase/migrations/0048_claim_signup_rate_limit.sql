-- 0048 — a rate limit for claim-signup, the one genuinely public endpoint
-- that creates accounts.
--
-- ── This is a regression, not a gap ───────────────────────────────────────
--
-- Before H31, ClaimInvite created the account with `supabase.auth.signUp`, a
-- GoTrue endpoint governed by its own limiter (config.toml
-- `sign_in_sign_ups = 30` per 5 minutes PER IP). H31 moved account creation
-- into `claim-signup`, which runs `verify_jwt = false` and calls
-- `auth.admin.createUser` with the service role.
--
-- Either way that lands, the control is gone. If GoTrue exempts
-- `/admin/users` from that limiter there is now no limit at all; if it does
-- not, the only IP GoTrue can see is the EDGE FUNCTION'S egress address, so
-- one bucket is shared by every claimant in the world and one attacker
-- exhausts it for everybody — which is worse than no limit. Which of the two
-- is true cannot be established from this repository (no GoTrue here, and
-- supabase.com is blocked by the egress proxy); it is recorded as an owner
-- check because it sizes the harm, not whether the fix is right.
--
-- spec 04 recorded the absence as an accepted residual without noting that
-- the control had previously existed. That is the honest justification for
-- this migration, and it is a stronger one than the two harms the spec names.
--
-- ── Two corrections to spec 04, both of which this migration relies on ────
--
-- 1. The spec discounts the address oracle as "the same fact
--    `fn_preview_invite` gives any authenticated holder, minus the sign-in".
--    That is FALSE. Read from pg_proc:
--      fn_preview_invite(p_token uuid) -> (full_name, business_name, already_claimed)
--    It takes no email and returns no email, so it cannot confirm or deny an
--    address at any rate. The address-confirmation oracle exists ONLY on
--    claim-signup, and unlike preview it needs no account at all. The
--    residual was accepted on a comparison that does not hold.
--
-- 2. The spec defers the fix "if either is ever observed in the trail".
--    Nothing reads `invite_claim_attempts` — no api.ts function, no view, no
--    screen; the table's only consumers are smoke.sql and the migrations. A
--    condition gated on an observation nothing can make is a permanent
--    deferral wearing a trigger's clothes, which is the "written down and
--    connected to nothing" shape this repository keeps finding.
--
-- Also worse than the spec states: BOTH `fn_claim_invite` and
-- `fn_revoke_invite` retain `invite_token`, so it is not "a REAL token" that
-- is a write handle into `invite_claim_attempts` — it is every invite ever
-- issued, including claimed and revoked ones, permanently.
--
-- ── Keyed on the CLIENT, not the caller ───────────────────────────────────
--
-- The backlog said "keyed for an unauthenticated caller", i.e. the IP. That
-- is the wrong key, for three reasons:
--
--   * The attack requires a live token. The token is a stable, unguessable,
--     server-known identifier that IP rotation cannot change, so an IP key
--     bounds nothing an attacker cannot trivially escape.
--   * An IP key locks out people who share one — carrier-grade NAT, an
--     office, a household — none of whom are the attacker.
--   * 0016, the precedent, keys on the SUBJECT BEING PROTECTED (`user_id`),
--     not on the caller. The analogue here is the client the invite belongs
--     to.
--
-- Keying on the client also avoids a growth vector the token key would have
-- created: the token is attacker-supplied, so keying on it would let anyone
-- insert unbounded distinct rows by cycling random uuids. Measured on this
-- schema, a token matching no client writes ZERO rows to
-- `invite_claim_attempts` today — so token-cycling costs an attacker nothing
-- and gains them nothing, and a limiter keyed on the raw token would have
-- been the first thing in the system to give it a cost to US.
--
-- Resolving the token to a client first leaks nothing, because token
-- existence is ALREADY public: the endpoint answers `not_found` for a token
-- matching no client, on the very first request, by design (0039). A 429 on
-- the token-matches-a-client path therefore tells an attacker nothing the
-- first 409 did not.
--
-- ── The trade, stated rather than hidden ──────────────────────────────────
--
-- A token holder can burn the legitimate claimant's budget: a denial of
-- service against one invite. That is accepted, and mitigated three ways —
-- the limit is generous, the window self-heals within the hour, and the
-- operator can reissue the invite (0039 `fn_rotate_invite`). An IP key would
-- avoid this and buy almost nothing, since the attacker controls their IP and
-- the victim does not.
--
-- ── Sizing ───────────────────────────────────────────────────────────────
--
-- The limiter only has to outlast the token, not be impossible: an invite
-- expires in 14 days (0039). At 10 attempts per hour that is roughly 3,360
-- address guesses over the whole life of a token, against an address space
-- that is not brute-forceable — so it converts "I hold the link and a breach
-- list" from minutes into something that cannot finish before the token dies.
-- Ten per hour is also far more than a real person needs: the form enforces
-- the password policy client-side (pattern + minLength), so the common
-- fumble never reaches the database at all, and what remains is retyping a
-- mistaken email address.

create table invite_signup_attempts (
  id uuid primary key default gen_random_uuid(),
  -- The client the invite belongs to. FK, so the table cannot grow beyond the
  -- clients that exist — see the note on retention below.
  client_id uuid not null references clients (id) on delete cascade,
  -- Forensic only, never a key. Same first-hop idiom the vault uses
  -- (credential-vault/index.ts). Nullable: the header may be absent.
  ip inet null,
  attempted_at timestamptz not null default now()
);

create index idx_invite_signup_attempts_client_time
  on invite_signup_attempts (client_id, attempted_at desc);

-- Infrastructure, not a tenant table: it carries no operator_id and invariant
-- 7 does not apply to it, exactly as `job_runs` (0028) does not. Said out
-- loud so the absence reads as a decision rather than an oversight.
--
-- RLS on with NO policies and no API-role grants. 0032 exists because
-- `vault_rate_limit_attempts` — the table this one is modelled on — shipped
-- with no RLS at all and relied solely on a REVOKE; that is not repeated here.
alter table invite_signup_attempts enable row level security;
alter table invite_signup_attempts force row level security;
revoke all on invite_signup_attempts from public, anon, authenticated;

comment on table invite_signup_attempts is
  'Rate-limit ledger for the public claim-signup endpoint (0048). Keyed on the '
  'client the invite belongs to, never on the caller. Infrastructure, not a '
  'tenant table: no operator_id, no policies, no API grants.';

/**
 * Returns true when this attempt may proceed, recording it; false when the
 * client's budget for the window is spent.
 *
 * A token matching no client returns TRUE and records nothing. That is not a
 * hole: such a request is answered `not_found` by the check either way, it
 * writes nothing anywhere, and refusing it would be the only way an attacker
 * could learn a token is real from the limiter — which is precisely what this
 * ordering avoids.
 */
create function fn_invite_signup_allow_attempt(
  p_token uuid,
  p_ip inet default null,
  p_limit int default 10,
  p_window_seconds int default 3600
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client uuid;
  v_cutoff timestamptz;
  v_count int;
begin
  if not fn_is_service_session() then
    raise exception 'fn_invite_signup_allow_attempt: service role required';
  end if;
  if p_token is null then
    raise exception 'fn_invite_signup_allow_attempt: token required';
  end if;
  if p_limit < 1 or p_window_seconds < 1 then
    raise exception 'fn_invite_signup_allow_attempt: invalid limit/window';
  end if;

  -- Token existence is already public via the `not_found` outcome, so
  -- resolving it here reveals nothing new — and it is what keeps the key off
  -- an attacker-supplied value.
  select id into v_client from clients where invite_token = p_token;
  if v_client is null then
    return true;
  end if;

  -- Edge isolates are ephemeral and parallel, so the count must serialize in
  -- Postgres (the reason 0016 exists at all).
  perform pg_advisory_xact_lock(hashtextextended(v_client::text, 0));
  v_cutoff := now() - make_interval(secs => p_window_seconds);

  delete from invite_signup_attempts
   where client_id = v_client and attempted_at < v_cutoff;

  select count(*) into v_count
    from invite_signup_attempts
   where client_id = v_client and attempted_at >= v_cutoff;

  if v_count >= p_limit then
    return false;
  end if;

  insert into invite_signup_attempts (client_id, ip) values (v_client, p_ip);
  return true;
end $$;

-- Retention needs no sweep, and that is a property of the algorithm rather
-- than an omission: the function prunes the key's expired rows and then
-- inserts ONLY while the count is under the limit, so at most `p_limit` rows
-- can exist for a client at any instant. The table's ceiling is therefore
-- `p_limit` x clients — bounded, small, and self-healing — where a limiter
-- keyed on the raw token would have had no ceiling at all. Rows for a deleted
-- client go with it via the FK.

revoke all on function fn_invite_signup_allow_attempt(uuid, inet, int, int)
  from public, anon, authenticated;
grant execute on function fn_invite_signup_allow_attempt(uuid, inet, int, int)
  to service_role;
