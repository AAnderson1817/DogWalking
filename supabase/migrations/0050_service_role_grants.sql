-- 0050 — the two service-role grants 0021 and 0038 revoked half of.
--
-- 0004's header states the rule this schema is built on: "explicit grants per
-- the spec 03 matrix (no reliance on platform default privileges)", and its
-- loop does both halves for each of the original 18 tables — `revoke all ...
-- from public, anon, authenticated` AND `grant all on table %I to
-- service_role`. 0015, 0016 and 0028 each did the same for the table they
-- added.
--
-- Two objects since then did the revoke and omitted the grant:
--
--   * `vault_canary` (0021:94), read by vault-rekey through `adminClient()`
--   * `fn_unsubscribe_by_token(uuid)` (0038:148), called by the public
--     unsubscribe endpoint through `adminClient()`
--
-- Neither is broken on a project that carries Supabase's default ACL, which
-- grants service_role ALL on anything `postgres` creates in `public` — and
-- that is exactly what makes the omission invisible. The privilege was the
-- platform's, not ours, on the one-click opt-out link that goes out in every
-- client-facing email and on the canary that decides whether a vault key
-- opens this project. `scripts/db-push-check.sh` replays the migrations as a
-- non-superuser that holds no such default, and measured all four members of
-- this family unreachable there while still exiting 0; it now asserts the
-- property instead, which is why this migration exists rather than a comment.
--
-- Additive and non-widening by construction: on a real project service_role
-- already holds ALL on both through the default ACL, so these statements
-- change nothing there. A grant cannot subtract, so naming a narrower
-- privilege here does not take the broader one away — it states the privilege
-- the sender actually needs, for the deployment that confers nothing.

grant select on vault_canary to service_role;
grant execute on function fn_unsubscribe_by_token(uuid) to service_role;

do $$
begin
  if not has_table_privilege('service_role', 'vault_canary', 'select') then
    raise exception '0050: service_role still cannot read vault_canary';
  end if;
  if not has_function_privilege(
       'service_role', 'fn_unsubscribe_by_token(uuid)', 'execute') then
    raise exception '0050: service_role still cannot execute fn_unsubscribe_by_token';
  end if;
  raise notice '0050: service_role reaches vault_canary and fn_unsubscribe_by_token';
end $$;
