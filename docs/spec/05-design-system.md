# 05 — Sanpo Indigo Emaki design system

Indigo Emaki is Sanpo's production product language. It combines a quiet,
editorial utility layer with a restrained illustrated layer where place,
weather, season, or progress materially improves comprehension. It replaces
the PawTrail/Biscuit neo-brutalist presentation. There are no brown-ink hard
shadows, orange primary actions, Baloo typography, decorative pet portraits,
generic KPI-card grids, or game-style HUD elements.

## Production foundations

- Primary colors come from `sanpo-product-color-tokens-r1.css`: Indigo and
  Cream establish the identity; Matcha means complete/success; Kaki means
  current/attention; Asagi means information/upcoming; Yamabuki marks positive
  milestones and the active navigation path; Fuji is relational.
- Nunito is the sole interface type family. Numerals retain tabular settings
  where alignment matters.
- Structure uses whitespace and fine rules. Cards enclose real objects only;
  they use a quiet `1.5 px` boundary, modest radius, and no hard shadow.
- Primary actions are Indigo with Cream text. One action dominates a surface.
- Illustration is functional environmental context, never wallpaper. Schedule
  text, route state, safety information, and actions remain live HTML.
- Layout is mobile-first and caps working surfaces at `640 px`. Primary
  navigation is fixed at the bottom on touch layouts and becomes a left rail
  at `1024 px`. **Both personas render the same component and the same
  treatment; only the destination list differs** (review M18).
- **The `640 px` cap is a reading measure, and one surface is permitted to
  leave it** (review M20). `.page--wide` raises `--page-max` to
  `min(1120px, 100% - 88px)` at `1024 px` and above, and the Calendar **week
  view** is its only production user. The reason is specific: a reading measure
  is right for prose, a form and a list of rows, and wrong for a grid whose
  columns *are* the information. Measured, the week's seven days were `86.84 px`
  each at both `768x1024` and `1440x900` — widening the browser gained the grid
  exactly zero pixels, because the constraint was the cap and not the viewport,
  leaving a 67px text box per day.
  The `100% - 88px` term is not decoration: with a bare `1120px`, a `1024px`
  viewport resolves `max-width` to the full `1024` while the rail centring still
  subtracts the rail, and the document overflows by exactly `88px` — measured.
  Day view keeps `640 px` deliberately; stretching `.walk-card` to `1120`
  produces a `780px` route line, a worse reading measure than the one it
  replaces. Any further `.page--wide` user needs a sentence here first.
- Approved UI icons are the unchanged masters in `app/src/assets/icons`.
  Product state changes color, adjacent language, or placement—not geometry.

Compatibility aliases remain in `tokens.css` so unconverted selectors inherit
the production colors and quiet structure. They do not authorize the retired
PawTrail appearance.

## Sanpo production navigation override

The following approved production rules supersede the older PawTrail/Biscuit
navigation examples **for both personas** without otherwise redesigning the
component kit. There is one navigation treatment: a rule that applies to one
persona and not the other requires a stated reason here, and none currently
does. `data-navigation-persona` survives in the DOM as a test hook and is not
a styling hook — `route-reachability.test.ts` fails any stylesheet that selects
on it.

- Authoritative primary destinations: `Today / Calendar / Clients / Money`.
- Route mapping: `/`, `/calendar`, `/roster`, `/billing`.
- Client portal destinations: `Home / Book / Walks / Billing`, mapping to
  `/portal`, `/portal/book`, `/portal/walks`, `/portal/billing`. These had
  never been written down. Pet profiles are a secondary self-service utility
  reached from Home at `/portal/pets` — like Inbox, Access Vault and Settings
  on the operator side, not a bottom-navigation destination.
- Inbox remains a visible secondary utility and is not a bottom-navigation
  destination.
- Access Vault remains a secondary client-management utility.
- Use the byte-approved Day, Calendar, Clients, Payments, Inbox, and Route SVG
  masters from `app/src/assets/icons`.
- Utility masters remain on a `24 x 24` grid with `1.75 px` principal strokes,
  round caps/joins, `currentColor`, a `20 px` minimum, and a `24 px` default.
- Never alter icon geometry for selected, unread, complete, warning, focus, or
  disabled state.
