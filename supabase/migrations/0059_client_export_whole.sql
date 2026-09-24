-- 0059 — the client's copy holds what Sanpo holds about them.
--
-- `fn_export_client_data` (0040) was written when the schema was forty
-- migrations younger, and nothing asked it to keep up. It held the client's
-- contact fields, properties, pets, walks, entry-credential labels, the
-- ledger and payments, and left out route traces, photos, the log of who
-- opened the client's entry codes, the walker's notes, the consent record,
-- schedules and every column added since. The privacy notice said so (0054's
-- review made it), so the gap was honest; it was still a gap in the one path
-- that answers "what do you hold about me".
--
-- ── Who makes the copy, and who reads it ──────────────────────────────────
--
-- The notice sends every request to the walker, and the walker is the
-- business, so this function runs as the walker and answers the question for
-- them. Whatever the copy holds, the walker reads on its way to the client.
-- That decides the rule:
--
--   The copy holds everything Sanpo holds about the client that the walker
--   can already read, and the walker's own note about them (`clients.notes`,
--   which 0043 withheld from both personas because grants are role-wide; it
--   is the walker's note about the client, and a request to know covers it).
--
-- It leaves out four kinds of thing, each for a reason the client is given:
--
--   1. What describes someone else: the walker's IP address and device on
--      the entry-code log (0056), whether the walker read their own notices,
--      and the address typed on every claim of the account through the
--      invite link and on every attempt the invite refused (the client's own
--      included; the copy says when each was made, how it ended, and whether
--      it came from the client's account).
--   2. Secrets whose copy is a liability: the vault ciphertext (invariant 2),
--      the invite and unsubscribe links' keys, a device's push keys.
--   3. What the walker must not learn: the messages Sanpo sent the client,
--      the record of an opt-out or of turning email back on (the walker is
--      shown one bit, 0052, and the copy carries that bit), and the client's
--      devices. The client can read the messages in their own account. The
--      opt-out and lift record reaches them by no path yet: `fn_my_email_status`
--      answers only the address and a state (docs/dev/backlog.md). Also
--      0048's rate-limit ledger: the time and network address of each request
--      to create an account through the invite link, which no API role reads.
--      The check logs only refusals (0045), so a request it passed that no
--      claim followed is recorded there and nowhere else. The copy's list
--      therefore gives times only for the claims and refusals the file holds,
--      and names the ledger in a sentence of its own.
--   4. What is about the system rather than the person: delivery bookkeeping,
--      claim tokens, `updated_at`, Stripe's identifiers, and how a plan change
--      was carried out (the plans before and after it, and every charge, are
--      in the copy). A credit entry's note is copied as written, and some
--      writers put the payment's Stripe id in it; the copy says so.
--
-- The copy carries that list in the client's words (`not_included`), with
-- two things this database cannot reach: the client's sign-in account, and
-- the Stripe event payloads Sanpo keeps (both are open in docs/dev/backlog.md).
-- The privacy notice quotes the same sentences, and
-- app/scripts/legal-version.test.ts fails if the two ever differ: a notice
-- that described the copy in its own words once said the email setting was
-- left out while the copy carried it.
--
-- ── Why it cannot fall behind again ────────────────────────────────────────
--
-- smoke.sql holds a manifest: every column of every table that holds a
-- client's data (derived from the foreign keys that lead to `clients`, plus
-- the opt-out list, which is keyed by address) is decided exactly once:
-- exported, with the path it reaches in the copy; derived, with the
-- expression that says what the copy holds for it; or left out with one of
-- the four reasons. A column added anywhere in that set fails smoke until
-- somebody decides. A fixture fills every column the manifest checks: each
-- exported value must be found at its path, a child row's parent must hold
-- exactly as many children as the database gives it, and each value that
-- must stay out must appear nowhere in the copy.
--
-- ── Not for an erased client ──────────────────────────────────────────────
--
-- An erased client's copy is refused. Once `fn_purge_client` has run, what is
-- left is either being destroyed (the photos, until the erasure's second
-- phase) or kept only as the walker's financial record, and packaging either
-- as the client's data would undo the erasure the client asked for. The
-- screen says to make the copy first; the erasure sheet has always said so.
--
-- ── The walker's notices ──────────────────────────────────────────────────
--
-- The copy holds every notice the walker received about the client (0057's
-- subject), including the ones about the walker's own setup ("Walk for <name>
-- could not be billed — check your setup", whose body says the client "has
-- not been contacted about it"; B6, H13). They concern the client's walks and
-- charges, and a request to know covers them.
--
-- ── Routes come separately ─────────────────────────────────────────────────
--
-- Measured on the local database: a client with two years of walks and 400
-- points on each (292,000 points) exports as one 20 MB document in 2.9 s,
-- close enough to the hosted 8 s statement timeout that a slower instance
-- or a busier client would lose the whole copy. So the record carries each
-- walk's point count, and `fn_export_client_routes` returns the points for a
-- batch of walks the caller names. The browser sizes its batches by those
-- counts and stops if a walk it asked for does not come back.
--
-- Coordinates are rounded to six decimal places (about 11 cm, far below a
-- phone's accuracy), which is most of what keeps a route small.
--
-- ── Photos ─────────────────────────────────────────────────────────────────
--
-- SQL cannot read a storage object, so the record lists every object Storage
-- holds in the client's folders (`stored_photos`, read the way 0058's erasure
-- reads them) and the walker's browser fetches each one (its storage policy
-- covers its own folder, 0004) into the archive. That includes a pet's
-- earlier photos and any visit photo whose row was never written: Sanpo holds
-- them, so the copy does. A photo that cannot be fetched is marked missing in
-- the copy and counted, rather than stopping the export.

