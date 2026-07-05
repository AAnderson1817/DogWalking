-- 0009 — notification wiring audit (phase 08, spec 02 triggers)
-- Emits walk_scheduled / walk_cancelled from the booking and cancel paths
-- of phases 06/07 regardless of surface (portal booking, calendar one-off,
-- REST): an AFTER trigger on walks covers every write path. Materialized
-- walks (schedule_id set) stay silent — the weekly pattern is expected.
-- walk_complete, low_credit (deduped), renewal_upcoming and payment_failed
-- already emit from complete-walk / fn_notify_low_credit / stripe-webhook.

create function fn_notify_walk_changes() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_user uuid;
  v_client_name text;
  v_slot text;
begin
  select auth_user_id, full_name into v_client_user, v_client_name
    from clients where id = new.client_id;
  v_slot := format('%s, %s–%s',
    to_char(new.scheduled_date, 'Dy DD Mon'),
    to_char(new.window_start, 'HH24:MI'),
    to_char(new.window_end, 'HH24:MI'));

  if tg_op = 'INSERT' then
    -- One-off bookings only; the nightly materializer is routine.
    if new.schedule_id is null and new.status = 'scheduled' then
      if auth.uid() is not null and auth.uid() = v_client_user then
        insert into notifications (operator_id, client_id, type, title, body, walk_id)
        values (new.operator_id, null, 'walk_scheduled',
                format('%s booked a walk', v_client_name), v_slot, new.id);
      else
        insert into notifications (operator_id, client_id, type, title, body, walk_id)
        values (new.operator_id, new.client_id, 'walk_scheduled',
                'New walk scheduled', v_slot, new.id);
      end if;
    end if;
    return new;
  end if;

  if old.status <> 'cancelled' and new.status = 'cancelled' then
    if auth.uid() is not null and auth.uid() = v_client_user then
      insert into notifications (operator_id, client_id, type, title, body, walk_id)
      values (new.operator_id, null, 'walk_cancelled',
              format('%s cancelled a walk', v_client_name), v_slot, new.id);
    else
      insert into notifications (operator_id, client_id, type, title, body, walk_id)
      values (new.operator_id, new.client_id, 'walk_cancelled',
              'Your walk was cancelled', format('%s — get in touch if this is unexpected.', v_slot), new.id);
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_walks_notify
  after insert or update on walks
  for each row execute function fn_notify_walk_changes();

revoke all on function fn_notify_walk_changes() from public, anon, authenticated;

-- Email delivery (spec/phase 08 deliverable 3) rides on a database webhook:
-- in hosted Supabase, add a webhook on INSERT into notifications invoking
-- the send-notification edge function with the service key. Local stacks
-- without pg_net skip this — the function itself is env-gated on
-- RESEND_API_KEY and silently no-ops without it.
