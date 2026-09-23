-- 0053 — invariant 5's REVOKE half, for the four definer functions that
-- never had it.
--
-- CLAUDE.md invariant 5: every function touching credits or crossing tenants
-- is SECURITY DEFINER with `search_path = public`, and `REVOKE ALL … FROM
-- PUBLIC, anon`. Seventeen definer functions in this schema are TRIGGER
-- functions, and thirteen of them carry that revoke. These four were created
-- without it (0012–0015), so each kept what a new function gets on the
-- platform — EXECUTE for PUBLIC, anon, authenticated and service_role:
--
--   fn_cancel_paused_walks             (0012, replaced in 0013)
--   fn_refund_cancelled_debit          (0013, replaced in 0023)
--   fn_assert_tenant_consistency       (0014)
--   fn_assert_plan_change_intent_tenant (0015)
--
-- Found by the spec-drift audit, which also found why nothing had said so:
-- the definer catalogue in spec 03 collected GRANTs, and a function nobody
-- grants was rendered as **none** — "no API role can call it" — for four
-- functions every API role could. The generator now models the ACL instead
-- (PR B of the audit), and refuses a definer function PUBLIC or anon can
-- execute; smoke.sql asserts the same rule against the live catalogue.
--
-- NOT EXPLOITABLE, which is why this is hygiene rather than an incident, and
-- measured rather than assumed:
--   - PostgreSQL refuses to call a trigger function directly ("trigger
--     functions can only be called as triggers"), from SQL or through
--     PostgREST's /rpc;
--   - no API role holds CREATE on schema public or TRIGGER on any table in it,
--     so none of them can attach one of these to a table of its own.
--
-- WHY REVOKING CANNOT BREAK THEM. The EXECUTE privilege on a trigger function
-- is checked when the trigger is CREATED, not when it FIRES: the trigger runs
-- for any role that can make the triggering change, EXECUTE or not, and a
-- SECURITY DEFINER body then runs as its owner as it always did. Measured on
-- a throwaway trigger before this was written, and pinned in smoke.sql for
-- the three of these an API role can reach: tenant consistency still refuses
-- a cross-tenant walk for `authenticated`, a pause window still cancels the
-- walks inside it, and cancelling a debited walk still refunds its credit.
-- The fourth guards `plan_change_intents`, which no API role can write.
--
-- `authenticated` is revoked too, matching the other thirteen: EXECUTE on a
-- trigger function is never required by an API role, and invariant 5 grants
-- only where required. service_role keeps what the platform default gave it,
-- as the other thirteen do.

revoke all on function fn_cancel_paused_walks() from public, anon, authenticated;
revoke all on function fn_refund_cancelled_debit() from public, anon, authenticated;
revoke all on function fn_assert_tenant_consistency() from public, anon, authenticated;
revoke all on function fn_assert_plan_change_intent_tenant() from public, anon, authenticated;

-- Refuse if it did not take — a revoke that silently named another signature
-- would deploy green and change nothing. `has_function_privilege` answers for
-- the role AND for PUBLIC, which anon and authenticated are members of.
do $$
declare
  v_open text;
begin
  select string_agg(p.oid::regprocedure::text, ', ' order by p.proname) into v_open
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('fn_cancel_paused_walks', 'fn_refund_cancelled_debit',
                       'fn_assert_tenant_consistency', 'fn_assert_plan_change_intent_tenant')
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
          or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  if v_open is not null then
    raise exception '0053: still executable by an API role: % — refusing', v_open;
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('fn_cancel_paused_walks', 'fn_refund_cancelled_debit',
                           'fn_assert_tenant_consistency', 'fn_assert_plan_change_intent_tenant')) <> 4 then
    raise exception '0053: expected exactly the four trigger functions, one signature each — refusing';
  end if;
end $$;