create or replace function fn_export_client_data(p_client uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_client clients%rowtype;
begin
  select * into v_client from clients
   where id = p_client and operator_id = (select auth.uid());
  if v_client.id is null then
    raise exception 'fn_export_client_data: no such client';
  end if;
  if v_client.purged_at is not null then
    raise exception 'fn_export_client_data: this client has been erased';
  end if;

  return jsonb_build_object(
    'format', 'sanpo.client-export',
    'version', 2,
    'exported_at', now(),
    -- Money is in cents: the *_pence columns hold cents (CLAUDE.md), and a
    -- reader goes by the key, so the keys say cents.
    'currency', 'USD',
    'held_by', (select jsonb_build_object('business_name', o.business_name)
                  from operators o where o.id = v_client.operator_id),

    'client', jsonb_build_object(
      'full_name', v_client.full_name,
      'email', v_client.email,
      'phone', v_client.phone,
      'status', v_client.status,
      'notes', v_client.notes,
      'has_account', v_client.auth_user_id is not null,
      'created_at', v_client.created_at,
      'credit_balance', v_client.credit_balance,
      'subscription_status', v_client.subscription_status,
      'current_period_end', v_client.current_period_end,
      -- The one bit the walker's own screen shows (0052): whether every email
      -- Sanpo would send to this address is turned off. When and why are not
      -- theirs to read.
      'email_turned_off', case when v_client.email is null then null
                               else fn_email_fully_suppressed(v_client.email, v_client.operator_id) end,
      'plan', (select jsonb_build_object(
                 'name', pl.name, 'cycle', pl.cycle,
                 'price_cents', pl.price_pence,
                 'credits_per_cycle', pl.credits_per_cycle,
                 'overage_rate_cents', pl.overage_rate_pence,
                 'rollover_policy', pl.rollover_policy)
                 from plans pl where pl.id = v_client.plan_id),
      'privacy_notice', jsonb_build_object(
        'version', v_client.notice_version,
        'accepted_at', v_client.notice_accepted_at),
      'invite', jsonb_build_object(
        'expires_at', v_client.invite_expires_at,
        'withdrawn_at', v_client.invite_revoked_at)),

    'properties', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'label', p.label,
        'address_line1', p.address_line1, 'address_line2', p.address_line2,
        'city', p.city, 'postcode', p.postcode,
        'access_notes', p.access_notes_public,
        'lat', p.lat, 'lng', p.lng,
        'created_at', p.created_at) order by p.created_at, p.id)
        from properties p where p.client_id = p_client), '[]'::jsonb),

    'entry_credentials', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ac.id, 'property_id', ac.property_id,
        'label', ac.label, 'entry_method', ac.entry_method,
        'created_at', ac.created_at, 'rotated_at', ac.rotated_at,
        'revoked_at', ac.revoked_at,
        'activity', coalesce((
          select jsonb_agg(jsonb_build_object(
            'action', l.action, 'at', l.accessed_at,
            'purpose', l.purpose, 'walk_id', l.walk_id)
            order by l.accessed_at, l.id)
            from credential_access_log l where l.credential_id = ac.id), '[]'::jsonb))
        order by ac.created_at, ac.id)
        from access_credentials ac
        join properties p2 on p2.id = ac.property_id
       where p2.client_id = p_client), '[]'::jsonb),

    'pets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pe.id, 'name', pe.name, 'breed', pe.breed, 'size', pe.size,
        'temperament', pe.temperament, 'medical_notes', pe.medical_notes,
        'feeding_notes', pe.feeding_notes, 'medication_notes', pe.medication_notes,
        'vet_name', pe.vet_name, 'vet_phone', pe.vet_phone,
        'reactive', pe.is_reactive, 'escape_risk', pe.is_escape_risk,
        'active', pe.active, 'photo_path', pe.photo_path,
        'created_at', pe.created_at) order by pe.created_at, pe.id)
        from pets pe where pe.client_id = p_client), '[]'::jsonb),

    'schedules', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', rs.id, 'property_id', rs.property_id,
        'service', (select st.name from service_types st where st.id = rs.service_type_id),
        'days_of_week', rs.days_of_week,
        'window_start', rs.window_start, 'window_end', rs.window_end,
        'start_date', rs.start_date, 'end_date', rs.end_date,
        'paused_from', rs.paused_from, 'paused_until', rs.paused_until,
        'active', rs.active, 'created_at', rs.created_at,
        'pet_ids', coalesce((select jsonb_agg(sp.pet_id order by sp.pet_id)
                               from schedule_pets sp where sp.schedule_id = rs.id), '[]'::jsonb))
        order by rs.created_at, rs.id)
        from recurring_schedules rs where rs.client_id = p_client), '[]'::jsonb),

    -- Routes are fetched separately, a batch of walks at a time
    -- (fn_export_client_routes), because a client with years of walks has
    -- hundreds of thousands of points. Each walk says how many it has, so
    -- the caller can size its batches and check that every point arrived.
    'route_point_fields', jsonb_build_array('recorded_at', 'lat', 'lng', 'accuracy_m', 'gap_before'),
    'walks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', w.id, 'property_id', w.property_id, 'schedule_id', w.schedule_id,
        'service', (select st.name from service_types st where st.id = w.service_type_id),
        'scheduled_date', w.scheduled_date, 'originally_scheduled', w.origin_date,
        'window_start', w.window_start, 'window_end', w.window_end,
        'status', w.status, 'cancel_reason', w.cancel_reason,
        'started_at', w.started_at, 'ended_at', w.ended_at,
        'left_unfinished_at', w.abandoned_at,
        'distance_m', w.distance_m, 'notes', w.notes,
        'care', jsonb_build_object('pee', w.potty_pee, 'poo', w.potty_poo,
                                   'fed', w.fed, 'watered', w.watered),
        'report_sent_at', w.report_sent_at, 'created_at', w.created_at,
        'cost_credits', w.cost_credits, 'credits_debited', w.credits_debited,
        'charged_as_overage', w.is_overage,
        'overage_rate_cents', w.overage_rate_pence,
        'visit_price_cents', w.visit_price_pence,
        'pet_ids', coalesce((select jsonb_agg(wp.pet_id order by wp.pet_id)
                               from walk_pets wp where wp.walk_id = w.id), '[]'::jsonb),
        'route_points', (select count(*) from walk_gps_points g where g.walk_id = w.id),
        'photos', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'id', ph.id, 'storage_path', ph.storage_path,
                   'caption', ph.caption, 'taken_at', ph.taken_at,
                   'byte_size', ph.byte_size, 'sha256', ph.sha256)
                 order by ph.taken_at, ph.id)
            from walk_photos ph where ph.walk_id = w.id), '[]'::jsonb))
        order by w.scheduled_date, w.window_start, w.id)
        from walks w where w.client_id = p_client), '[]'::jsonb),

    'ledger', coalesce((
      select jsonb_agg(jsonb_build_object(
        'at', cl.created_at, 'entry_type', cl.entry_type,
        'amount', cl.amount, 'balance_after', cl.balance_after,
        'expires_at', cl.expires_at, 'note', cl.note, 'walk_id', cl.walk_id)
        order by cl.seq)
        from credit_ledger cl where cl.client_id = p_client), '[]'::jsonb),

    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'at', pa.created_at, 'type', pa.type, 'status', pa.status,
        'amount_cents', pa.amount_pence, 'currency', pa.currency,
        'walk_id', pa.walk_id, 'receipt_url', pa.receipt_url,
        'refunded_cents', pa.refunded_amount_pence,
        'reversed_at', pa.reversed_at, 'reversal_reason', pa.reversal_reason,
        'credits_reversed', pa.credits_reversed,
        'credits_not_recovered', pa.credits_unrecovered,
        'settled_by_a_later_payment_at', pa.superseded_at)
        order by pa.created_at, pa.id)
        from payments pa where pa.client_id = p_client), '[]'::jsonb),

    -- The client's plan changes: which plan to which, when it was asked for
    -- and when it took effect. How Stripe was asked is bookkeeping.
    'plan_changes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'requested_at', pci.requested_at,
        'from_plan', (select pl.name from plans pl where pl.id = pci.old_plan_id),
        'to_plan', (select pl.name from plans pl where pl.id = pci.new_plan_id),
        'status', pci.status,
        'applied_at', pci.applied_at)
        order by pci.requested_at, pci.id)
        from plan_change_intents pci where pci.client_id = p_client), '[]'::jsonb),

    'invite_claims', coalesce((
      select jsonb_agg(jsonb_build_object(
        'at', ica.created_at, 'outcome', ica.outcome,
        -- `coalesce`: a claim-signup refusal records no account (0045), and
        -- "not this account" is false, not unknown.
        'by_this_account', coalesce(v_client.auth_user_id is not null
                                    and ica.attempted_by = v_client.auth_user_id, false))
        order by ica.created_at, ica.id)
        from invite_claim_attempts ica where ica.client_id = p_client), '[]'::jsonb),

    -- The walker's own notices about the client (0057's subject): "Jane is
    -- low on credits", "Jane booked a walk". Whether the walker read them
    -- describes the walker, so it is not here.
    'walker_notices', coalesce((
      select jsonb_agg(jsonb_build_object(
        'at', n.created_at, 'type', n.type, 'title', n.title,
        'body', n.body, 'walk_id', n.walk_id)
        order by n.created_at, n.id)
        from notifications n
       where n.subject_client_id = p_client
         and n.client_id is null
         and n.operator_id = v_client.operator_id), '[]'::jsonb),

    -- Every photo Storage holds in the client's folders (0058's reading), not
    -- only the ones a row points at: a pet's earlier photos, which replacing
    -- it never deleted, and a visit photo whose row was never written are
    -- still held, so the copy holds them too. The browser fetches each one;
    -- the rows above say which visit or pet it belongs to.
    -- Each with the size Storage recorded for it, so the browser can refuse,
    -- before fetching anything, an archive it could never finish. A size
    -- Storage did not record, or not as a whole number, is null.
    'stored_photos', coalesce((
      select jsonb_agg(jsonb_build_object(
               'bucket', po.bucket, 'path', po.name,
               'bytes', (select case when o.metadata ->> 'size' ~ '^[0-9]{1,15}$'
                                     then (o.metadata ->> 'size')::bigint end
                           from storage.objects o
                          where o.bucket_id = po.bucket and o.name = po.name
                          limit 1))
                       order by po.bucket, po.name)
        from fn_client_photo_objects(p_client) po), '[]'::jsonb),

    -- What Sanpo holds about the client that this copy leaves out, and why.
    -- smoke.sql's manifest decides every column of every table that holds a
    -- client's data; this list is those decisions in the client's words.
    'not_included', jsonb_build_array(
      'The entry codes themselves: they are encrypted, and only the vault can read them.',
      'Your walker''s IP address and device on the entry-code log, and whether your walker has read their notifications about you: those describe your walker, not you.',
      'The address typed on every claim of your account through your invite link, and on every attempt your invite refused, yours included. The file says when each was made, how it ended, and whether it came from your account.',
      'The time and network address Sanpo keeps for requests to create an account through your invite link, yours included, to limit how often the link can be tried. Your walker cannot read them; ask them to ask Sanpo.',
      'The messages Sanpo sent you, the record of when and why your email was turned off or back on, and the devices you turned notifications on for: your walker cannot see these, so a copy your walker makes cannot hold them. The file says only whether email to you is turned off, which is all your walker is shown. You can read your messages in your Sanpo account; for the rest, ask your walker to ask Sanpo.',
      'Keys that only work inside Sanpo or Stripe: the keys in your invite and unsubscribe links, your devices'' notification keys, and Stripe''s identifiers for you and your payments. A note on a credit entry is copied as it was written, and sometimes names the payment it came from.',
      'Bookkeeping: when each notification was delivered, when each row last changed, and how a plan change was carried out. The plans before and after each change, and every charge, are in the file.',
      'Your sign-in account (the address you sign in with, and when), and the copies Sanpo keeps of the payment messages Stripe sends it, which hold your name, email and billing address as Stripe has them. Your walker cannot read either; ask them to ask Sanpo.')
  );
