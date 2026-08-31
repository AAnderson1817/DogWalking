/**
 * The Today plate ships as four responsive candidates (review M17), and only
 * ONE of them belongs in the precache.
 *
 * Precaching all four would put ~923 KiB of artwork into every install to
 * serve the ~180 KiB any single device actually picks — re-inflating the
 * offline budget the `perf(today-field)` work reclaimed, which is the exact
 * thing the review said not to do. Precaching none is worse: an <img srcset>
 * does NOT fall back to another candidate when the picked one fails (measured
 * in Chromium: the image stays at naturalWidth 0 and simply does not render),
 * so a cold offline start would paint no artwork at all on any device whose
 * pick was not cached.
 *
 * So: the master is precached, the variants are left to the worker's
 * cache-first rule, and the worker substitutes the precached master for any
 * plate candidate it cannot produce. That substitution is seamless because
 * every candidate is the same composition at the same ratio and the layout is
 * CSS-driven — measured: serving the 875x1798 master for a 438w URL renders at
 * ratio 2.0548 against the plate's 2.0549.
 *
 * The stem is DERIVED from the emitted files rather than written here, so the
 * worker carries no filename convention of its own and a rename cannot leave
 * it silently matching nothing.
 */
export const PLATE_BASENAME = "sanpo-today-indigo-emaki-background-approved-v1";
/** `<stem>-<width>w-<hash>.webp` is a variant; `<stem>-<hash>.webp` is the master. */
export const PLATE_VARIANT_RE = /-\d+w-[^.]+\.webp$/;
/** The same thing before Vite hashes it: `<stem>-<width>w.webp` on disk. */
export const PLATE_SOURCE_VARIANT_RE = /-\d+w\.webp$/;

export interface PlateFamily {
  stem: string;
  fallback: string;
  variants: string[];
}

export function todayPlateFamily(files: string[], sourceVariantCount: number): PlateFamily {
  const family = files.filter((f) => f.startsWith(PLATE_BASENAME) && f.endsWith(".webp"));
  const variants = family.filter((f) => PLATE_VARIANT_RE.test(f));
  const masters = family.filter((f) => !PLATE_VARIANT_RE.test(f));

  // Every one of these is a build failure rather than a warning, because each
  // of them ships a Today screen that looks finished and is not: no plate
  // offline, or an install carrying artwork nobody asked for. This repository
  // has shipped "a gate that passes by not running" often enough to write the
  // rule down.
  if (masters.length !== 1) {
    throw new Error(
      `expected exactly one Today plate master in the bundle, found ${masters.length} `
        + `(${masters.join(", ") || "none"}). The service worker would have nothing to fall back to.`,
    );
  }
  if (variants.length !== sourceVariantCount) {
    throw new Error(
      `${sourceVariantCount} Today plate variants exist in src/assets/illustrations but `
        + `${variants.length} reached the bundle (${variants.join(", ") || "none"}). `
        + "A variant that is never imported is never served, so `srcset` would name a URL that 404s.",
    );
  }
  return { stem: PLATE_BASENAME, fallback: `/assets/${masters[0]}`, variants };
}


