/**
 * The Today plate and its responsive candidates (review M17).
 *
 * ONE module, and the component reads it directly rather than taking the plate
 * as a prop, because the failure this replaces is a call site that passes a
 * `src` and forgets the `srcSet`: that ships the old single-master behaviour
 * while looking finished. Two screens render this composition (`Dashboard` and
 * the DEV `TodayPreview`), and a third will exist eventually.
 *
 * The plate is 875 x 1798 and that is every pixel there is. The review asked
 * for a 2x master as well; no source above 875px exists anywhere in the
 * repository (`docs/reference/sanpo-today-locked-composition.png` is the
 * composition mockup, artwork PLUS UI — 18.57 dB PSNR against the plate — and
 * its README says it must not be embedded). So a DPR-3 phone still upscales,
 * exactly as it did before, and that half of M17 is new artwork rather than a
 * code change. What is fixed here is the other half: every device that needs
 * FEWER than 875 pixels was downloading all of them.
 */
import plate438 from "@/assets/illustrations/sanpo-today-indigo-emaki-background-approved-v1-438w.webp";
import plate640 from "@/assets/illustrations/sanpo-today-indigo-emaki-background-approved-v1-640w.webp";
import plate750 from "@/assets/illustrations/sanpo-today-indigo-emaki-background-approved-v1-750w.webp";
import plate875 from "@/assets/illustrations/sanpo-today-indigo-emaki-background-approved-v1.webp";

/** The approved artwork's intrinsic size. Every candidate shares this ratio. */
export const TODAY_PLATE_WIDTH = 875;
export const TODAY_PLATE_HEIGHT = 1798;

/**
 * Candidate widths are MEASURED field widths, not a generic 1x/2x ladder —
 * each is the exact size some real device asks for:
 *
 *   438  the field at 1440x900, the desktop viewport spec 07 names for
 *        testing: 900 * 875/1798 = 438.0, with no nav reserve at >=1024px
 *   640  the field's maximum — `--page-max` caps there, so no device ever
 *        needs more than 640 CSS px
 *   750  375 CSS px at DPR 2, the commonest DPR-2 phone width
 *   875  the master: every DPR-3 device, and every need above 750
 */
export const TODAY_PLATE_CANDIDATES = [
  { width: 438, src: plate438 },
  { width: 640, src: plate640 },
  { width: 750, src: plate750 },
  { width: TODAY_PLATE_WIDTH, src: plate875 },
] as const;

/**
 * `src` is the master, so a browser that ignores `srcset` entirely gets the
 * full plate rather than a downscale — the same bytes it gets today.
 */
export const TODAY_PLATE_SRC: string = plate875;

export const TODAY_PLATE_SRCSET: string = TODAY_PLATE_CANDIDATES.map(
  (candidate) => `${candidate.src} ${candidate.width}w`,
).join(", ");

/**
 * `sizes` mirrors `--page-max` in `components.css`, because that is what
 * decides the plate's rendered width (`.page { max-width: var(--page-max) }`,
 * and the plate is `width: 100%` of the field).
 *
 * `sizes` is resolved BEFORE layout, so it cannot ask the element how wide it
 * is — the expression has to be restated. `scripts/today-plate.test.ts` reads
 * both out of `components.css` and fails when they drift; that guard is the
 * only thing making this duplication safe.
 *
 * `clamp()`, `calc()`, `min()` and `dvh` are all legal `<source-size-value>`s
 * and Chromium honours them — verified against the real page, where every
 * candidate the browser picked matched the field width actually rendered.
 *
 * The one deliberate inexactness: the CSS nav reserve is
 * `calc(72px + env(safe-area-inset-bottom, 0px))` and `env()` cannot be
 * resolved this early, so the bare `72px` is used. That UNDER-states the
 * reserve, so the computed size is slightly LARGE, so the browser may pick a
 * candidate one step bigger than strictly needed. Erring large is the safe
 * direction: it costs bytes, never resolution.
 */
export const TODAY_PLATE_SIZES: string = [
  "(min-width: 1024px) clamp(420px, calc(100dvh * 875 / 1798), 640px)",
  "(min-width: 768px) clamp(420px, calc((100dvh - 72px) * 875 / 1798), 640px)",
  "min(100vw, 640px)",
].join(", ");
