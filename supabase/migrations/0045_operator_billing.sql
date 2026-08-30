-- 0045: Sanpo's own revenue model — operator trial + platform subscription
-- state, and the invite pre-flight that lets client accounts be created
-- server-side (review H31).
--
-- H31's finding is that the product has no way to charge the OPERATOR, and
-- that public GoTrue signup cannot be closed without breaking client invites:
-- ClaimInvite calls `supabase.auth.signUp` in the browser, so the same toggle
-- that would gate operator acquisition kills the client claim path. The fix
-- lands in three layers; this migration is the database's share:
--
--   1. `operators` learns when the 14-day trial ends and what the operator's
--      $49/month platform subscription currently is. These columns are
--      written ONLY by the service role (the `operator-billing` and
--      `platform-webhook` edge functions); no API role may insert or update
--      them — see the grant rework below, which also closes a pre-existing
--      hole in the same shape.
--   2. `fn_invite_signup_check` answers, for the service role, exactly what
--      `fn_claim_invite` WOULD answer for a token + email pair — so the new
--      public `claim-signup` edge function can refuse a dead invite BEFORE
--      creating an auth account. (`fn_preview_invite` and `fn_claim_invite`
--      both raise without `auth.uid()`, so the service role cannot ask them.)
--   3. `invite_claim_attempts.attempted_by` becomes nullable, because a
--      refusal at signup-check time happens before any account exists to
--      attribute it to — and those refusals are precisely the probes the
--      H4 log exists to make visible.
--
-- Deliberately NOT here: any RLS or grant change that locks a lapsed
-- operator out of their DATA. The subscription gate lives in the app
-- (RequireRole) and in the billing edge functions; an operator whose card
-- failed still owns their client records, walk history and door codes, and
-- holding those hostage over a $49 platform bill would be hostile. The gate
-- gates the product, not the tenant's data.

-- ── 1. Trial + platform subscription state ─────────────────────────────────

-- A volatile default on ADD COLUMN is evaluated for every existing row at
-- migration time, so every pre-0045 operator gets a fresh 14 days from the
-- moment this deploys. Deliberate: the fair start for a gate that did not
-- exist when they signed up, and the same clock a brand-new operator gets.
alter table operators
  add column trial_ends_at timestamptz not null
    default (now() + interval '14 days');

comment on column operators.trial_ends_at is
  'When the operator''s free trial of Sanpo itself ends (review H31; 14 days from signup). Before this instant the app is fully usable with no subscription; after it, RequireRole shows the subscribe screen unless platform_subscription_status is live. Written only by default at row creation — no API role may set or move it.';

-- Stripe ids live on Sanpo's PLATFORM account — the one place client money
-- never moves (operators are the merchant of record for that, review B5).
-- The platform_ prefix is the account boundary: these must never be confused
-- with clients.stripe_customer_id / stripe_subscription_id, which live on
-- the operator's own connected account.
alter table operators
  add column platform_customer_id text null,
  add column platform_subscription_id text null,
  add column platform_subscription_status subscription_status not null
    default 'none';

comment on column operators.platform_customer_id is
  'Stripe Customer (cus_…) for the OPERATOR on Sanpo''s platform account — who pays the $49/month (review H31). Written by operator-billing before any checkout link is minted (the connect-onboarding persist-before-link rule).';
comment on column operators.platform_subscription_id is
  'Stripe Subscription (sub_…) on the platform account, bound by platform-webhook from the checkout session. One live subscription per operator.';
comment on column operators.platform_subscription_status is
  'Mirror of the platform subscription''s Stripe status, mapped onto the existing enum (trialing counts as active). ''none'' means never subscribed — after trial_ends_at that reads as locked.';

-- Same shape as uq_operators_stripe_account (0024): one Stripe customer,
-- one operator, nulls exempt.
create unique index uq_operators_platform_customer
  on operators (platform_customer_id)
  where platform_customer_id is not null;

