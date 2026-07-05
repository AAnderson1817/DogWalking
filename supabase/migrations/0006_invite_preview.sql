-- 0006 — invite preview (phase 04)
-- /claim/:token must show who the invite belongs to BEFORE fn_claim_invite
-- binds the caller. Under the spec-03 matrix an unlinked authenticated user
-- cannot select the clients row, so the phase-04 "definer fn" option is
-- used: a narrow SECURITY DEFINER lookup returning only non-sensitive
-- fields for a valid, unclaimed token. anon keeps zero access (spec 03).

create function fn_preview_invite(p_token uuid)
returns table (full_name text, business_name text, already_claimed boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'fn_preview_invite: authentication required';
  end if;
  return query
    select c.full_name, o.business_name, (c.auth_user_id is not null)
      from clients c
      join operators o on o.id = c.operator_id
     where c.invite_token = p_token;
end;
$$;

revoke all on function fn_preview_invite(uuid) from public, anon;
grant execute on function fn_preview_invite(uuid) to authenticated, service_role;
