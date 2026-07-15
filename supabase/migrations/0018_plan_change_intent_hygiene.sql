-- 0018 — plan-change intent hygiene (review fixes on 0015).
--
-- 1. At most ONE pending intent per client. Without this, two concurrent
--    change-plan requests each insert an intent, both Stripe updates fire,
--    and both webhook events apply — fn_change_plan runs twice and the
--    credit proration double-applies.
-- 2. fn_record_plan_change_intent makes reuse-or-supersede-or-insert a
--    single serialized transaction (the edge function previously did a
--    lookup + insert as two REST calls, a TOCTOU race).
--
-- Supersede semantics: a pending intent whose target differs from the new
-- request is deleted. It is safe to drop because a pending intent means its
-- webhook confirmation has not arrived; if its Stripe update actually
-- succeeded, the operator's newer request supersedes it commercially too —
-- the newest requested plan is what the client ends up on, and the webhook
-- for the old update can no longer match a deleted intent (exact-id or
-- sub+plan matching only, so it is skipped rather than misapplied).

-- One-time cleanup so the partial unique index can build: keep only the
-- newest pending intent per client.
delete from plan_change_intents p
 using plan_change_intents newer
 where p.status = 'pending'
   and newer.status = 'pending'
   and newer.client_id = p.client_id
   and (newer.requested_at, newer.id) > (p.requested_at, p.id);

create unique index uq_plan_change_intents_one_pending
  on plan_change_intents (client_id)
  where status = 'pending';

create function fn_record_plan_change_intent(
  p_operator uuid,
  p_client uuid,
  p_requested_by uuid,
  p_old_plan uuid,
  p_new_plan uuid,
  p_subscription text,
  p_fraction numeric
) returns table (o_intent_id uuid, o_idempotency_key text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing plan_change_intents%rowtype;
begin
  if not fn_is_service_session() then
    raise exception 'fn_record_plan_change_intent: service role required';
  end if;
  if p_fraction is null or p_fraction < 0 or p_fraction > 1 then
    raise exception 'fn_record_plan_change_intent: fraction out of range';
  end if;

  -- Serialize per client (same per-client lock discipline as the credit
  -- engine) so concurrent requests can't interleave supersede/insert.
  perform 1 from clients where id = p_client for update;
  if not found then
    raise exception 'fn_record_plan_change_intent: unknown client %', p_client;
  end if;

  select * into v_existing
    from plan_change_intents
   where client_id = p_client and status = 'pending'
   for update;

  if found
     and v_existing.new_plan_id = p_new_plan
     and coalesce(v_existing.stripe_subscription_id, '') = coalesce(p_subscription, '') then
    -- Same target: reuse the intent AND its Stripe idempotency key so a
    -- retry replays the original Stripe update instead of issuing a new one.
    o_intent_id := v_existing.id;
    o_idempotency_key := v_existing.stripe_update_idempotency_key;
    return next;
    return;
  end if;

  if found then
    delete from plan_change_intents where id = v_existing.id;
  end if;

  insert into plan_change_intents (
    operator_id, client_id, requested_by, old_plan_id, new_plan_id,
    stripe_subscription_id, stripe_update_idempotency_key, remaining_fraction
  ) values (
    p_operator, p_client, p_requested_by, p_old_plan, p_new_plan,
    p_subscription, gen_random_uuid()::text, p_fraction
  )
  returning id, plan_change_intents.stripe_update_idempotency_key
       into o_intent_id, o_idempotency_key;
  return next;
end;
$$;

revoke all on function fn_record_plan_change_intent(uuid, uuid, uuid, uuid, uuid, text, numeric)
  from public, anon, authenticated;
grant execute on function fn_record_plan_change_intent(uuid, uuid, uuid, uuid, uuid, text, numeric)
  to service_role;
