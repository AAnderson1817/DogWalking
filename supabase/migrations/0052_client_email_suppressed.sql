-- 0052 — the operator is told when a client's address has opted out of email.
--
-- Recorded in spec 04 and the backlog since the client-editing work. An address
-- in `email_suppressions` (0038, review M29) makes every client-facing email to
-- it skip — terminally, by design, since a suppression is somebody asking us to
-- stop. `send-notification` writes `email_status = 'skipped'` and
-- `email_last_error = 'recipient unsubscribed'` on the notification row, and
-- that row is readable by the CLIENT persona and by nobody else:
-- `notifications_operator_select` admits only `client_id is null`. So an
-- operator who saves a client's email as an address that has opted out — a
-- typo they have made before, or a client who unsubscribed from another
-- walker's mail — gets no signal anywhere, and the client simply stops
-- receiving walk reports and billing notices with neither of them knowing why.
--
-- ── What the operator may learn, and why that exposes no operator's list ───
--
-- The backlog asked for this "without exposing one operator's suppression list
-- to another". The rows are of two kinds, and they answer that differently:
--
--   * `operator_id IS NULL` — every operator. The only kind anything writes
--     today (one-click unsubscribe), and deliberately so: a stranger asking to
--     stop is not asking to stop from one business they have never heard of.
--     A row like this is nobody's list. It is the address owner's standing
--     instruction to the whole platform, and it binds every operator — so every
--     operator it binds may learn THAT it binds them, for an address they hold.
--     They would learn it anyway, later and worse, the first time a client asks
--     why the walk reports stopped.
--   * `operator_id = X` — that operator only (nothing writes one yet). The
--     sender consults it only when sending for X, and so does this function,
--     through the same predicate: operator Y can learn nothing about X's rows.
--
-- What leaves the function is one boolean about the caller's OWN client's
-- CURRENT address, labelled with that address (a column the operator can
-- already read — see below): not which business's mail was unsubscribed
-- from, not when, not the reason text, and no way to enumerate or to change
-- the list, which
-- stays unreadable and unwritable by every API role (0038). Stated plainly
-- rather than implied: the operator controls the address, so a determined one
-- can still test any address by writing it into their own client row first —
-- one PATCH per probe. The restriction to saved addresses is not what makes
-- this acceptable; what is revealed is — that someone at an address once
-- unsubscribed from Sanpo email — and it keeps the contract "about my client"
-- rather than letting it grow into an address lookup service.
--
-- ── One rule, one place ───────────────────────────────────────────────────
--
-- The notice must never disagree with the sender about what counts as a match
-- (`lower()` on the address, the operator scope, the type scope). So this asks
-- the sender's own question — `fn_email_suppressed` — rather than restating
-- the predicate, once for every type the sender actually EMAILS. A suppression
-- with no type answers yes for all of them; so do per-type rows covering every
-- one of them, which the schema supports though nothing writes one yet; a
-- per-type row covering some of them leaves the rest deliverable and is
-- correctly not reported as email being off.
--
-- "Every type the sender emails" is not "every notification type", and the
-- first version of this migration asked the latter: `enum_range` includes
-- bell-only types such as `card_saved` (0044) that are never emailed, so
-- per-type opt-outs from all six emailed types left the sender skipping every
-- email while this answered false (Codex, PR #96). The smoke block's "agree
-- with the sender" check had asked the same wrong question, so it could not
-- see it — a test cannot catch an error it shares with the code.
--
-- The emailed set is `CLIENT_FACING` in send-notification/handler.ts, and SQL
-- cannot import it, so `fn_client_facing_notification_types()` is a copy —
-- which 0029 declined to make for `fn_notification_backlog`, because a second
-- copy drifts. This one is tied to the first: `client_facing_parity_test.ts`
-- parses the LAST definition of the function below out of the migrations and
-- compares it with the Set the sender imports, so changing either alone fails
-- the build.
--
-- ── The answer names the address it checked ──────────────────────────────
--
-- The function reads the address the row holds when the statement runs. The
-- caller's copy can be older: another tab edited it, or this tab's own save
-- landed between the screen loading the client and the check running. A bare
-- boolean would then be filed under the address on screen while describing a
-- different one — a notice on a deliverable address, or none on a suppressed
-- one (Codex, PR #96, second round). So each row carries `o_email`, the
-- address actually checked, and the screen keys on that. It discloses nothing:
-- `clients.email` is in the operator's column grant and every client read
-- already selects it.
--
-- Not a raise for a client that is not the caller's, and not a row either: no
-- row is also the answer for a client with no address, so it leaks nothing,
-- and a lookup that could error is one more way for an advisory notice to take
-- down the screen it sits on — the M39 lesson.

create function fn_client_facing_notification_types()
returns notification_type[]
language sql
-- Not immutable: `enum_in` is STABLE (measured), as `enum_out` was for 0038.
stable
set search_path = public
as $$
  select array[
    'walk_complete', 'low_credit', 'renewal_upcoming',
    'payment_failed', 'walk_scheduled', 'walk_cancelled'
  ]::notification_type[];
$$;

-- No API role needs it: the definer function below calls it as its owner.
revoke all on function fn_client_facing_notification_types() from public, anon, authenticated;

comment on function fn_client_facing_notification_types() is
  'The notification types send-notification emails to a client — a copy of CLIENT_FACING in send-notification/handler.ts, pinned to it by client_facing_parity_test.ts (0052).';

create function fn_client_email_suppressed(p_client uuid)
returns table (o_email text, o_suppressed boolean)
language sql
stable
security definer
set search_path = public
as $$
  select c.email,
         coalesce((
           select bool_and(fn_email_suppressed(c.email, c.operator_id, t.value))
             from unnest(fn_client_facing_notification_types()) as t(value)
         ), false)
    from clients c
   where c.id = p_client
     -- The caller check IS the scoping. Only the client's own operator may
     -- ask; a client persona, another operator or an unknown id gets no row.
     and c.operator_id = (select auth.uid())
     and c.email is not null;
$$;

revoke all on function fn_client_email_suppressed(uuid) from public, anon;
grant execute on function fn_client_email_suppressed(uuid) to authenticated;

comment on function fn_client_email_suppressed(uuid) is
  'For the calling operator''s own client: the address checked, and whether every email the sender would send to it is suppressed. Asks fn_email_suppressed for each type in fn_client_facing_notification_types(), so the notice cannot disagree with the sender; no row for anyone else''s client or a client with no address (0052, spec 04).';
