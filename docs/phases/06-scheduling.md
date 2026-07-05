# Phase 06 — Scheduling

## Objective
Recurring schedules, calendar, and the walk materializer. Specs: 01 (recurring_schedules), 04 (materialize-walks).

## Deliverables
1. Migration `0006_scheduling.sql` — only if gaps surface vs spec 01 (new file; never edit applied migrations).
2. `supabase/functions/materialize-walks/` per spec 04: 14-day horizon, pause-window + paused-client + date-bound skips, `ON CONFLICT DO NOTHING` idempotency; `supabase/config.toml` cron `0 3 * * *` (03:00 UTC) + manual-run support.
3. Schedule management UI inside ClientDetail: create/edit recurring pattern (days-of-week picker, window, service type, pets, start/end), pause-window editor, deactivate.
4. `Calendar` screen — day + week views; walks rendered as WalkCards/chips; drag-to-reschedule updates `scheduled_date`/window (scheduled walks only); one-off walk creation from any slot; cancelled/no_show marking.
5. Deletion semantics: deactivating a schedule cancels its future materialized `scheduled` walks (keep past).

## Acceptance criteria
- Materializer run twice → row count unchanged (idempotent); walks appear only on `days_of_week`, none inside a pause window, none for a paused client. Prove via `docs/dev/scheduling-manual-test.md` + a `tests/materializer.sql` assertion script run through `/validate`.
- Drag-reschedule persists and survives reload; completed walks are not draggable.
- tsc + build + `deno check` clean; smoke.sql still passes (`supabase db reset` path with 0006).

## Out of scope
Client-side booking (phase 07), route optimization.