- Primary navigation always retains visible text labels.
- Navigation uses CT-1 roles in **both** personas: Indigo active, Yamabuki
  active marker, Muted-toward-Indigo inactive, Cream canvas, and Asagi focus.
  The active state is carried by the Indigo label, weight 900, `aria-current`
  and the Yamabuki marker together; the marker is the fourth of four and is
  measured but exempt from the 3:1 non-text floor for that reason.
- CT-1 defines `--sanpo-color-navigation-active-marker` as
  `--sanpo-color-status-current`, which is **Kaki** — and it has no consumer
  anywhere in the app. The marker is Yamabuki, per the rule above, so the
  semantically-named token and this spec disagree and anyone who reaches for
  the obvious name silently gets the wrong colour. The rule is pinned by a
  test rather than left to be rediscovered.
- The client's navigation focus ring was drawn **outside the viewport** until
  M18: the operator rule carried `outline-offset: -3px` and the client fell
  through to the global `+3px` on an element at `bottom: 0`. Measured at
  390x800 — ring outer edge at y=806 against an 800px viewport. One treatment
  removes the class of defect, not just this instance.
- The Today field runs under the bar, which is transparent by
  design, so its labels sit on painted artwork rather than flat Cream. Two
  things keep them legible and must stay together: a gradient scrim on the
  bar, and an inactive label deepened 30% toward Indigo. Plain Muted is only
  4.73:1 even on pure Cream and measured under the 4.5:1 floor over the
  artwork; deepened it holds 4.79:1 at worst, 5.66:1 median, while active
  Indigo reads 8.79:1. Active/inactive separation is carried by weight 900
  and the Yamabuki marker, not by colour alone.
  The same transparent bar and gradient scrim render in the client portal,
  where the surface beneath is flat Cream rather than artwork; the scrim
  resolves toward Cream there and toward `--emaki-paper` on Today. That
  resolution is keyed on the illustrated page, not on the persona — which is
  why the treatment needs no persona fork at all.
- `npm run verify:brand-assets` guards the approved asset hashes and runs
  automatically before production builds.

## Sanpo interactive control override

These production rules supersede the older orange, butter, chunky-border, and
hard-shadow control examples above:

- Primary actions use Indigo with Cream text. Hover and pressed states use the
  approved darker Indigo interaction value. There is one visually dominant
  primary action per surface.
- The legacy `accent` button API remains temporarily compatible but renders as
  the same Indigo primary treatment; it does not introduce a second action
  color.
- Secondary buttons use a Cream field, Indigo text, and an Indigo boundary.
  Destructive buttons use Kaki Strong with Cream text and explicit consequence
  language.
- Buttons use quiet `1.5 px` boundaries, no hard offset shadow, a `44 px`
  minimum target, and visible text. Disabled controls use the approved muted
  boundary/text treatment and retain an explicit unavailable label.
- Text links and link-like actions use Asagi with an underline. Structural
  card links may inherit their surrounding text color but retain a visible
  focus ring.
- Inputs, textareas, and selects use White fields, Indigo text, Muted
  placeholders, and a subtle rule. Invalid fields use a Kaki boundary plus a
  programmatically associated visible error message.
- Keyboard focus is a `3 px` Asagi ring with separation from the control. It
  remains visible on buttons, links, native inputs, tabs, icon actions, and
  custom interactive rows.
- Checkboxes and radio controls use Indigo; native file controls receive the
  same secondary-button treatment. Meaning never depends on color or motion.

## Sanpo semantic status override

The following CT-1 mappings supersede the legacy Biscuit badge colors:

- `scheduled`: Asagi information tint and upcoming border.
- `in_progress`: Kaki attention tint and border.
- `completed`: Matcha success tint and border.
- `overage` and `attention`: Kaki attention tint and border.
- `cancelled` and `no_show`: Cream canvas, Muted text, and subtle border.
- `critical`: Kaki Strong field with inverse text.

Domain states use the same treatment consistently:

- Clients: invited=Asagi, active=Matcha, paused/archived=Muted.
- Subscriptions: active=Matcha, paused/cancelled=Muted, past due=Kaki,
  and no subscription=neutral.
- Payments: processing=Asagi, collected=Matcha, needs attention=Kaki, and
  refunded=Muted.
- Low credit balance and GPS errors use Kaki attention.
- Live/current walk markers use Kaki; routes and distance information use
  Asagi.