-- ── 2. The INSERT grant becomes a column list ──────────────────────────────
--
-- 0004 granted TABLE-LEVEL insert on operators to authenticated, which
-- covers every column including ones added later — so without this, a new
-- operator could create their own row with `trial_ends_at = '2099-01-01'`
-- or `platform_subscription_status = 'active'` from the browser during
-- onboarding and never pay. A column REVOKE cannot subtract from a
-- table-level grant (the recorded 0038 lesson), so the table grant goes and
-- an explicit column list replaces it.
--
-- The list is: the columns Onboard and the staging-smoke replay actually
-- send (id, business_name, display_name, email, phone, terms_version,
-- terms_accepted_at — 0041 relied on the table-level grant for the terms
-- pair, so they must be named here or operator signup stops recording
-- consent), plus the columns the operator may already UPDATE (timezone,
-- currency, low_credit_threshold, cancellation_cutoff_hours,
-- gps_retention_days), which add no capability at insert time.
--
-- This also closes a hole that predates H31: the five Connect columns were
-- UPDATE-revoked in 0024 but insertable at row creation, so an operator
-- could forge `stripe_charges_enabled = true` before ever touching Stripe.
-- They are simply not in the list. Fail-closed for the future, same as the
-- 0038 clients SELECT list: a column added to operators is not insertable
-- until it is granted here.
revoke insert on operators from anon, authenticated;
grant insert (
  id, business_name, display_name, email, phone, timezone, currency,
  low_credit_threshold, cancellation_cutoff_hours, gps_retention_days,
  terms_version, terms_accepted_at
) on operators to authenticated;

-- ── 3. A refusal can predate the account it refused ────────────────────────
--
-- 0039 made attempted_by NOT NULL because every attempt then came from a
-- signed-in user. The signup pre-flight below refuses BEFORE the account is
-- created, and an unlogged refusal is invisible — the exact gap H4 closed.
-- A null attempted_by row reads as "someone holding this token and typing
-- this address, refused before any account existed".
alter table invite_claim_attempts
  alter column attempted_by drop not null;

comment on column invite_claim_attempts.attempted_by is
  'The auth user who presented the token, or NULL for a pre-account refusal from the signup pre-flight (0045). Deliberately not a FK: the row must outlive the account.';

-- ── 4. The signup pre-flight ───────────────────────────────────────────────
--
-- Answers exactly what fn_claim_invite WOULD answer for this token, were it
-- called by a signed-in user whose email is p_email — the parity the smoke
-- suite pins by driving both functions across every outcome. claim-signup
-- creates the auth account with p_email, so the email the eventual claim
-- sees is the email checked here; a mismatch refused here is an account
-- that was never created, instead of one stranded with nothing to claim.
--
-- The ladder below must stay byte-for-byte in step with fn_claim_invite
-- (0041). If the claim ladder changes, change this one in the same
-- migration or the pre-flight starts admitting signups the claim refuses.
--
-- No FOR UPDATE, unlike the claim: this is an advisory pre-flight, binds
-- nothing, and the claim re-decides under its own row lock — while a lock
-- here would hand the public claim-signup endpoint a way to serialise
-- writes against a client row it will never own.
--
-- Only REFUSALS are logged. A passing check is followed within moments by
-- the real authenticated claim, which writes the 'claimed' row; logging the
-- pass too would double-log every legitimate signup, and a trail that
-- repeats itself is the trail H3/M14 already fought to keep legible. The
-- refusals have nowhere else to land — before this function, a dead-token
-- probe against the public endpoint would leave no trace at all.
create function fn_invite_signup_check(p_token uuid, p_email text)
returns invite_claim_outcome
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client  clients%rowtype;
  v_email   text;
  v_outcome invite_claim_outcome;
