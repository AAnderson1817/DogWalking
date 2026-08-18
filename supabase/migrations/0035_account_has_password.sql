-- 0035 — "does this account have a password at all?" becomes answerable.
--
-- Review M2. `SignIn` offers a magic link, `signInWithOtp` defaults to
-- `shouldCreateUser: true`, and no operator path anywhere sets a password. The
-- vault gates every action on `verifyPassword`. So an operator who has only
-- ever used a magic link cannot open the vault at all — and the way they find
-- out is a message reading "password verification failed", which sounds like
-- they mistyped. They have no password to mistype.
--
-- Worse, `allowAttempt` ran BEFORE the check, so five attempts at a password
-- that cannot exist returned 429 and locked them out of the flagship feature
-- for a minute at a time. On a client's doorstep, in the cold, with no way to
-- fix it inside the product.
--
-- ── Why this needs a database function ────────────────────────────────────
--
-- GoTrue deliberately returns the same `invalid_credentials` for "wrong
-- password" and "this account has no password" — that symmetry is what stops
-- sign-in being an account-existence oracle, and it is correct. So the edge
-- function cannot tell the two apart from the sign-in probe, and
-- `verifyPassword` collapsing every error to a boolean was not the cause so
-- much as the messenger.
--
-- `auth.users.encrypted_password` is the only honest signal, and it is not
-- reachable through PostgREST (the `auth` schema is not exposed, correctly).
-- Hence a definer function.

create function fn_account_has_password(p_user uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_has boolean;
begin
  -- The body check is what keeps this from being an oracle. A service session
  -- (the edge function) may ask about anyone; a signed-in user may ask only
  -- about THEMSELVES. Without it, `authenticated` could probe any uuid for
  -- whether an account exists and how it signs in.
  if not fn_is_service_session() and p_user is distinct from auth.uid() then
    raise exception 'fn_account_has_password: may only ask about your own account';
  end if;

  select coalesce(nullif(u.encrypted_password, ''), null) is not null
    into v_has
    from auth.users u
   where u.id = p_user;

  -- An account that does not exist has no password. Returning null would make
  -- every caller handle a third case that means nothing useful to them.
  return coalesce(v_has, false);
end $$;

revoke all on function fn_account_has_password(uuid) from public, anon;
grant execute on function fn_account_has_password(uuid) to authenticated, service_role;

comment on function fn_account_has_password(uuid) is
  'True when the account has a password set. Callable by the service role for anyone, and by a signed-in user for themselves only — the body check is what stops it being an account oracle (review M2).';