- Unread messages use a visible `Unread` label on a Kaki tint; Indigo text
  preserves normal-text contrast.

Calendar entries retain visible time and pet/client text. Non-scheduled entries
also show a visible state label; scheduled entries use their appointment time
as the non-color state cue.

All statuses retain visible text or an equivalent accessible name, so color is
never the sole cue. Indigo is used on supporting tints to preserve text
contrast; the supporting base color appears as the border. Yamabuki is not an
attention color and remains reserved for revenue and positive milestones.

## Sanpo schedule and walk-state component override

The Today's Schedule composition is locked and promoted to production:

- The operational sequence is explicit: `CURRENT`, `UP NEXT`, and `✓ DONE`.
  Cancelled, no-show, overage, and offline states retain equally explicit text.
- A live walk appears once in the chronological field with pet, route, elapsed
  time, and the explicit `END WALK` action. It is never repeated in a banner,
  card, decorative portrait, or game-style HUD.
- Schedule entries are quiet divider rows rather than rounded-card stacks.
  Every row states the time window, pet name, route/property, and scheduled
  duration. Rows are links to the client record — where the door codes, pets
  and property notes are — with complete accessible labels of the form
  `pet, time, route, state`, since the state is carried visually by colour and
  a name read out of context must not depend on it. Only the time and identity
  are inside the link: a current row also carries `END WALK`, and nesting one
  interactive element in another is invalid and unreachable by keyboard.
- An empty day offers a way to fill it. "No visits scheduled today" alone is
  the one state that most needs an action next to it.
- Generic pet avatars, unattended dog markers, map pins, enclosing circles,
  and badge stacks are excluded from schedule rows. The approved Route icon is
  used unchanged at `20 px` or larger with adjacent visible route text.
- Current rows use a Kaki edge and tint; upcoming uses Asagi; complete uses
  Matcha; cancelled/no-show uses Muted. Text remains Indigo on supporting tints
  so the state never depends on color.
- Week-calendar days use rules and alignment instead of seven repeated cards.
  Walk controls keep a `44 px` minimum target and explicit state text.
- Route views use an Asagi path, Indigo start, Kaki live endpoint, and Matcha
  completed endpoint. Maps have a quiet boundary and no hard offset shadow.
- The accepted greeting hierarchy is personalized (`Good morning, Maya.`) with
  smaller factual schedule copy. No Field Note or general weather pill is
  introduced; appointment weather remains quiet unless genuinely hazardous.

## Sanpo Money and payment-state component override

These rules govern the operator Money screen and the payment activity shown in
client Billing:

- `Money` is the operator screen and navigation title. `Payments` names the
  activity section. A settled payment is `Collected`, never `Paid`.
- The top-level summary is a Cream value rail, not a KPI-card grid or chart
  dashboard. It shows `Collected`, `Processing`, and `Needs attention` in that
  order, with aligned monetary values and tabular numerals.
- Collected uses Matcha, Processing uses Yamabuki, Needs attention uses Kaki,
  and Refunded uses Muted. Every state also has a distinct mark and visible
  label; color is always secondary information. Processing retains an Indigo
  boundary so the Yamabuki field remains visually legible on Cream.
- Payment activity is an open, ruled ledger. Each row keeps pet or payment
  type, service, client when applicable, date, state, and amount in logical
  reading order. Amounts remain prominent and aligned.
- Rows have a minimum height of `82 px` on mobile and `88 px` at `720 px` and
  wider. They do not use repeated enclosing cards or hard shadows.
- On touch layouts, a left swipe reveals an Indigo receipt action. Keyboard
  focus reveals the same action in DOM reading order. At `720 px` and wider,
  the receipt action is persistently visible.
- Filtering uses the existing accessible bottom sheet. Failed overage recovery
  stays adjacent to its transaction, uses explicit Kaki treatment, and never
  moves focus automatically.
- Money surfaces use no count-up, coin, confetti, shimmer, or pulse animation.
  Fees and net proceeds must not be invented; they appear only after an
  authoritative data source exists.

## Sanpo Inbox and client-relationship component override

These rules govern correspondence, notification rows, and the relationship
entry points on Clients:

