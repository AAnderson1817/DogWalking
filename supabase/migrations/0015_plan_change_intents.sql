-- 0015 — durable, webhook-finalized plan changes.
-- The edge function records an intent before touching Stripe, then the
-- customer.subscription.updated webhook applies the local plan + credit
-- proration exactly once. This avoids moving the Stripe subscription while
-- leaving PawTrail's database on the old plan after a mid-request failure.

create table plan_change_intents (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references operators (id) on delete restrict,
  client_id uuid not null references clients (id) on delete restrict,
  requested_by uuid not null references operators (id) on delete restrict,
  old_plan_id uuid null references plans (id) on delete restrict,
  new_plan_id uuid not null references plans (id) on delete restrict,
  stripe_subscription_id text null,
  stripe_update_idempotency_key text not null unique,
  remaining_fraction numeric not null check (remaining_fraction >= 0 and remaining_fraction <= 1),
  status text not null default 'pending' check (status in ('pending', 'applied')),
  stripe_event_id text null unique,
  requested_at timestamptz not null default now(),
  applied_at timestamptz null,
  created_at timestamptz not null default now()
);

create index idx_plan_change_intents_client_pending
  on plan_change_intents (client_id, requested_at desc)
  where status = 'pending';

create function fn_apply_plan_change_intent(p_intent uuid, p_event_id text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_intent plan_change_intents%rowtype;
  v_balance int;
begin
  if not fn_is_service_session() then
    raise exception 'fn_apply_plan_change_intent: service role required';
  end if;
  if p_event_id is null or length(p_event_id) = 0 then
    raise exception 'fn_apply_plan_change_intent: event id required';
  end if;

  select * into v_intent
    from plan_change_intents
   where id = p_intent
   for update;
  if not found then
    raise exception 'fn_apply_plan_change_intent: unknown intent %', p_intent;
  end if;

  if v_intent.status = 'applied' then
    select credit_balance into v_balance from clients where id = v_intent.client_id;
    return v_balance;
  end if;

  select fn_change_plan(v_intent.client_id, v_intent.new_plan_id, v_intent.remaining_fraction)
    into v_balance;

  update plan_change_intents
     set status = 'applied', stripe_event_id = p_event_id, applied_at = now()
   where id = v_intent.id;

  return v_balance;
end;
$$;

revoke all on table plan_change_intents from public, anon, authenticated;
grant all on table plan_change_intents to service_role;
revoke all on function fn_apply_plan_change_intent(uuid, text) from public, anon, authenticated;
grant execute on function fn_apply_plan_change_intent(uuid, text) to service_role;

create function fn_assert_plan_change_intent_tenant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from clients c where c.id = new.client_id and c.operator_id = new.operator_id) then
    raise exception 'tenant consistency: plan-change client must belong to operator';
  end if;
  if new.old_plan_id is not null and not exists (
    select 1 from plans p where p.id = new.old_plan_id and p.operator_id = new.operator_id
  ) then
    raise exception 'tenant consistency: plan-change old plan must belong to operator';
  end if;
  if not exists (select 1 from plans p where p.id = new.new_plan_id and p.operator_id = new.operator_id) then
    raise exception 'tenant consistency: plan-change new plan must belong to operator';
  end if;
  return new;
end;
$$;

create trigger trg_plan_change_intents_tenant_consistency
  before insert or update of operator_id, client_id, old_plan_id, new_plan_id
  on plan_change_intents
  for each row execute function fn_assert_plan_change_intent_tenant();
