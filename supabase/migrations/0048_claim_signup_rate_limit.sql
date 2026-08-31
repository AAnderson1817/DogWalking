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
-- operator can reissue the invite (0039 `fn_rotate_invite`), which starts a
-- fresh budget. That third mitigation was FALSE when this file was first
-- written: the budget is keyed on the client and rotation mints a token on
-- the same row, so the reissued link inherited the spent budget and the
-- documented remedy did not work. See `fn_reset_invite_signup_budget` below.
-- An IP key would avoid the denial of service and buy almost nothing, since
-- the attacker controls their IP and the victim does not.
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

  -- Re-read the client under the lock and confirm it STILL carries this
  -- token (Codex review on PR #84, second round). The lookup above happens
  -- before serialization and the reset trigger takes no advisory lock, so a
  -- request that resolved the OLD token can sit in this queue while an
  -- operator rotates or purges the invite, and then insert against a client
  -- that still exists. Reproduced in `concurrency.sh` case 6: the reissue
  -- cleared the burned budget and the stale attempt put a row straight back.
  --
  -- Two harms, and the second is the worse one. The reissued invite does not
  -- get the fresh budget the trigger exists to hand it; and the PURGE path
  -- rotates the token the same way, so a stale attempt re-creates an `ip`
  -- row for a client whose personal data was erased on request.
  --
  -- A row lock rather than a bare re-read, and it is load-bearing: the
  -- re-read alone still leaves the window between it and the insert, and that
  -- window is exactly where the purge case does its damage.
  --
  -- On the MODE, measured rather than reasoned about — the first version of
  -- this comment had it wrong. `clients_invite_token_key` makes
  -- `invite_token` UNIQUE, so rotating it is a KEY update and the rotation
  -- takes `for update`, which conflicts with every mode including `for key
  -- share`; a sabotage weakening this line to `for key share` therefore did
  -- NOT go red, which is how the error surfaced. `for no key update` is
  -- still the right choice, for a reason that does not depend on that
  -- uniqueness: it conflicts with a non-key UPDATE too, so a later migration
  -- dropping the unique index cannot silently reopen this window. `for
  -- update` would be heavier for nothing — it also blocks the `for key share`
  -- an unrelated child insert takes on this row.
  --
  -- This reverses a position stated earlier in this file's history, so it is
  -- worth saying why rather than quietly changing sides. The argument against
  -- locking the client row was that it hands an unauthenticated caller a lock
  -- on `clients`. That was overstated: the lock is held for the remainder of
  -- ONE rpc, which is a single autocommit statement the caller cannot
  -- prolong, and callers bearing the same token already serialize on the
  -- advisory lock above, so it adds no contention they were not already
  -- subject to. The objection is sound against a caller that can hold a
  -- transaction open; this one cannot.
  --
  -- Lock order is advisory -> clients -> invite_signup_attempts, and the
  -- rotation's is clients -> invite_signup_attempts (via the trigger). Both
  -- take clients before attempts, so there is no cycle — the 0037 rule.
  --
  -- A stale token is ALLOWED and records nothing, exactly as an unknown one
  -- is: it no longer matches any client, so the check answers `not_found`.
  select id into v_client
    from clients
   where id = v_client and invite_token = p_token
     for no key update;
  if v_client is null then
    return true;
  end if;

  v_cutoff := now() - make_interval(secs => p_window_seconds);

  delete from invite_signup_attempts
   where client_id = v_client and attempted_at < v_cutoff;

  select count(*) into v_count
    from invite_signup_attempts
   where client_id = v_client and attempted_at >= v_cutoff;

  if v_count >= p_limit then
    return false;
  end if;

  -- The token lookup above is unlocked, so an operator deleting an unclaimed
  -- client between it and this insert leaves the FK to raise — and an
  -- unhandled raise here is a 500 from a PUBLIC endpoint for a request the
  -- check would have answered `not_found`, which by then is true (Codex
  -- review on PR #84). `fn_invite_signup_check` already handles this exact
  -- permitted race the same way (0045); this is that precedent applied.
  --
  -- ALLOW rather than refuse: the caller proceeds to the check, which answers
  -- `not_found`. Refusing would 429 a token that no longer matches anything,
  -- which is both wrong and a refusal an attacker could read.
  --
  -- Deliberately NOT closed by locking the client row instead. `select … for
  -- update` here would make an unauthenticated caller able to hold a lock on
  -- `clients`, which trades a rare 500 for a denial-of-service primitive on
  -- the table the whole product reads.
  begin
    insert into invite_signup_attempts (client_id, ip) values (v_client, p_ip);
  exception when foreign_key_violation then
    return true;
  end;
  return true;
end $$;

/**
 * A NEW invite token starts with a fresh budget.
 *
 * The budget is keyed on the client, and every reissue path mints a token on
 * the SAME client row — so without this, a token holder who spent the budget
 * also spent it for the operator's remedy, and the freshly issued link was
 * refused for the rest of the hour (Codex review on PR #84). This header used
 * to list "the operator can reissue the invite" as one of three mitigations
 * for that denial of service, which was simply false: rotation changed the
 * token and left the rows.
 *
 * A trigger rather than an edit to `fn_rotate_invite`, because `invite_token`
 * has FIVE writers across 0039-0046 — `fn_rotate_invite`, `fn_unbind_invite`
 * and three successive replacements of `fn_purge_client` — and fixing the one
 * the reviewer named while leaving its siblings is the defect shape this
 * repository keeps recording. A writer added later gets the reset without
 * knowing the rule exists, which is the 0046 argument verbatim.
 *
 * It is safe in every direction a reissue can come from. An attacker holding
 * only the link cannot rotate: `fn_rotate_invite` and `fn_unbind_invite` both
 * require the owning operator, and `fn_purge_client` is the erasure path,
 * where clearing the rows is not a side effect but the point — they carry an
 * `ip`, so without this they were personal data surviving an erasure request
 * indefinitely, because a purged client receives no further attempts and the
 * prune only ever runs for the key being attempted.
 *
 * AFTER, not BEFORE, and a WHEN clause rather than `update of invite_token`.
 * A BEFORE trigger sees only the row image as it stands when it runs and an
 * `OF` clause is evaluated against the columns the STATEMENT names, so a
 * trigger sorting later that assigned the column would defeat both — the
 * finding Codex made against 0046. An AFTER trigger's WHEN clause is
 * evaluated against the final image, so neither hazard exists here.
 *
 * SECURITY DEFINER because it DELETEs from a table with no API-role grants
 * and forced RLS — unlike 0046's rotation trigger, which only assigns a
 * column on the row already being written and therefore needs no privilege
 * of its own.
 */
create function fn_reset_invite_signup_budget() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from invite_signup_attempts where client_id = new.id;
  return null;
end $$;

revoke all on function fn_reset_invite_signup_budget() from public, anon, authenticated;

create trigger trg_clients_reset_invite_signup_budget
  after update on clients
  for each row
  when (old.invite_token is distinct from new.invite_token)
  execute function fn_reset_invite_signup_budget();

-- An inert trigger that deployed cleanly is worse than a failed deploy: the
-- remedy would silently not work and nothing would say so (the 0028 rule).
do $$
begin
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'clients'::regclass
       and tgname = 'trg_clients_reset_invite_signup_budget'
       and not tgisinternal
  ) then
    raise exception '0048: the budget-reset trigger was not installed — refusing';
  end if;
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