- Inbox is an open correspondence field, not a stack of cards. Its hierarchy
  is `Inbox / unread count / New message`, `Search conversations`, conversation
  index, selected thread, message history, and composer.
- The approved production primary navigation remains
  `Today / Calendar / Clients / Money`; Inbox stays a visible secondary
  utility. This increment does not replace Calendar in primary navigation.
- Conversation rows lead with pet name, followed by owner, preview, and time.
  Pet portraits are not required and are never repeated decoratively.
- At `0–719 px`, index and thread are separate views. At `720–1023 px`, both
  appear as a two-pane field. At `1024 px` and wider, the approved `88 px`
  navigation rail is followed by a `400 px` conversation index and a flexible
  thread. The readable message measure remains between `420–620 px` where the
  viewport permits.
- Search controls are `48 px` high. Conversation rows are at least `98 px` on
  mobile and `104 px` on desktop. Actions remain at least `44 x 44 px`; the
  thread header is at least `84 px`, and the composer is at least `72 px`.
- Fuji tint and a Fuji leading rule identify relationship context and the
  selected thread. Kaki identifies immediate unread priority through a static
  dot, leading rule or field, bold preview, and visible `Unread` label.
- Incoming client messages use Fuji tint. Provider messages use Asagi tint.
  Indigo is the text color on every supporting tint so normal text preserves
  contrast; tints are surfaces, never text colors.
- Exact correspondence controls are `New message`, `View client`,
  `Write a message`, and `Send`. Search has the programmatic and visible label
  `Search conversations`.
- System notifications remain separate from correspondence and use the same
  open ruled-row discipline. Notification records must never be synthesized
  into fake client messages. `InboxField` receives conversation data and
  callbacks; `/dev/inbox` is the responsive visual reference and is excluded
  from production builds.
- Repeated avatars, card wallpaper, decorative motion, independently animated
  unread bubbles, and icon redraws for state are prohibited. Selected and
  unread states retain visible text and accessible names, so color is never the
  only cue.

## Sanpo empty, loading, offline, and error-state override

The shared state field governs full-page, section, sheet, and Walk Mode states:

- States are open ruled fields with an explicit label, title, supporting text,
  and recovery action when recovery is available. They do not use pop-shadow
  cards, modal dead ends, or decorative illustrations.
- Neutral empty states use Cream and a Muted rule. Loading and recoverable
  offline context use Asagi tint and rule. Actionable failure uses Kaki tint and
  rule. Confirmed completion uses Matcha tint and rule. Indigo is the text color
  on every supporting tint.
- Empty copy names what is absent and, where useful, the next available action.
  Empty fields are announced as status updates when they replace loaded
  content.
- Page and section loading states always include visible, contextual language
  such as `Loading clients` or `Loading today's schedule`; a spinner alone is
  not a page state. Compact spinners remain valid inside already-labelled
  action buttons.
- Loading motion is functional only. `prefers-reduced-motion: reduce` collapses
  it to one effectively static frame. Shimmer, skeleton travel, bouncing marks,
  and live-state pulse are prohibited for loading.
- Retryable failures retain an explicit `Retry` action, an `alert` role, and do
  not steal focus. A global render failure uses the same Kaki field and hides
  raw exception details from the user.
- Walk Mode offline state must say that route points are saved on the device
  and will sync when the connection returns. It uses an Asagi information field
  and never suggests that the active route has been lost. A GPS permission or
  recording failure is a separate Kaki state.
- Full fields are at least `116 px` on wider layouts; compact fields are at
  least `72 px`; loading fields are at least `96 px`; every recovery action
  remains at least `44 px`. At narrow widths, copy precedes a full-width action.
- State-specific illustration remains outside this increment and may only be
  added in the approved illustration-rich screen step. The state system itself
  remains efficient, textual, and operational.

## Approved Sanpo Today composition

**Parallel review candidate:** the owner has reopened the artwork allocation
question. `/dev/today?layout=compact` now evaluates an 88px decorative header
and an open Cream schedule using the same component and fixture as `/dev/today`.
It is a DEV-only experiment; the production rules below still govern `/`.
The candidate's explicit crop, type, action and validation boundaries are in
[`../review/compact-today/README.md`](../review/compact-today/README.md).
An accepted prototype requires a separate promotion decision and specification
update; the existence of this comparison is not production approval.

