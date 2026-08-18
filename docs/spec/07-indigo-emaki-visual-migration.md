# 07 — Indigo Emaki visual migration handoff

## Status and scope

The visual information architecture is approved and closed. This is an
implementation and verification specification, not a design exploration.
Sanpo replaces PawTrail throughout the production shell. The Today screen is
the locked reference for how Indigo Emaki combines illustrated context with an
efficient interface.

## Locked Today reference

- Art: one continuous Old Town Chicago field with a woman and Golden Retriever,
  Cream transition, restrained botanical corners, and no separate portraits.
- Header: date at upper left; approved Inbox icon at upper right with a static
  Kaki unread dot.
- Information order: `Today`; completed/total summary and distance; one emaki
  progress path; operational status; three chronological ruled rows.
- Fixture order: `9:00 Juniper / Maple Walk / DONE`, `11:30 Mochi / Lakeside
  Loop · 18 min / END WALK`, `2:00 Luna / Oak Trail / UP NEXT`.
- State color: Matcha complete, Yamabuki current path/nav marker, Asagi
  upcoming, Kaki current marker, Indigo text/action, Cream canvas — with the
  two on-artwork deepenings below, which are a contrast requirement rather than
  a palette change.
- On-artwork state colors: the schedule sits on a painting, not on Cream, so
  the two status colors that touch it are deepened toward the palette and
  defined once each on `.today-emaki`. `--emaki-current` (Yamabuki 35% /
  Kaki-strong) replaces plain Yamabuki for "underway", measured 3.48–3.51:1
  against a 3:1 floor; plain Yamabuki is 1.92:1 and the previous 55% mix was
  2.70:1. `--emaki-complete` (Matcha 80% / Indigo) replaces plain Matcha for
  the travelled stroke, the DONE bar and the words "On time" and "DONE",
  measured 4.72–4.76:1 against the 4.5:1 floor the text needs; plain Matcha is
  4.15:1. Both numbers are sampled from the rendered artwork by
  `e2e/today-contrast.spec.ts` — see spec 05, *Contrast over artwork*. The
  untravelled track stays light at 1.13:1 and is exempt as a container rather
  than a state signal; the sampler still prints it every run.
- Navigation: Today, Calendar, Clients, Money with approved icons and visible
  labels. The active marker is Yamabuki.
- Exclusions: no `Today's schedule` eyebrow, no `Open walk`, no row portraits,
  no stacked scenes, cards, badges, map pins, loose dogs, decorative motion,
  or game HUD.

## Responsive contract

The environmental field preserves its `875 / 1798` ratio through the `640 px`
working-width cap. Live UI uses container-relative placement so it stays
registered to the artwork.

| Width | Navigation | Required behavior |
| --- | --- | --- |
| `320–639 px` | Fixed bottom bar | Full-bleed field; no horizontal scroll; `END WALK` at least `44 px` high; all four labels visible. |
| `640–1023 px` | Fixed bottom bar | Field caps at `640 px`; artwork remains native-size backed; schedule alignment is unchanged. |
| `1024 px+` | Left rail | Field remains `640 px` and centers in the space to the right of the `88 px` rail; no widening or horizontal lockup. |

The component may scroll vertically on a viewport shorter than its preserved
field ratio. It must never crop or independently stretch the illustrated scene.

### The field is not the plate

The illustrated plate and the field that contains it are two different boxes,
and conflating them is what made the schedule lose visits.

- **The plate** is the approved `875 x 1798` artwork. It is pinned to the top
  of the field at its intrinsic ratio, full working width, with no
  `object-fit`. There is no mechanism by which it can be cropped or stretched —
  the guarantee is structural, not a bounded media query.
- **The field** is at least as tall as the plate and at least as tall as the
  viewport, and grows with the schedule. Where it exceeds the plate, the
  plate's own paper (`--emaki-paper`, sampled from the master's bottom edge)
  continues beneath it, so the illustration reads as fading into the page
  rather than stopping at a seam.

A day with more visits than the plate has room for therefore scrolls, and the
lower part of the schedule sits on bare paper below the scene. That is the
intended behaviour, not a degradation: the target customer runs six to ten
visits a day, and the alternative — which shipped — was that the afternoon
disappeared with no scrollbar and no cue.

The schedule keeps its `86cqw` registration to the artwork, so on an ordinary
day the composition is unchanged.

**Never reintroduce `overflow: hidden` on the field, and never give it a fixed
`aspect-ratio`.** Both cap the schedule at the plate's height. `aspect-ratio`
looks like it should act as a floor and does not — measured, it caps.

### Nav clearance

The nav clearance belongs to whichever section is last on the page, so the
strip behind the transparent bar is always the same colour as the content above
it. The operator nav's scrim resolves toward that surface too: Cream on every
other screen, `--emaki-paper` on Today.

## BG-3A verification gate

1. Five-second comprehension: a tester can identify the current walk and next
   visit after five seconds of viewing the populated screen.
2. One primary action: only `END WALK` has dominant Indigo treatment.
3. One continuous day: the tester perceives one scene and one chronological
   schedule, not separate cards or stacked illustrations.
4. Exact operational detail: the tester can recall current pet, next pet,
   current route, elapsed time, and next-visit state.
5. Outdoor legibility: all operational text remains readable at normal phone
   brightness in daylight; artwork never sits directly behind the schedule.
6. Truthful state mapping: completed/current/upcoming color and labels agree
   with the source walk statuses.
7. Repeatable production: background artwork is one approved asset; all dates,
   names, routes, timing, distances, and actions are data-driven DOM content.

## Test procedure

- Run `npm test -- --run` and `npm run test:e2e -- e2e/indigo-emaki-today.spec.ts`.
- Check `375 x 812`, `430 x 884`, `768 x 1024`, and `1440 x 900`.
- Perform the five-second comprehension and immediate recall tasks with at
  least five target users. Record success without coaching. The acceptance
  threshold is `4/5` users correct for both current walk and next visit.
- Repeat the mobile task outdoors. Any tester who must zoom or shade the screen
  is a legibility failure.
- Do not reopen the composition while addressing implementation defects.
  Changes are limited to fidelity, responsive behavior, accessibility, and
  data binding.
