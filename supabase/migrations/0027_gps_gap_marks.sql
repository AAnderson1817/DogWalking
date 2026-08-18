-- 0027 — record where GPS recording stopped, so the trail is not drawn
--        straight across it (review H7)
--
-- `watchPosition` stops delivering fixes when the phone screen locks or the
-- page is backgrounded, and it does so silently: no error event, so nothing in
-- the product ever knew. The next fix was appended to the trail as if it were
-- the next step of the walk, so the route drew a straight line across the
-- suspended interval and `distance_m` measured it.
--
-- That number is the client-facing proof of service printed on the report
-- card. A walk where the operator pocketed the phone for twenty minutes could
-- report a longer distance than one where they held it the whole time.
--
-- The flag cannot be derived after the fact from `recorded_at`. Points are
-- emitted under a ≥5 s AND ≥10 m throttle, so an operator waiting at a
-- crossing legitimately produces no point for minutes; a time-gap rule applied
-- to stored rows would call that a suspension and delete real walking. The
-- client detects it on RAW fixes (which arrive ~1/s regardless of movement)
-- and carries the answer here.
--
-- Additive and defaulted, so every existing row keeps its current meaning:
-- false is "no gap", which is exactly what an unmarked historical row asserts.
-- Nothing is backfilled — the information to do it was never captured, and a
-- guessed gap is indistinguishable from an observed one.

alter table walk_gps_points
  add column if not exists gap_before boolean not null default false;

comment on column walk_gps_points.gap_before is
  'True when GPS recording had stopped before this fix (screen lock, app '
  'backgrounded). The segment from the previous point is not a walked route: '
  'renderers break the line here and pathDistanceM skips the segment.';

-- No RLS change. The column sits on a table whose policies already scope every
-- read and write by operator_id (0004) and whose tenant consistency is
-- enforced by trigger (0014); adding a column does not widen either. The
-- existing column grants are table-level, so `authenticated` can write it —
-- which is correct, since the operator's own device is the only thing that can
-- observe a gap.