The Old Town Current Moment / Daylight Arc hybrid is the locked production
Today screen. It is implemented on `/`; `/dev/today` is its deterministic QA
fixture, not a separate candidate or approval surface.

- One Old Town environmental field establishes the day. There are no stacked
  scenes, loose dogs, map pins, enclosing circles, card wallpaper, badges, or
  game HUD.
- One continuous emaki-style progress stroke carries completed, current, and
  upcoming progression. Visible schedule text remains the primary source of
  truth.
- The schedule remains one chronological field with exact time, pet, route,
  duration, and sequence labels. `END WALK` is the sole primary action.
- The woman and Golden Retriever belong to the single environmental scene.
  There are no row portraits, avatar circles, or universal dog placeholders.
- The approved environmental field is
  `sanpo-today-indigo-emaki-background-approved-v1.webp` (875 x 1798, WebP q95
  re-encoded from the PNG master — same pixels, 437 KiB instead of 2.25 MiB, so
  it can join the offline shell precache); UI copy and product state remain
  live DOM content layered over it.
- Product typography is Nunito; semantic Matcha, Kaki, Asagi, Indigo, and Cream
  retain their approved meanings. The composition adds no gradients, opacity
  effects, blend modes, filters, decorative motion, or new icon geometry.

The locked fixture order is Juniper (complete), Mochi (current), and Luna
(upcoming). The responsive contract and test protocol live in
`docs/spec/07-indigo-emaki-visual-migration.md`.

### Where Today is allowed to differ, and why

Review **H29** measured Today against the rest of the product and found two
different design systems: `h1` at 28/900/−0.035em against 24/800/normal
everywhere else, a 999px uppercase pill against an 8px sentence-case `.btn`, a
type scale entirely in `clamp(…cqw…)` touching no `--fs-*` token, and a cream
that renders at `#EEE2D4` against a `--sanpo-color-brand-cream` of `#FEF6EA`.
The observation is correct. What follows is the decision about it, so that it
stops reading as drift.

**Today is an illustrated surface and the only one.** Its dimensions are
container-relative because they are registered to a painting: the schedule
begins where the painted field opens up, and since H27 the field's own width
varies with the viewport height, so a fixed `--fs-*` step would break
registration at every size but one. The pill and the display heading belong to
that surface for the same reason. These are permitted divergences:

| Divergence | Scope |
| --- | --- |
| `clamp(…cqw…)` type | Inside `.today-emaki` only |
| Display heading (28–46px, 900, −0.035em) | The Today `h1` only |
| 999px uppercase pill | `.today-emaki-current-action` only |
| Warmer paper (`--emaki-paper`) | The field; Cream remains the mount around it |
| On-artwork state colours | `--emaki-current` / `--emaki-complete`, see above |

Everything else on Today — the colour roles, the contrast floors, the focus
ring, the icon set, the navigation — comes from this document, and the CI
checks that enforce those apply to Today identically.

**What is NOT decided here** is the larger question H29 raises: whether the
product should move *toward* the illustrated surface — a paper ground on
`body`, a display step in the shared scale, one button radius. That would
change every screen, and `CLAUDE.md` is explicit that changing the design
system is a deliberate act recorded in a commit rather than a drive-by edit.
It is real work with a real payoff for the premium positioning the artwork was
bought to create, and it is not remediation. It stays open.

## Segmented controls are real tabs (review M16)

Both segmented controls declared `role="tablist"` and `role="tab"` with
`aria-selected` over bare `<div>` content, and nothing else: no
`aria-controls`, no `role="tabpanel"`, no roving `tabIndex`, no key handling,
and no `aria-label` on ClientDetail's. A screen-reader user was told "tab, 5 of
5, selected" for the operator's main client workspace — whose fifth tab is the
credential vault — reached for the arrow keys that announcement implies, and
nothing happened. **Incorrect ARIA is worse than none**: it promises an
interaction the widget does not have.

`SegmentedTabs` + `TabPanel` are the single implementation. Left/Right (and
Up/Down, since the bar wraps to two rows on a narrow phone) move focus,
Home/End jump to the ends, exactly one tab is in the tab order, and every tab
`aria-controls` a real panel that `aria-labelledby` points back.

