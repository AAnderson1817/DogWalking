-- 0056 — a client could read their walker's IP address and device from the
-- entry-code trail.
--
-- 0030 put `ip` and `user_agent` on every `credential_access_log` row, so the
-- trail can tell the operator's own phone from somebody else's browser, and
-- gave the client a SELECT policy on their own property's trail. The portal
-- then declined to show the two columns: api.ts's `listMyCredentialLog` says it
-- is "deliberately NOT selecting `ip` or `user_agent`: those describe the
-- operator's device", and spec 04 states the same rule. But the privilege
-- under both personas is 0004's table-level
--
--   grant select on credential_access_log to authenticated;
--
-- and a column added later (0030's `add column ... ip inet`) is covered by a
-- table-level grant. So the rule lived in which columns one query happened to
-- name. Measured before this migration, signed in as a client on the local
-- database, through the policy 0030 wrote for them:
--
--   select action, ip, user_agent from credential_access_log;
--    create | 198.51.100.23 | Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) walker-phone
--
-- That is the walker's IP address (at home, if they looked a code up before
-- leaving) and their device, for every create, rotate, revoke, read and failed
-- re-auth on the client's doors, readable with the shipped anon key and the
-- client's own session. The same shape as `fix(client-columns)`: a rule
-- written beside a query and connected to nothing that enforces it.
--
-- ── Both personas lose the two columns, and that costs nothing ───────────
--
-- Column privileges are role-wide, and the operator and the client are both
-- `authenticated`, so the columns are withheld from the operator's API reads
-- too. No code reads either one for either persona: the operator's
-- `listCredentialLog` selects the same column list as the client's, and every
-- writer is a definer function called by the vault edge function with the
-- service role. The values are still recorded, and the service role still
-- reads them, which is where an investigation of a suspected stolen session
-- starts today. A screen showing an operator which devices opened their vault
-- would be a definer function scoped to the operator; it does not exist yet.
--
-- ── Why a column list, not a column REVOKE ────────────────────────────────
--
-- `revoke select (ip, user_agent)` is a no-op against a table-level grant: a
-- column revoke cannot subtract from it (the 0038 lesson). So the table grant
-- goes and a column list replaces it. A column added to this table from now on
-- is withheld from API roles until a migration grants it by name, which is the
-- safe default for an audit table.

revoke select on credential_access_log from authenticated;

grant select (id, operator_id, credential_id, accessed_by, action, purpose,
              accessed_at, walk_id, created_at)
  on credential_access_log to authenticated;

-- ── Refuse if it did not take ─────────────────────────────────────────────
do $$
begin
  if has_table_privilege('authenticated', 'public.credential_access_log', 'SELECT') then
    raise exception '0056: authenticated still holds a table-level SELECT on credential_access_log, which covers ip and user_agent';
  end if;
  if has_column_privilege('authenticated', 'public.credential_access_log', 'ip', 'SELECT')
     or has_column_privilege('authenticated', 'public.credential_access_log', 'user_agent', 'SELECT') then
    raise exception '0056: authenticated can still read the walker''s IP address or device';
  end if;
  -- anon has no policy on this table, so a grant would return no rows; it is
  -- refused anyway, because nothing signed out has any business with the
  -- trail, and a grant here would be one policy away from a leak.
  if has_any_column_privilege('anon', 'public.credential_access_log', 'SELECT') then
    raise exception '0056: anon holds SELECT on a column of credential_access_log';
  end if;
  if not has_column_privilege('authenticated', 'public.credential_access_log', 'purpose', 'SELECT') then
    raise exception '0056: the trail itself is no longer readable by the people it is for';
  end if;
end $$;