end;
$$;

create function fn_export_client_routes(p_client uuid, p_walks uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from clients
                  where id = p_client and operator_id = (select auth.uid())) then
    raise exception 'fn_export_client_routes: no such client';
  end if;
  if exists (select 1 from clients where id = p_client and purged_at is not null) then
    raise exception 'fn_export_client_routes: this client has been erased';
  end if;
  if p_walks is null then
    raise exception 'fn_export_client_routes: no walks named';
  end if;
  if cardinality(p_walks) > 200 then
    raise exception 'fn_export_client_routes: at most 200 walks per call';
  end if;
  if exists (select 1 from unnest(p_walks) u(id)
              where not exists (select 1 from walks w
                                 where w.id = u.id and w.client_id = p_client)) then
    raise exception 'fn_export_client_routes: a walk that is not this client''s';
  end if;

  return coalesce((
    select jsonb_object_agg(w.id, coalesce((
             select jsonb_agg(jsonb_build_array(
                      g.recorded_at, round(g.lat::numeric, 6), round(g.lng::numeric, 6),
                      g.accuracy_m, g.gap_before)
                    order by g.recorded_at, g.id)
               from walk_gps_points g where g.walk_id = w.id), '[]'::jsonb))
      from walks w
     where w.id = any(p_walks) and w.client_id = p_client), '{}'::jsonb);
end;
$$;

revoke all on function fn_export_client_routes(uuid, uuid[]) from public, anon, authenticated;
grant execute on function fn_export_client_routes(uuid, uuid[]) to authenticated;

-- ── Refuse if it did not take ─────────────────────────────────────────────
do $$
begin
  if has_function_privilege('anon', 'fn_export_client_routes(uuid, uuid[])', 'execute')
     or has_function_privilege('anon', 'fn_export_client_data(uuid)', 'execute') then
    raise exception '0059: an anonymous caller can export a client — refusing';
  end if;
  if not has_function_privilege('authenticated', 'fn_export_client_routes(uuid, uuid[])', 'execute') then
    raise exception '0059: the walker cannot fetch the routes for a copy — refusing';
  end if;
end $$;