**Manual activation**, not selection-follows-focus. The APG recommends
automatic activation "as long as their associated tab panels are displayed
without noticeable latency", and ClientDetail's panels each mount a component
that fetches — arrowing across five tabs would fire five requests on a phone on
cellular. Enter or Space selects. One behaviour for both controls: a widget
that behaves differently in two places is its own accessibility problem.

## State marks are drawn, never typed (review M19)

The payment marks were text glyphs — `✓ … ! ↩ ⚠` — and Nunito does not contain
three of them. Confirmed in Chromium through `CSS.getPlatformFontsForNode`
(not by comparing advance widths, which was inconclusive because U+2713 and
U+21A9 happen to share one): **U+2713, U+21A9 and U+26A0 render in DejaVu
Sans**, the system fallback, while `…`, `!` and `—` do come from Nunito.

So the two most important marks on the money surface, the check beside DONE on
Today, the check on the **client's own report card**, the mark-read control and
the care toggles were all drawn by whatever font the device happened to have,
with synthesised weight — a different shape on the operator's phone and on a
reviewer's laptop.

Five state marks — `check`, `pending`, `alert`, `returned`, `disputed` — are
now approved masters on the same 24×24 / 1.75px round-cap grid as the six
navigation icons, under the same hash guard, routed through `ApprovedIcon`.
One icon system, not two.

## The weight ramp (review M21)

Nunito ships a live `wght` axis from 200 to 1000, and the `@font-face` rule
declares the same range the file carries. Verified by rendering rather than by
reading the declaration: at 40px the advance widths rise monotonically across
400-900 (496 / 498 / 509 / 519 / 527 / 541) and every weight resolves to the
same variable face with no fallback, so an intermediate weight is a real
interpolated instance and not a synthesised one.

The product used only the top of that axis. Of 84 weight declarations **none
was below `body`'s 600**, and all fourteen rules pairing the de-emphasis colour
with a weight sat at 700 or 800 — so a client name under a pet name, a route or
a timestamp rendered *heavier* than the body text it is subordinate to.
De-emphasis was carried by colour and size alone, and
`--sanpo-color-text-secondary` is 4.73:1 on Cream: 0.23 above the floor, with
nothing left to spend.

- `--fw-quiet: 500` is the step that was missing; `--fw-body: 600` names the
  value `body` already used.
- **Text painted in a de-emphasis colour is never heavier than body.**
  `type-ramp.test.ts` enforces it across CSS *and* inline styles — the one
  offender outside the stylesheet was a 12px caption at weight 800, which a
  CSS-only check would have missed.
- 500 rather than 400: the affected rules drop 200 units, which is plainly
  visible, and the finding is the *inversion* rather than absolute lightness.
  400 thins 12px text at 4.73:1 to where an unchanged ratio flatters a stroke
  that is no longer there.
- **Controls are out of scope.** `.segmented-control__button` and
  `.choice-button` carry active/inactive separation in their weight, which is
  an affordance decision, not a text-hierarchy one. Changing them needs its own
  argument; the test names them as exemptions rather than skipping them
  silently.
- The loud end stays literal. A token with no users is churn.
- Today is untouched: it already has a quiet voice of its own — the illustrated
  schedule spans 1000 down to 600 and holds colour constant — and that ramp is
  spec 07's, not this one.

The bordered box around the payment mark went with the glyph: it existed to
give a text mark a consistent footprint across fonts that drew it at wildly
different widths — a workaround for the defect, not a design element. The
visible label beside the mark remains the primary state cue, as everywhere
else in this spec.

`scripts/no-glyph-marks.test.ts` keeps the rule. It bans only the characters
the shipped font genuinely lacks; `…`, `—` and `–` are in Nunito, read better
than their ASCII substitutes, and stay.

## Functional motion (review L17)

The product shipped with three transitions and three keyframes: no press state
on any row, no transition on nav selection, and pressing END WALK — the single
most consequential action an operator takes — produced no designed moment at
all. The progress stroke simply rendered differently on the next paint.

Four durations, and they are a scale rather than a palette:

| Token | Value | For |
| --- | --- | --- |
| `--t-press` | 60 ms | A press acknowledging a finger. Anything past ~80 ms stops reading as response and starts reading as lag. |
| `--t-fast` | 150 ms | Colour on hover, focus and selection. |
| `--t-med` | 250 ms | A value changing on screen — the credit meter filling. |
| `--t-slow` | 400 ms | Reserved for **one** thing: the Today progress advancing when a walk completes. |