begin
  if not fn_is_service_session() then
    raise exception 'fn_invite_signup_check: service role required';
  end if;

  select * into v_client
    from clients
   where invite_token = p_token;

  -- No row: nothing to log against and no tenant to file it under (the
  -- 0039 rule — uuid guessing is not the threat the log exists for).
  if v_client.id is null then
    return 'not_found';
  end if;

  v_email := nullif(lower(trim(p_email)), '');

  if v_client.auth_user_id is not null then
    v_outcome := 'already_claimed';
  elsif v_client.invite_revoked_at is not null then
    v_outcome := 'revoked';
  elsif v_client.invite_expires_at is not null
        and v_client.invite_expires_at <= now() then
    v_outcome := 'expired';
  elsif v_client.email is not null
        and lower(trim(v_client.email)) is distinct from v_email then
    v_outcome := 'email_mismatch';
  else
    v_outcome := 'claimed';
  end if;

  if v_outcome <> 'claimed' then
    insert into invite_claim_attempts
      (operator_id, client_id, attempted_by, attempted_email, outcome)
    values (v_client.operator_id, v_client.id, null, v_email, v_outcome);
  end if;

  return v_outcome;
end;
$$;

comment on function fn_invite_signup_check(uuid, text) is
  'Pre-account invite validation for the claim-signup edge function (review H31): returns what fn_claim_invite would return for this token + email, so a dead invite is refused before any auth account is created. Service role only; logs refusals to invite_claim_attempts with a null attempted_by.';

revoke all on function fn_invite_signup_check(uuid, text)
  from public, anon, authenticated;
grant execute on function fn_invite_signup_check(uuid, text) to service_role;

-- ── 5. Refuse if any of it did not take ────────────────────────────────────
--
-- An inert migration that deployed cleanly is the recorded failure mode
-- (0020, 0028). Each check names the sentence a person needs, not a 42501.
do $$
begin
  -- The whole point of section 2: billing state is not self-servable.
  if has_column_privilege('authenticated', 'operators', 'trial_ends_at', 'insert') then
    raise exception '0045: an operator can insert their own trial_ends_at — refusing';
  end if;
  if has_column_privilege('authenticated', 'operators', 'platform_subscription_status', 'insert') then
    raise exception '0045: an operator can insert their own subscription status — refusing';
  end if;
  -- The pre-existing 0024-shaped hole this grant rework also closes.
  if has_column_privilege('authenticated', 'operators', 'stripe_charges_enabled', 'insert') then
    raise exception '0045: an operator can still forge stripe_charges_enabled at signup — refusing';
  end if;
  -- ...and none of the four is updatable either (the UPDATE grant was
  -- already a column list; this pins that it stays one).
  if has_column_privilege('authenticated', 'operators', 'trial_ends_at', 'update')
     or has_column_privilege('authenticated', 'operators', 'platform_subscription_status', 'update')
     or has_column_privilege('authenticated', 'operators', 'platform_customer_id', 'update')
     or has_column_privilege('authenticated', 'operators', 'platform_subscription_id', 'update') then
    raise exception '0045: an operator can rewrite platform billing state — refusing';
  end if;

  -- The other direction: signup must still work. A grant list that omits
  -- what Onboard sends breaks every new operator at the door (and dropping
  -- the terms pair would silently stop recording consent — H6).
  if not has_column_privilege('authenticated', 'operators', 'business_name', 'insert')
     or not has_column_privilege('authenticated', 'operators', 'terms_version', 'insert')
     or not has_column_privilege('authenticated', 'operators', 'terms_accepted_at', 'insert') then
    raise exception '0045: the operators INSERT list broke signup — refusing';
  end if;

  if has_function_privilege('authenticated', 'fn_invite_signup_check(uuid, text)', 'execute') then
    raise exception '0045: fn_invite_signup_check is callable by an API role — refusing';
  end if;
  if not has_function_privilege('service_role', 'fn_invite_signup_check(uuid, text)', 'execute') then
    raise exception '0045: the service role cannot run the signup pre-flight — refusing';
  end if;

  if (select is_nullable from information_schema.columns
       where table_schema = 'public'
         and table_name = 'invite_claim_attempts'
         and column_name = 'attempted_by') <> 'YES' then
    raise exception '0045: attempted_by is still NOT NULL — pre-account refusals cannot be logged — refusing';
  end if;
end $$;
