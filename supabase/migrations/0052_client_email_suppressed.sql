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
-- CURRENT address: not which business's mail was unsubscribed from, not when,
-- not the reason text, and no way to enumerate or to change the list, which
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
-- the sender's own question — `fn_email_suppressed` — for every notification
-- type, rather than restating the predicate. A suppression with no type
-- answers yes for all of them, which is what "email to this address is off"
-- means; a typed row (a per-type preference, which nothing writes yet) leaves
-- other types deliverable and is correctly NOT reported as a full stop. The
-- smoke block pins the agreement in both directions.
--
-- Not a raise for a client that is not the caller's: answering false leaks
-- nothing (it is also the answer for "yours, and deliverable"), and a lookup
-- that could error is one more way for an advisory notice to take down the
-- screen it sits on — the M39 lesson.

create function fn_client_email_suppressed(p_client uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(bool_and(fn_email_suppressed(c.email, c.operator_id, t.value)), false)
    from clients c
   cross join unnest(enum_range(null::notification_type)) as t(value)
   where c.id = p_client
     -- The caller check IS the scoping. Only the client's own operator may
     -- ask; a client persona, another operator or an unknown id gets false.
     and c.operator_id = (select auth.uid())
     and c.email is not null;
$$;

revoke all on function fn_client_email_suppressed(uuid) from public, anon;
grant execute on function fn_client_email_suppressed(uuid) to authenticated;

comment on function fn_client_email_suppressed(uuid) is
  'True when every email to the calling operator''s own client''s current address is suppressed. Asks fn_email_suppressed for every notification type, so the notice cannot disagree with the sender; false for anyone else''s client (0052, spec 04).';