Two rules:

1. **A surface that changes colour on interaction fades over `--t-fast`.**
   Instant is not "fast", it is unattributable — the eye cannot tell a hover
   from a repaint, so the feedback does not arrive as feedback.
2. **A surface you can press acknowledges the press within `--t-press`.** On
   touch this is the only response that exists before the next screen arrives,
   and its absence is what makes a tap feel like it was missed. Card-shaped
   controls scale (compositor-only, so it costs no layout pass on the longest
   list in the product); full-bleed rows have no edge to compress against, so
   they deepen their tint instead. A press state that paints a tint joins the
   H24 escalation list like any other — the contrast test caught all three of
   these on the commit that added them.

END WALK's moment is the travelled stroke growing into the segment the
finished walk occupied, with the "you are here" marker sliding with it. The
stroke is drawn by **clipping** the full path, not by `stroke-dashoffset`, so
what animates is the clip rectangle's `width` and `x` — CSS geometry
properties, transitionable in current engines and verified tweening in
Chromium (270px → 810.6px at 120 ms → 900px). An engine that does not
transition them jumps the value, which is the pre-L17 behaviour, so this can
only add.

`prefers-reduced-motion: reduce` already collapses every duration here to
0.01 ms globally. The **states stay** — only the tweening goes, so nothing
becomes unattributable for somebody who asked for less motion.

## Screens with no navigation are centred (review L16)

`.page--centered` — 404, the error boundary, sign-in, password reset. These
used to land top-left in a bare page with no mark on them, and error screens
are disproportionately what people screenshot and send on.

The modifier centres on both axes, drops the bottom-nav reserve (there is no
nav on these routes, and reserving 72px for one leaves the content visibly
high), and caps its child at 400px rather than the 640px reading measure —
every one of these is a single short message or one form, and 640px of a
two-line apology reads as a layout accident. The Sanpo mark appears at
`.brand-logo--small`, sized so the page is recognisably Sanpo without the logo
becoming the subject: the apology is the content.

`ConfigError` is deliberately **not** one of these. It renders when the app's
own module graph may be the broken thing, so it carries its own inline styles
and imports no stylesheet at all.

## Accessibility contract

These are product rules, not review notes: a change that breaks one of them is
a regression whether or not a test catches it. Each was a live defect found in
the 2026-08 review (`docs/review/2026-08-review.md`, B7 / H25 / H26 / M12 /
M13 / L13 / L14) and closed together.

**Contrast is measured on rendered pixels, never on token values.** A token is
evidence of intent; the ratio a user experiences depends on what is actually
painted underneath. The Today progress path was "fixed" twice against the wrong
background because the value was read from the palette instead of sampled from
the screen. Every ratio quoted in this spec was sampled from a screenshot of
the built stylesheet.

**Landmarks and headings.** Every route renders inside exactly one `<main>`
(`AppMain`, id `main-content`), supplied by the shell for each persona. Every
route has an `h1` — visually hidden where the design's heading is a logo or a
state field, present either way, because heading navigation is how a
screen-reader user orients in an unfamiliar app. Every route sets a distinct
`document.title` through `useDocumentTitle`, which also writes the screen name
to a polite live region: a client-side route change is not a page load and
announces nothing on its own.

**The operator shell carries skip links in both directions** — to content and
to navigation. The second is not redundant: the operator nav is DOM-last, which
is right for the mobile bottom bar and wrong for the 88px desktop rail, where
it is visually first. Without it a keyboard operator tabs through every roster
row to change section.

**Failures are announced.** Form errors render only through `FormError`
(`components/fields.tsx`), which mounts its `role="alert"` region whether or
not there is a message, so the region is in the accessibility tree before the
text arrives. Empty, it is taken out of flow — an absolutely positioned child
is not a flex item, so it costs no `gap` in the forms it sits inside. Progress
and outcome notices (Calendar, Money) use persistent `role="status"` regions on
the same principle. CI fails a bare `className="field__error"` outside
`fields.tsx`.

