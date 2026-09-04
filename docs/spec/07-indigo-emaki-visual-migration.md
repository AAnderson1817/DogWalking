# 07 — Indigo Emaki visual migration handoff

## Status and scope

The visual information architecture is approved and closed. This is an
implementation and verification specification, not a design exploration.
Sanpo replaces PawTrail throughout the production shell. The Today screen is
the locked reference for how Indigo Emaki combines illustrated context with an
efficient interface.

## Locked Today reference

The owner has separately authorized a compact layout review at
`/dev/today?layout=compact`. That development-only candidate deliberately
uses an 88px crop of the existing artwork, fixed readable type sizes in rem,
and a full-width current-walk control. It does not replace this specification
or change the production `/` route. See
[`../review/compact-today/README.md`](../review/compact-today/README.md) for
scope, measured comparison and the remaining decision.

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
| `320–767 px` | Fixed bottom bar | Full-bleed field up to `640 px`; no horizontal scroll; `END WALK` at least `44 px` high; all four labels visible. Scrolls vertically — that is what a phone is for. |
| `768–1023 px` | Fixed bottom bar | Field width is bounded by the height available, `clamp(420px, (100dvh − nav) × 875/1798, 640px)`, and centres. |
| `1024 px+` | Left rail | Same bound with no nav reserve, since the rail takes no vertical space. Centres in the area to the right of the `88 px` rail; no widening or horizontal lockup. |

**Above `768 px`, horizontal slack is spent on vertical fit.** The plate's ratio
means a `640 px` field is `1315 px` tall — taller than a laptop viewport before
the schedule begins. That is why Today broke at both viewports this document
names for testing: at `1440×900` the current visit straddled the fold, `END
WALK` was cut in half and the next visit was entirely off-screen; at
`768×1024` the last row ran under the bottom bar (review H27).

Narrowing the field is the correct lever because **every dimension in this
composition is `cqw` against the field**, so the whole thing scales
proportionally. The approved composition is preserved exactly, at a smaller
size — nothing reflows and no breakpoint re-lays it out. Below `768 px` there
is no slack to spend and the phone is untouched.

The `420 px` floor is where proportionality stops holding: the type `clamp()`
floors engage around there (`h1` at `28px / 6.15cqw = 455px`), so below it the
text no longer shrinks with the artwork. Where the floor binds, the component
scrolls again. A short viewport genuinely cannot hold this composition, and
shrinking past the floor would trade a visible defect for a subtler one.

The component may scroll vertically on a viewport shorter than its preserved
field ratio. It must never crop or independently stretch the illustrated scene.

At widths beyond the field, the page's Cream shows either side of the plate's
warmer paper. That is a mount, and it is deliberate: the plate is a painting
with a fixed ratio, and a mount is what a painting gets when the wall is wider
than the frame.

### The plate is served in four sizes (review M17)

One `875 x 1798` WebP went to every device. The field is never wider than
`640` CSS px, so a DPR-1 laptop painting a `438px` field was downloading `875`
pixels of width to show `438` — and at `1440x900`, the desktop viewport this
document names for testing, that is the common case rather than an edge one.

The plate now ships as four candidates behind one `<img srcset>`. The widths
are MEASURED field widths rather than a generic `1x/2x` ladder, so each is the
exact size some real device asks for:

| Width | Why it exists | Bytes |
| --- | --- | --- |
| `438w` | the field at `1440x900` — `900 x 875/1798 = 438.0` | 90 KiB |
| `640w` | the field's maximum: `--page-max` caps there | 179 KiB |
| `750w` | `375` CSS px at DPR 2, the commonest DPR-2 phone | 218 KiB |
| `875w` | the master — every DPR-3 device, and every need above 750 | 437 KiB |

`sizes` restates `--page-max`, because it is resolved before layout and cannot
ask the element how wide it will be. `clamp()`, `calc()`, `min()` and `dvh` are
all legal there and Chromium honours them — verified against the real page,
where every candidate picked matched the width actually rendered.
`scripts/today-plate.test.ts` reads both expressions out of `components.css`
and fails when they drift; that guard is the only thing making the duplication
safe. `e2e/today-plate-srcset.spec.ts` then checks the browser's actual pick
against the width it actually painted, across seven viewports and three device
pixel ratios.

**The upscale half of M17 is NOT fixed, and cannot be from inside this
repository.** The review also asked for a 2x master; `875 x 1798` is every
pixel that exists, in the tree or in its history.
`docs/reference/sanpo-today-locked-composition.png` is the same dimensions and
looks like a master, but is the composition mockup — artwork *plus* UI,
measured `18.57 dB` PSNR against the plate — and its own README says it must
not be embedded. The lossless PNG master of the plate itself does exist in
history, at the same `875 x 1798`. So a DPR-3 phone still upscales exactly as much as it did before.
A 2x master is new artwork, which is an owner decision and a locked-composition
change, not a code change.

What the downscales do NOT do is change what anyone sees. Measured at the
display widths each candidate serves, a variant differs from the master by
`33.2-38.9 dB` PSNR — the same neighbourhood as the `38.8 dB` the original
PNG-to-WebP re-encode shipped at. And `e2e/today-contrast.spec.ts`, which
samples the rendered pixels, moved every ratio it measures UPWARD by
`0.02-0.09` with none crossing a floor: a high-quality downscale averages out
the artwork's darkest speckles, so the backdrop under the schedule gets
slightly more uniform.

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
