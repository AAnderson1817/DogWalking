-- 0046 — two holes around a client whose record has been erased, and around
-- the one-click unsubscribe link.
--
-- Both were found while building the client/property edit surface (PR #79) and
-- were recorded there as residuals rather than smuggled into a frontend-only
-- change. Both need a definer function or a trigger, so they need a migration.

-- ── 1. Rotating an invite UN-REVOKES a purged client ──────────────────────
--
-- `fn_purge_client` (0040) leaves the tombstone safe AT REST: it nulls `email`,
-- mints a fresh `invite_token` so the old one stops resolving, and — the part
-- that matters here — sets `invite_revoked_at = now()`.
--
-- `fn_rotate_invite` then sets `invite_revoked_at = null` and stamps a fresh
-- 14-day expiry. It carries an `auth_user_id is null` predicate, and the purge
-- NULLS `auth_user_id`, so a tombstone looks exactly like an unclaimed client
-- to it. One call undoes the purge's own revocation.
--
-- Measured against this schema before the fix, as the owning operator:
--
--   after purge:  revoked_at set = t, email is null = t
--   after rotate: revoked_at = NULL, expires in future = t, purged_at set = t
--   fn_invite_signup_check(<new token>, 'stranger@example.test') -> claimed
--
-- That last line is the whole finding. A purged client's `email` is NULL, which
-- is precisely the rung of the claim ladder that admits ANY address (0039,
-- 0045) — so the erased record becomes claimable by a stranger, and the signup
-- pre-flight then RESERVES that stranger's address onto the tombstone, writing
-- personal data back into a record erased on request.
--
-- `fn_unbind_invite` (0042) already carries `purged_at is null`. This is its
-- sibling acquiring the same predicate — the "applied to one site and not its
-- sibling" shape this repository has recorded more than once.
--
-- Built from `pg_get_functiondef` of the LIVE function rather than from the
-- 0039 text, because a `create or replace` written from an older body silently
-- deletes whatever a later migration added (the 0040 lesson). Verified
-- identical to 0039 apart from the single added predicate.
create or replace function fn_rotate_invite(p_client uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token uuid;
begin
  -- The caller check IS the safety property. Without it this is a cross-tenant
  -- invite generator: any authenticated user could mint a live token for any
  -- client in the system and then claim it themselves.
  update clients
     set invite_token = gen_random_uuid(),
         invite_expires_at = now() + interval '14 days',
         invite_revoked_at = null
   where id = p_client
     and operator_id = (select auth.uid())
     and auth_user_id is null
     -- 0046. Minting a live bearer credential for an erased record makes it
     -- claimable again; see the header.
     and purged_at is null
  returning invite_token into v_token;

  if v_token is null then
    -- One message for "not yours", "no such client", "already claimed" and now
    -- "purged". Splitting them would make this an existence oracle over every
    -- client id in the product, and an operator looking at their own roster
    -- already knows which case they are in.
    raise exception 'fn_rotate_invite: no unclaimed invite for this client';
  end if;

  return v_token;
end;
$$;

-- `fn_revoke_invite` is deliberately NOT given the same predicate, and the
-- asymmetry is the point rather than an oversight:
--
--   * rotate MINTS a live token. On a tombstone that is the defect above.
--   * revoke KILLS one. On a tombstone it is a no-op in effect (the purge
--     already revoked) and it moves toward safety.
--
-- Refusing it would remove the only in-product remedy for a row that already
-- carries a live invite from before this migration — exactly the rows §2
-- repairs. A guard that blocks the safe direction is worse than no guard.

-- ── 2. Repair the rows the hole already produced ──────────────────────────
--
-- A purged client whose invite is live can only have got that way through the
-- path above. Re-revoke them, and report the count rather than repairing
-- silently — if this prints a non-zero number anywhere, that is a record
-- somebody erased and a token somebody could still have used.
do $$
declare v_n integer;
begin
  update clients
     set invite_revoked_at = now()
   where purged_at is not null
     and invite_revoked_at is null;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    raise warning '0046: re-revoked % purged client(s) carrying a live invite', v_n;
  else
    raise notice '0046: no purged client carried a live invite';
  end if;
end $$;

-- ── 3. The one-click unsubscribe link outlives the address it was sent to ──
--
-- `clients.unsubscribe_token` (0038) is a bearer credential: presenting it to
-- the public `unsubscribe` function suppresses whatever address the row holds
-- AT THE MOMENT OF THE CLICK, because `fn_unsubscribe_by_token` reads
-- `lower(c.email)` then.
--
-- So the M29 recovery — "the operator corrects a mistyped address" — has a
-- sting in it. The stranger who received mail at the typo'd address still holds
-- a live one-click link, and clicking it now suppresses the CORRECTED address:
-- the real client silently stops receiving every client-facing email, terminally
-- (`send-notification` records a suppression as `skipped`, never `failed`, so
-- the nightly drain will not retry it).
--
-- Rotating on any change of address closes it. A trigger rather than a definer
-- RPC, deliberately: the column carries no UPDATE grant for any API role, so a
-- caller CANNOT do this for itself, and every writer of `clients.email` — the
-- operator's edit form, the client persona's own contact edit, the 0045 signup
-- reservation, and whatever writes it next — gets the rotation without knowing
-- the rule exists. A rule the next caller has to remember is a rule that will
-- be forgotten.
--
-- Compared NORMALISED, matching both claim ladders: `lower(trim(...))`. A
-- capitalisation fix admits exactly the same claimant and reaches exactly the
-- same inbox, so killing a live link over it would cost a real unsubscribe
-- path for no security gain. `is distinct from` so NULL→address and
-- address→NULL both count as changes.
create function fn_rotate_unsubscribe_token() returns trigger
language plpgsql
as $$
begin
  if lower(trim(coalesce(new.email, ''))) is distinct from
     lower(trim(coalesce(old.email, ''))) then
    new.unsubscribe_token := gen_random_uuid();
  end if;
  return new;
end;
$$;

comment on function fn_rotate_unsubscribe_token() is
  'Rotates clients.unsubscribe_token whenever the normalised email changes, so a one-click link sent to a previous address cannot suppress the new one (0046).';

-- Not SECURITY DEFINER: it assigns to NEW rather than reading or writing any
-- table, so it needs no privileges of its own. Verified that a BEFORE trigger
-- may set a column the CALLER has no UPDATE grant on — that is what makes this
-- reachable at all from `authenticated`, which may update `email` but not
-- `unsubscribe_token`.
--
-- Fires for the service role too, on purpose: the token must not survive an
-- address change whoever made it. `fn_purge_client` rotates the token itself
-- and also nulls the email, so this fires there as well and simply rotates a
-- second time — harmless, and cheaper than an exception nobody would maintain.
-- `before update` and NOT `before update of email`, deliberately. The `OF`
-- clause is evaluated against the columns the STATEMENT names, not against
-- what the row image actually ends up holding — measured here: with a second
-- BEFORE trigger assigning `new.email`, an `OF email` trigger does not fire at
-- all when the statement never mentioned the column. No trigger ASSIGNS
-- `new.email` today (checked with `prosrc ~ 'new\.email\s*:='` across every
-- trigger function in `public`; the only match for a bare `new.email` is this
-- function's own comparison), so this is defence in depth rather than a live
-- fix; but
-- the whole argument for putting this in a trigger is that the next writer of
-- `clients.email` should not have to know the rule exists, and an `OF` clause
-- quietly reintroduces exactly that requirement one level down. The function
-- compares old against new, so firing on every update costs one comparison.
create trigger trg_clients_rotate_unsubscribe_token
  before update on clients
  for each row execute function fn_rotate_unsubscribe_token();

-- ── 4. Refuse rather than deploy inert ────────────────────────────────────
--
-- A migration that applies cleanly and changes nothing is the failure this
-- repository keeps recording. Each of the three assertions below fails the
-- deploy rather than letting it report success.
do $$
declare
  -- Comments STRIPPED before the match. Checking the raw definition would let
  -- a future edit satisfy this guard with a comment while deleting the
  -- predicate — demonstrated on this schema: a function whose only mention of
  -- `purged_at is null` was in a `--` comment matched a naive `position()`.
  -- That is the "passes for the wrong reason" shape, in the check written to
  -- prevent it.
  --
  -- The BEHAVIOURAL proof is in `smoke.sql`, which drives the real function
  -- against a real purged client and then asserts end to end that the
  -- tombstone's token admits nobody. This is the deploy-time structural
  -- backstop, and it is honest about being only that.
  v_def text := regexp_replace(
    pg_get_functiondef('fn_rotate_invite(uuid)'::regprocedure), '--[^\n]*', '', 'g');
begin
  if position('purged_at is null' in v_def) = 0 then
    raise exception '0046: fn_rotate_invite did not gain the purged_at guard — refusing';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'clients'::regclass
       and tgname = 'trg_clients_rotate_unsubscribe_token'
       and not tgisinternal
  ) then
    raise exception '0046: the unsubscribe-token rotation trigger was not installed — refusing';
  end if;

  -- The repair is only meaningful if it actually reached every row.
  if exists (select 1 from clients where purged_at is not null and invite_revoked_at is null) then
    raise exception '0046: a purged client still carries a live invite after the repair — refusing';
  end if;
end $$;
