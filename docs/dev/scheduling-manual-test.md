# Scheduling — manual walkthrough (phase 06)

Prereqs: stack + seed, dev server, operator signed in. The SQL-level
materializer proof runs automatically via `/validate`
(`supabase/tests/materializer.sql` — idempotency, weekday filter, pause
windows, paused clients, date bounds, pet copying, no resurrection of
cancelled walks).

## 1. Schedule management (ClientDetail → Schedule)
1. Create a schedule: Mon/Wed/Fri 12:00–13:00, default service, both pets,
   starts today. Save.
2. Edit it: add Saturday, set a pause window next week. Save and confirm
   the card shows the pause range.
3. The seed client already has a Mon/Wed/Fri schedule — both render.

## 2. Materializer
1. Calendar → "Run materializer" → notice reports N created; walk chips
   appear only on the schedule's weekdays over the next 14 days, none
   inside the pause window.
2. Run it again immediately → "created 0" (idempotent).
3. Pause the client's subscription (`update clients set
   subscription_status='paused' …`), run again → no NEW walks for them;
   unpause and re-run.

## 3. Calendar interactions
1. Week view: drag a scheduled chip to another day → it persists (reload
   the page; the walk sits on the new date). The unique index guarantees a
   drop onto a day that already has that schedule's walk fails cleanly —
   the chip snaps back (error surfaced, no duplicate).
2. Completed walks are not draggable; cancelled chips render struck-through.
3. Tap a chip → action sheet: reschedule via date/time inputs; Cancel walk
   → chip goes struck-through; No-show likewise.
4. Day view: "+ Add one-off walk" → pick client/property/service/pets/
   window → appears immediately; complete it later through Walk Mode and
   the credit debit still applies (one-off walks have no schedule_id).

## 4. Deactivation semantics
1. ClientDetail → Schedule → open the schedule → "Deactivate".
2. Future `scheduled` walks from that schedule flip to cancelled; past and
   completed walks remain untouched (verify in Calendar/history).
3. Run the materializer → nothing regenerates (schedule inactive).

All flows with zero console errors; `npx tsc --noEmit -p app`, build,
`deno check`, smoke.sql and materializer.sql all green via /validate.
