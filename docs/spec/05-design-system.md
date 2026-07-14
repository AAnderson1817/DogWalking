# 05 — Design system v2: "Biscuit"

Warm cream anime/neo-brutalist look, from the operator's Claude Design mock ("PawTrail Screens" 2a–2d): chunky `#3B2A20` borders with hard offset shadows, orange paw brand mark, hand-drawn dog-face avatars, headlines and numerals in Baloo 2, body in Nunito (600+ weights). Plain CSS custom properties + hand-rolled components; no Tailwind, no UI framework. Supersedes v1 "Trailhead" (deep-pine); legacy `--pine-*`/`--teal-*` var names remain as aliases so older screen code keeps working.

## Tokens (`app/src/styles/tokens.css`)
```css
:root {
  /* palette */
  --cream-page:#FFF6E9; --cream-deep:#FFF1DC; --card:#FFFFFF;
  --ink-900:#3B2A20; --ink-700:#7A5B41; --ink-500:#A9856A; --ink-mono:#B4855C;
  --line-soft:#E8C79A; --hairline:#F3E3CB;
  --orange:#FF6B35; --orange-deep:#B4520A; --orange-tint:#FFD9C4;
  --butter:#FFE28A; --butter-ink:#7A4E00;      /* credits, warnings */
  --sky:#8FD8FF; --sky-bright:#38BDF8; --sky-ink:#14344A; --sky-mid:#2E6E8F; /* live */
  --mint:#7FE3B4; --mint-ink:#0E5C3F;          /* success/done */
  --lilac:#DCD2FF; --lilac-ink:#5B4A8C;        /* upcoming */
  --pink:#FFC7D8; --pink-ink:#8C4A5C; --blush:#FF9BB3; /* attention */
  --red:#E5484D; --green:#0E9F6E; --white:#FFFFFF;
  /* semantic */
  --bg:var(--cream-page); --surface:var(--card); --text:var(--ink-900);
  --text-2:var(--ink-700); --brand:var(--orange); --accent:var(--sky-bright);
  --danger:var(--red); --warn:var(--butter);
  /* borders + pop shadows (the v2 signature) */
  --line:var(--ink-900); --bw:2.5px; --bw-sm:2px; --bw-xs:1.5px;
  --pop:4px 4px 0 var(--ink-900); --pop-sm:3px 3px 0 var(--ink-900);
  --pop-xs:2px 2px 0 var(--ink-900); --pop-live:4px 4px 0 var(--sky-bright);
  /* type */
  --font-body:'Nunito',system-ui,sans-serif;
  --font-display:'Baloo 2',var(--font-body); /* headings + all GPS/credit numerals, tnum */
  --fs-12:.75rem; --fs-14:.875rem; --fs-16:1rem; --fs-20:1.25rem;
  --fs-24:1.5rem; --fs-32:2rem; --fs-44:2.75rem;
  /* space (4pt) */ --s-1:4px; --s-2:8px; --s-3:12px; --s-4:16px; --s-6:24px; --s-8:32px; --s-12:48px;
  /* radius */ --r-sm:10px; --r-md:14px; --r-lg:18px; --r-full:999px;
  /* motion */ --ease:cubic-bezier(.2,.8,.2,1); --t-fast:150ms; --t-med:250ms;
}
/* Walk Mode is the light "day" surface in v2 (mock 2b); class kept for hooks. */
.walkmode { --bg:var(--cream-page); --surface:var(--card); --text:var(--ink-900); --text-2:var(--ink-700); }
```

## Signature: pulse-live (sky)
```css
@keyframes pulse-live { 0%{box-shadow:0 0 0 0 rgb(56 189 248/.55)} 70%{box-shadow:0 0 0 12px rgb(56 189 248/0)} 100%{box-shadow:0 0 0 0 rgb(56 189 248/0)} }
.pulse-live { width:10px;height:10px;border-radius:var(--r-full);background:var(--sky-bright);border:2px solid var(--line);animation:pulse-live 2s infinite; }
```
Used on: LiveWalkBanner, active map marker, portal live-tracking header. Respect `prefers-reduced-motion: reduce` → animation off, static ring.

## Type rules
- Body floor is Nunito 600 (Nunito reads thin below that); headings/display Baloo 2 800.
- Screen titles `--fs-24`–`--fs-32`; section labels `--fs-12` uppercase 900 letter-spacing .08em `--ink-500`.
- Every credit count, timer, distance, and coordinate readout: display font, `tnum`, `--fs-32`+ in Walk Mode.

## Motifs
- Paw mark (4 filled circles, `PawIcon`) — brand + active nav pill.
- Dog-face avatars (`PetFace`): ears/eyes/muzzle/blush SVG, colorway hashed from the pet's name (7 colorways).
- Cards: `--bw` solid `--line`, radius `--r-lg`, `--pop` shadow; quiet variants `card--flat` / `card--soft`.
- Status chips: bordered pills — scheduled=lilac, in_progress=sky, completed=mint, overage/warn=butter, cancelled=soft outline.

## Component inventory (built phase 03)
Primitives: `Button` (primary=orange/cream, accent=butter, ghost, danger; bordered + pop shadow; 44px min touch target), `Card`, `Input`/`Textarea`/`Select`, `Badge` (bordered pills: scheduled=lilac, in_progress=sky, completed=mint, cancelled=soft outline, overage=butter), `Sheet` (bottom sheet, mobile-first), `Spinner`, `EmptyState`.
Composites: `CreditMeter` (bar with bordered track; Baloo numeral; orange under threshold), `WalkCard` (time window, pets avatars, property label, status badge), `MapView` (Mapbox GL when `VITE_MAPBOX_TOKEN` set; else SVG polyline auto-fit fallback — identical props: `points`, `live?`), `LiveWalkBanner` (fixed top, pulse-live + elapsed timer), `ReportCard` (photo grid, route map, potty/fed icons, notes), `BottomNav` (operator: Today · Calendar · Roster · Vault; portal: Home · Book · Walks · Billing).

## Layout
Mobile-first, max content width 640px centered; BottomNav fixed, safe-area-inset padding; page padding `--s-4`. Desktop ≥1024px: nav collapses to left rail (operator only).
