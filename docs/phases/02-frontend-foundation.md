# Phase 02 — Frontend foundation

## Objective
PWA scaffold with the Trailhead design system and the full lib layer. Specs: 05, 06.

## Deliverables
1. `app/` hardened: TS strict config, path alias `@/ → src/`, router shell with `RequireRole`, error boundary, 404.
2. `app/src/styles/tokens.css` + `global.css` (reset, base type, `.walkmode`, `.pulse-live`, reduced-motion guard) — token values verbatim from spec 05.
3. Fonts: Inter + Space Grotesk self-hosted (`app/public/fonts`, `@font-face`, `font-display: swap`).
4. `lib/`: `env.ts`, `supabase.ts`, `types.ts` (generated from local DB), `api.ts` (typed wrappers for every phase-00 entity + edge invocations, stubbed where screens don't exist yet), `credits.ts`, `format.ts`, `auth-context.tsx` — contracts per spec 06.
5. Placeholder routed screens (styled empty states) for every route in spec 06, so the shell navigates end-to-end.
6. `manifest.webmanifest` + icons (generated pine-palette placeholder marks); full service worker deferred to phase 08.

## Acceptance criteria
- `npx tsc --noEmit -p app` clean; `npm --prefix app run build` succeeds.
- `format.ts` unit checks (Vitest): `gbp(12345) === '£123.45'`; London rendering of a known UTC timestamp across GMT/BST dates; `distanceKm`.
- Dev server: unauthenticated hit on `/` redirects to `/signin`; tokens visibly applied (paper bg, pine buttons).

## Out of scope
Real screen logic, components beyond primitives needed by the shell, auth flows.
