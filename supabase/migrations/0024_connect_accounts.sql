-- 0024 — Stripe Connect: the operator is the merchant of record (review B5)
--
-- `stripeClient()` read a single STRIPE_SECRET_KEY with no stripeAccount, so
-- every client payment for every operator landed in the PLATFORM's Stripe
-- balance and no code path ever moved money to an operator. Operator #2 had
-- no way to be paid at all, and collecting funds on behalf of third parties
-- is money transmission in most US states.
--
-- The decision that shapes this: **operators are the merchant of record, not
-- Sanpo.** That forces Connect *Standard* rather than Express or Custom — on
-- Express and Custom the platform is generally MoR and carries dispute
-- liability, which is exactly what this is not. With Standard:
--   * the charge is created ON the operator's account (a direct charge),
--   * the operator's business appears on the client's card statement,
--   * the operator bears chargeback liability and pays Stripe's fees,
--   * Sanpo is not in the flow of funds at all.
--
-- There is deliberately NO dual-mode fallback to the platform account.
-- deploy-production.yml has never executed (0 runs), so no live customer,
-- subscription or balance exists anywhere; nothing needs migrating, and
-- Stripe cannot move customers between accounts in any case. A permanent
-- legacy branch would be carried forever to serve data that does not exist.

alter table operators
  -- acct_… of the operator's Standard connected account. NULL = not yet
  -- connected, which every money path treats as a hard refusal rather than
  -- quietly charging the platform account.
  add column if not exists stripe_account_id text,
  -- Mirrors of the Connect account state, kept fresh by the account.updated
  -- webhook. Stored rather than fetched because every checkout would
  -- otherwise need a synchronous round-trip to Stripe to learn whether the
  -- operator can be paid.
  add column if not exists stripe_charges_enabled boolean not null default false,
  add column if not exists stripe_payouts_enabled boolean not null default false,
  add column if not exists stripe_details_submitted boolean not null default false,
  add column if not exists stripe_account_connected_at timestamptz;

-- One Stripe account per operator, and one operator per Stripe account. The
-- reverse direction is the one that matters: two operators sharing an account
-- would silently pool their revenue, which is the defect this migration
-- exists to remove.
create unique index if not exists uq_operators_stripe_account
  on operators (stripe_account_id) where stripe_account_id is not null;

-- The operator may READ their Connect state (the UI needs to show whether
-- onboarding is finished) but may never write it. These fields are assertions
-- about what Stripe believes, and an operator who could set
-- stripe_charges_enabled by hand could route a client's money to an account
-- Stripe has suspended.
revoke update (
  stripe_account_id,
  stripe_charges_enabled,
  stripe_payouts_enabled,
  stripe_details_submitted,
  stripe_account_connected_at
) on operators from authenticated;

-- ── Can this operator take money? ────────────────────────────────────────
-- One predicate, so the answer cannot drift between the checkout path, the
-- overage path and the UI. `charges_enabled` is the only field that actually
-- decides it: an account can have details_submitted with charges still
-- disabled while Stripe reviews it, and payouts_enabled can be false (a
-- payout hold) while charges continue to work fine — refusing service then
-- would punish the operator for a Stripe review they cannot hurry.
create or replace function fn_operator_can_charge(p_operator uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select stripe_account_id is not null and stripe_charges_enabled
       from operators where id = p_operator),
    false);
$$;

revoke all on function fn_operator_can_charge(uuid) from public, anon;
grant execute on function fn_operator_can_charge(uuid) to authenticated, service_role;

comment on column operators.stripe_account_id is
  'Standard connected account (acct_…). The operator is the merchant of record: charges are created on this account, and Sanpo is not in the flow of funds.';
