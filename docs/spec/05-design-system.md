# 05 — Design system: "Trailhead"

Deep-pine outdoor palette; GPS/numeric data in Space Grotesk; the pulsing live-teal dot is the signature element. Light UI by default; Walk Mode inverts to pine-950 ("night-walk"). Plain CSS custom properties + hand-rolled components; no Tailwind, no UI framework.

## Tokens (`app/src/styles/tokens.css`)
```css
:root {
  /* palette */
  --pine-950:#081914; --pine-900:#0E2A23; --pine-800:#14382E;
  --pine-700:#1C4A3C; --pine-600:#256052; --pine-400:#4E8A78;
  --teal-live:#2DD4BF; --teal-dim:#14B8A6;
  --paper:#F6F4EE; --mist:#E7EBE6; --card:#FFFFFF;
  --ink:#0F1F19; --ink-soft:#46574F; --ink-faint:#8A988F;
  --amber:#F0A830; --red:#E5484D; --white:#FFFFFF;
  /* semantic */
  --bg:var(--paper); --surface:var(--card); --text:var(--ink);
  --text-2:var(--ink-soft); --brand:var(--pine-800); --accent:var(--teal-live);
  --danger:var(--red); --warn:var(--amber);
  /* type */
  --font-body:'Inter',system-ui,sans-serif;
  --font-display:'Space Grotesk',var(--font-body); /* headings + all GPS/credit numerals, font-feature-settings:'tnum' */
  --fs-12:.75rem; --fs-14:.875rem; --fs-16:1rem; --fs-20:1.25rem;
  --fs-24:1.5rem; --fs-32:2rem; --fs-44:2.75rem;
  /* space (4pt) */ --s-1:4px; --s-2:8px; --s-3:12px; --s-4:16px; --s-6:24px; --s-8:32px; --s-12:48px;
  /* radius */ --r-sm:8px; --r-md:12px; --r-lg:16px; --r-full:999px;
  /* elevation */ --shadow-1:0 1px 3px rgb(8 25 20/.08); --shadow-2:0 4px 16px rgb(8 25 20/.12);
  /* motion */ --ease:cubic-bezier(.2,.8,.2,1); --t-fast:150ms; --t-med:250ms;
}
.walkmode { --bg:var(--pine-950); --surface:var(--pine-900); --text:#EDF5F1; --text-2:#9DB8AE; }
```

## Signature: pulse-live
```css
@keyframes pulse-live { 0%{box-shadow:0 0 0 0 rgb(45 212 191/.45)} 70%{box-shadow:0 0 0 12px rgb(45 212 191/0)} 100%{box-shadow:0 0 0 0 rgb(45 212 191/0)} }
.pulse-live { width:10px;height:10px;border-radius:var(--r-full);background:var(--teal-live);animation:pulse-live 2s infinite; }
```
Used on: LiveWalkBanner, active map marker, portal live-tracking header. Respect `prefers-reduced-motion: reduce` → animation off, static ring.

## Type rules
- Screen titles `--fs-24`/display/600; section labels `--fs-12` uppercase letter-spacing .08em `--text-2`.
- Every credit count, timer, distance, and coordinate readout: display font, `tnum`, `--fs-32`+ in Walk Mode.

## Component inventory (built phase 03)
Primitives: `Button` (primary=pine-800/white, accent=teal, ghost, danger; radius `--r-md`; 44px min touch target), `Card`, `Input`/`Textarea`/`Select`, `Badge` (status colors: scheduled=mist, in_progress=teal, completed=pine-600, cancelled=faint, overage=amber), `Sheet` (bottom sheet, mobile-first), `Spinner`, `EmptyState`.
Composites: `CreditMeter` (radial or bar; numeral in display font; amber under threshold), `WalkCard` (time window, pets avatars, property label, status badge), `MapView` (Mapbox GL when `VITE_MAPBOX_TOKEN` set; else SVG polyline auto-fit fallback — identical props: `points`, `live?`), `LiveWalkBanner` (fixed top, pulse-live + elapsed timer), `ReportCard` (photo grid, route map, potty/fed icons, notes), `BottomNav` (operator: Today · Calendar · Roster · Vault; portal: Home · Book · Walks · Billing).

## Layout
Mobile-first, max content width 640px centered; BottomNav fixed, safe-area-inset padding; page padding `--s-4`. Desktop ≥1024px: nav collapses to left rail (operator only).