**Controls whose only boundary is a border clear 3:1** (SC 1.4.11).
`--sanpo-color-input-border` is Neutral Muted — 5.07:1 on white, 4.73:1 on
Cream — not Neutral Rule, which is 1.47:1 and 1.37:1 and effectively invisible
outdoors. `--sanpo-color-border-subtle` keeps Neutral Rule for decorative card
edges; the two roles are deliberately split. Input borders are `2px`: Chrome
floors border widths to whole device pixels, so `1.5px` renders as `1px` at
DPR 1.

**Tint surfaces escalate their text roles.** CT-1's text roles clear 4.5:1 on
Cream and White by 0.2–0.8, and every tint consumes that margin: on the Kaki
tint `text-secondary` is 3.71:1, `text-attention` 3.85:1,
`text-relationship` 3.80:1, `text-success` 3.95:1. Only `text-primary` passes
everywhere. Each role therefore has a `--sanpo-color-<role>-on-tint` variant —
the role itself at 85%, mixed with CT-1 black, which scales all three channels
equally and so moves lightness without touching hue. 85% is one number for all
five because a per-role table drifts; it is the largest common step that clears
the floor on every tint, and the result is 4.76:1 at worst.

Escalation happens **once per surface, not once per component**: every rule
painting a tint re-points the roles for its subtree, so a descendant written
with `var(--sanpo-color-text-secondary)` is correct without knowing what it
sits on. Both live failures the review found were components that had no idea
they were on a tint.

Two tests hold it. `scripts/role-contrast.test.ts` recomputes the whole role ×
surface matrix from the stylesheets and fails any pair under 4.5:1, and parses
`components.css` to fail any rule that paints a tint without joining the
escalation list. `e2e/tint-contrast.spec.ts` then checks the rendered gallery,
because the model cannot see everything: it found `.section-label` reading the
legacy `--ink-500` alias, which resolved straight to the palette entry and so
inherited past both the escalation and the `prefers-contrast` override. **The
compatibility aliases resolve to CT-1 roles, never to raw palette entries** —
that is what the alias layer is for, and getting it wrong is invisible until
something overrides the role.

**Contrast over artwork is measured from the artwork.** Where ink sits on a
painted backdrop rather than a flat token — today that is only Today — the
ratio is sampled from the rendered pixels, never computed from
`--sanpo-color-brand-cream`. `e2e/today-contrast.spec.ts` takes the ink from
computed style, hides it, screenshots the page and reads the pixel underneath;
it fails the build under 3:1 for graphics that carry state and 4.5:1 for text,
and prints the whole table on success so a comment in `components.css` can be
checked against a run. Every ratio written in a comment on those elements comes
from that run.

The rule exists because the alternative was tried twice. Both rounds computed
against Cream, both stated a confident figure in a comment, and both were about
16% optimistic — the paper under the schedule samples rgb(237,224,208), not
`#FEF6EA`. A logged, reasoned ratio that is still under the floor is worse than
an open bug, because nobody looks again. Text that carries a `text-shadow`
outline is measured against its own halo instead, and the sampler asserts the
halo exists; an exemption needs a written reason in the target itself.

**The credential vault reveal panel** is Cream on Indigo (9.03:1) with a ghost
Copy button (Cream fill, 9.03:1 against the panel) and a Yamabuki focus ring
(4.71:1, scoped to the panel because the default Asagi ring is 1.70:1 on
Indigo). The countdown carries no opacity. This is the highest-stakes string
the product displays — a door, lockbox or alarm code — for 30 seconds,
outdoors, one-handed; it is never routed through legacy colour aliases again.

**Live numbers have names and do not interrupt.** The Walk Mode timer and
distance carry `role="timer"`, `aria-live="off"` and an `aria-label` that says
which is which. The rule learned from the retired live-walk banner (deleted in
`qc(lows)` L21, superseded by the Today schedule's own row) still stands for
any live number placed inside a link: elapsed time is excluded from the link's
accessible name, because a 1 s tick renamed the link under the user's focus
every second.

**Modal sheets enforce modality.** `Sheet` requires a `title` (a dialog with no
accessible name cannot be reached by name or rotor) and marks every sibling of
its ancestor chain `inert` while open, restoring exactly what it set.
`aria-modal="true"` alone is a request that only assistive technology honours;
`inert` also removes the background from focus and hit-testing. The backdrop is
exempt, or it would swallow the click that dismisses the sheet.
