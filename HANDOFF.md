# Sanpo — final Claude implementation handoff

## Objective

Ship the existing Sanpo product with the approved Indigo Emaki visual system.
This handoff closes the visual-migration roadmap. It is not authorization for
concept exploration, a different Today composition, new breeds, a horizontal
logo, decorative Japanese motifs, or scope beyond implementation defects.

## Read first

1. `CLAUDE.md` — architecture, commands, and non-negotiable security rules.
2. `docs/spec/05-design-system.md` — production tokens and component rules.
3. `docs/spec/07-indigo-emaki-visual-migration.md` — locked Today composition,
   responsive contract, BG-3A gate, and usability protocol.
4. `app/src/screens/Dashboard.tsx` and
   `app/src/components/TodayIllustratedSchedule.tsx` — production data binding
   and presentation.

## Locked source of truth

- Production route: `/`
- Deterministic QA route in development: `/dev/today`
- Today background:
  `app/src/assets/illustrations/sanpo-today-indigo-emaki-background-approved-v1.png`
- Brand masters: `app/src/assets/brand/`
- Utility icons: `app/src/assets/icons/`
- Asset-integrity gate: `app/scripts/verify-sanpo-assets.mjs`

The locked fixture reads:

- `9:00 / Juniper / Maple Walk / DONE`
- `11:30 / Mochi / Lakeside Loop · 18 min / END WALK`
- `2:00 / Luna / Oak Trail / UP NEXT`

No `Today's schedule` eyebrow, `Open walk` action, row portraits, stacked
illustrations, repeated schedule cards, map pins, badge wallpaper, or game HUD.

## Verification commands

Run from `app/`:

```bash
npm test -- --run
npm run lint
npm run build
PLAYWRIGHT_BROWSERS_PATH=/workspace/scratch/2ea4133a22a3/.playwright-browsers \
  npm run test:e2e -- e2e/indigo-emaki-today.spec.ts
```

Expected baseline at handoff:

- 19 unit-test files, 93 tests passing.
- Lint clean.
- Production build succeeds and verifies all locked brand assets.
- Indigo Emaki responsive suite passes at `375×812`, `430×884`, `768×1024`,
  and `1440×900` with no horizontal overflow and a `44 px` action target.

## Completion boundary

Implementation is complete when the packaged source reproduces the verified
render, all gates pass, and no retired PawTrail visual or customer-facing brand
language remains. Human five-second comprehension and outdoor-legibility
checks are launch validation; record their results without altering the locked
composition unless a measurable usability defect is demonstrated.

Do not push, merge, deploy, rotate secrets, or edit an applied migration
without explicit authorization from the repository owner.
