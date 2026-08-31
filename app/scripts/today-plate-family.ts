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

/**
 * Which of the plate's OWN variants sit in `src/assets/illustrations`, by width.
 *
 * The stem test is the load-bearing half, and leaving it out was a real bug
 * (caught in review on this PR). `illustrations/` is a shared directory, so a
 * second responsive illustration — `some-other-scene-320w.webp` — matches the
 * width pattern perfectly well. Counting it here while `todayPlateFamily`
 * counts only files carrying the plate's basename makes the two disagree by
 * one, and the build then fails EVERY time with a plate-variant mismatch while
 * every Today candidate is present and correct.
 *
 * That is the worst shape available for this check: not a gate that fails to
 * fire, but one that fires on a repository that is fine, which is how a gate
 * gets deleted by whoever is trying to ship something unrelated.
 *
 * ONE implementation, exported, because the first fix for this scoped the
 * build's copy and left the test's own identical scan of the same directory
 * unscoped — so the suite still went red on a healthy tree. That is the
 * "fixed one site and not its sibling" shape this repository keeps recording,
 * and the way out of it is that there is no sibling to forget.
 */
export function plateSourceVariantWidths(files: string[]): number[] {
  return files
    .map((f) => (f.startsWith(PLATE_BASENAME) ? /-(\d+)w\.webp$/.exec(f) : null))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b);
}

/** The same question, asked by the build, which only needs how many. */
export function plateSourceVariantCount(files: string[]): number {
  return plateSourceVariantWidths(files).length;
}

export interface PlateFamily {
  stem: string;
  fallback: string;
  variants: string[];
}

/**
 * A named type rather than a bare Error, so the build can tell a plate failure
 * from a missing `dist/assets`.
 *
 * The caller has to re-throw this out of a `catch` that exists to tolerate a
 * `public`-only build, and the first version of that check matched on the
 * error's MESSAGE TEXT. Rewording a sentence would then have silently turned
 * the re-throw off and let the build swallow exactly the failures this class
 * exists to surface — a gate that stops running because someone improved the
 * prose is the shape this repository keeps finding.
 */
export class PlateFamilyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlateFamilyError";
  }
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
    throw new PlateFamilyError(
      `expected exactly one Today plate master in the bundle, found ${masters.length} `
        + `(${masters.join(", ") || "none"}). The service worker would have nothing to fall back to.`,
    );
  }
  if (variants.length !== sourceVariantCount) {
    throw new PlateFamilyError(
      `${sourceVariantCount} Today plate variants exist in src/assets/illustrations but `
        + `${variants.length} reached the bundle (${variants.join(", ") || "none"}). `
        + "A variant that is never imported is never served, so `srcset` would name a URL that 404s.",
    );
  }
  return { stem: PLATE_BASENAME, fallback: `/assets/${masters[0]}`, variants };
}


