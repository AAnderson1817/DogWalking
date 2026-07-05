# Phase 03 — Component kit & hooks

## Objective
The full shared component inventory (spec 05) and the two core hooks (spec 06).

## Deliverables
1. Primitives: `Button`, `Card`, `Input`, `Textarea`, `Select`, `Badge`, `Sheet`, `Spinner`, `EmptyState` — variants/status colors per spec 05.
2. Composites: `CreditMeter`, `WalkCard`, `MapView` (Mapbox GL + SVG polyline fallback behind one prop contract), `LiveWalkBanner`, `ReportCard`, `BottomNav` (persona-aware tab sets).
3. Hooks: `useGeolocation` (5 s / 10 m throttle), `useWalkChannel` (broadcast + subscribe modes, 10-point/60 s batch flush).
4. `/dev/kit` route (dev-build only): gallery rendering every component in every state with fixture data — including MapView fallback (unset token) and CreditMeter below threshold (amber).

## Acceptance criteria
- tsc + build clean.
- Vitest: `useGeolocation` throttle logic (mocked geolocation — emits at 4 s/8 m suppressed, 6 s/12 m passes); `useWalkChannel` batching (mocked client — 10th point triggers flush, `end()` flushes remainder); MapView renders SVG path from fixture points without a token.
- `/dev/kit` renders without console errors; excluded from production bundle (verify via build output).

## Out of scope
Screen assembly, live data.
