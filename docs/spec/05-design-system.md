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
- Layout is mobile-first and caps working surfaces at `640 px`. The operator
  navigation is fixed at the bottom on touch layouts and becomes a left rail
  at `1024 px`.
- Approved UI icons are the unchanged masters in `app/src/assets/icons`.
  Product state changes color, adjacent language, or placement—not geometry.

Compatibility aliases remain in `tokens.css` so unconverted selectors inherit
the production colors and quiet structure. They do not authorize the retired
PawTrail appearance.

## Sanpo production navigation override

The following approved production rules supersede the older PawTrail/Biscuit
operator-navigation examples without otherwise redesigning the component kit:

- Authoritative primary destinations: `Today / Calendar / Clients / Money`.
- Route mapping: `/`, `/calendar`, `/roster`, `/billing`.
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
- Operator navigation uses CT-1 roles: Indigo active, Yamabuki active marker,
  Muted inactive, Cream canvas, and Asagi focus.
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
  duration. Clickable rows are native buttons with complete accessible labels.
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
