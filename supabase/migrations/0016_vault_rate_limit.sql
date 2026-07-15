-- 0016 — shared credential-vault rate limiting.
-- Edge-function isolates are ephemeral and parallel, so the vault re-auth
-- limiter must live in Postgres and serialize per user.

create table vault_rate_limit_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references operators (id) on delete cascade,
  ip inet null,
  attempted_at timestamptz not null default now()
);

create index idx_vault_rate_limit_attempts_user_time
  on vault_rate_limit_attempts (user_id, attempted_at desc);

create function fn_vault_allow_attempt(
  p_user uuid,
  p_ip inet default null,
  p_limit int default 5,
  p_window_seconds int default 60
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cutoff timestamptz;
  v_count int;
begin
  if p_user is null then
    raise exception 'fn_vault_allow_attempt: user required';
  end if;
  if p_limit < 1 or p_window_seconds < 1 then
    raise exception 'fn_vault_allow_attempt: invalid limit/window';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));
  v_cutoff := now() - make_interval(secs => p_window_seconds);

  delete from vault_rate_limit_attempts
   where user_id = p_user and attempted_at < v_cutoff;

  select count(*) into v_count
    from vault_rate_limit_attempts
   where user_id = p_user and attempted_at >= v_cutoff;

  if v_count >= p_limit then
    return false;
  end if;

  insert into vault_rate_limit_attempts (user_id, ip) values (p_user, p_ip);
  return true;
end;
$$;

revoke all on table vault_rate_limit_attempts from public, anon, authenticated;
grant all on table vault_rate_limit_attempts to service_role;
revoke all on function fn_vault_allow_attempt(uuid, inet, int, int) from public, anon, authenticated;
grant execute on function fn_vault_allow_attempt(uuid, inet, int, int) to service_role;
