-- 0043 — three low findings: one that stopped being low, and two grants that
--        were never used for anything (review L3, L4, L7).
--
-- ── L7 was downgraded on a condition that has since come true ──────────────
--
-- The review parked the price snapshot at low with an explicit expiry: "there
-- is no pricing UI to change them (B6) and `weekend_surcharge_credits` is 0 for
-- everyone. Becomes a real medium the day the settings screen ships."
--
-- B6 shipped. `Settings.tsx` now edits `service_types.credit_cost`,
-- `weekend_surcharge_credits` and `plans.overage_rate_pence`, so the condition
-- the downgrade rested on is gone: the client agrees a price at booking and is
-- charged whatever the tables say at completion, with nothing in the database
-- proving what the price was.
--
-- Nothing re-reads a review's own downgrade conditions, which is how a finding
-- parked on "unless X" quietly becomes wrong the day somebody ships X.

-- ── 1. L7: the price a walk was agreed at ─────────────────────────────────

alter table walks
  add column cost_credits int,
  add column overage_rate_pence int;

comment on column walks.cost_credits is
  'Credit cost snapshotted when the walk was created (review L7). Null on rows predating 0043; fn_walk_cost falls back to the live tables for those.';
comment on column walks.overage_rate_pence is
  'The client''s overage rate when the walk was created (review L7). Null means "no snapshot", never "free".';

-- Deliberately NOT backfilled. A backfill would stamp TODAY's prices onto
-- historical walks and present them as the agreed price — a guess
-- indistinguishable from a real snapshot, which is worse than an admitted
-- null. Same call 0023 made on untraceable payments and 0038 on notifications
-- of unknown delivery.

-- The snapshot is written by a trigger, not by each creator. A walk is born
-- three ways — `fn_book_walk` (client), the operator's direct INSERT, and
-- `fn_materialize_walks` (nightly) — and a fourth will exist. A trigger cannot
-- be forgotten by the one that comes next.
create function fn_snapshot_walk_price() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.cost_credits is null then
    select st.credit_cost
         + case when extract(isodow from new.scheduled_date) in (6, 7)
                then st.weekend_surcharge_credits else 0 end
      into new.cost_credits
      from service_types st
     where st.id = new.service_type_id;
  end if;

  -- Null when the client is on no plan. That is not "free": the overage path
  -- already refuses a walk with no rate (`failWithoutAttempt`, "not on a
  -- plan"), and writing 0 here would turn that honest refusal into a silent
  -- zero-value charge.
  if new.overage_rate_pence is null then
    select p.overage_rate_pence into new.overage_rate_pence
      from clients c
      left join plans p on p.id = c.plan_id
     where c.id = new.client_id;
  end if;

  return new;
end;
$$;

create trigger trg_walks_snapshot_price
  before insert on walks
  for each row execute function fn_snapshot_walk_price();

revoke all on function fn_snapshot_walk_price() from public, anon, authenticated;

-- Charge the snapshot when there is one. The fallback IS the old behaviour, so
-- nothing changes for rows that predate this migration.
create or replace function fn_walk_cost(p_walk uuid)
returns int
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cost int;
begin
  select coalesce(
           w.cost_credits,
           st.credit_cost
             + case when extract(isodow from w.scheduled_date) in (6, 7)
                    then st.weekend_surcharge_credits else 0 end)
    into v_cost
    from walks w
    join service_types st on st.id = w.service_type_id
   where w.id = p_walk
     and ( fn_is_service_session()
        or w.operator_id = auth.uid()
        or w.client_id = my_client_id() );

  if v_cost is null then
    raise exception 'fn_walk_cost: walk % not found or not accessible', p_walk;
  end if;
  return v_cost;
end;
$$;

revoke all on function fn_walk_cost(uuid) from public, anon;
grant execute on function fn_walk_cost(uuid) to authenticated, service_role;

-- No UPDATE grant on either column for any API role: a snapshot the operator
-- can rewrite afterwards is not a snapshot. Re-pricing an existing walk is a
-- decision, and if a surface for it is ever wanted it needs its own function
-- and its own audit line.

-- ── 2. L3: operator-private columns the client persona could read ─────────
--
-- `0004` granted table-wide SELECT on `clients` while INSERT and UPDATE
-- carried explicit column lists. `0038` replaced the table grant with a column
-- list but reproduced the full set, so the portal's `select("*")` still
-- returned `notes`, `stripe_customer_id` and `stripe_subscription_id`.
--
-- `notes` is the operator's private note ABOUT the client, and nothing writes
-- it today — which is exactly why this is cheap now and expensive later. It is
-- the obvious column the first "internal notes" feature will use, and by then
-- the grant will look deliberate. None of the three has a single reader in
-- `app/src`, so revoking them costs no surface.
revoke select (notes, stripe_customer_id, stripe_subscription_id)
  on clients from authenticated;

-- ── invite_token is deliberately KEPT, against the review's grouping ───────
--
-- L3 lists it alongside the three above. On inspection it is not the same
-- thing, in both directions:
--
--   * The OPERATOR needs it. `InvitePanel` and `Roster` build the claim URL
--     from `clients.invite_token`, and column privileges are role-wide — both
--     personas share `authenticated` — so revoking it from the client takes it
--     from the operator too and breaks the surface H4 just built.
--
--   * The CLIENT gains nothing. `clients_self_select` matches on
--     `auth_user_id = auth.uid()`, so a client can only read the row AFTER
--     claiming — at which point the token is spent, and since 0039 it is also
--     expired and revocable. Reading a dead token is not a capability.
--
-- Splitting it would mean a definer view and rewriting two operator call sites
-- to buy nothing. Recorded as a decision rather than left as an oversight; if
-- an unclaimed client ever becomes able to read their own row, this flips.

-- ── 3. L4: an operator could hard-delete a credential ─────────────────────
--
-- `0004` granted DELETE on `access_credentials` to `authenticated`, which
-- contradicts spec 04's soft-delete rule and routes around the vault: no
-- re-auth, no rate limit, no audit row.
--
-- Since 0042 the row is undeletable in practice anyway — every credential
-- written through `fn_write_credential` gets a `create` audit row, and
-- `credential_access_log.credential_id` is `on delete restrict` into an
-- immutable table. So this grant could only ever have deleted a credential
-- that bypassed the vault to exist, and there is no such path. It is inert in
-- the good case and a hole in the bad one, which is the definition of a grant
-- worth removing.
revoke delete on access_credentials from authenticated;

-- ── 4. Refuse if it did not take ──────────────────────────────────────────
do $$
begin
  if exists (
    select 1 from information_schema.table_privileges
     where table_name = 'access_credentials'
       and grantee in ('authenticated', 'anon')
       and privilege_type = 'DELETE'
  ) then
    raise exception '0043: an API role can still hard-delete a credential — refusing';
  end if;

  if exists (
    select 1 from information_schema.column_privileges
     where table_name = 'clients'
       and grantee = 'authenticated'
       and privilege_type = 'SELECT'
       and column_name in ('notes', 'stripe_customer_id', 'stripe_subscription_id')
  ) then
    raise exception '0043: the client persona can still read operator-only columns — refusing';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgname = 'trg_walks_snapshot_price' and not tgisinternal
  ) then
    raise exception '0043: walks are not snapshotting their price — refusing';
  end if;
end;
$$;
