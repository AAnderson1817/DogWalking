import { describe, expect, it } from "vitest";
import {
  PLATE_SOURCE_VARIANT_RE,
  PlateFamilyError,
  plateSourceVariantCount,
  plateSourceVariantWidths,
  todayPlateFamily,
} from "./today-plate-family.ts";

/**
 * Review M17. The build decides which Today plate goes in the precache and
 * which URL the service worker substitutes for the rest. Both decisions are
 * invisible at runtime — a wrong one ships a green build whose primary screen
 * is blank offline, or an install carrying three plates nobody asked for.
 *
 * So each failure mode throws rather than warning, and this drives the real
 * function rather than reading the config for a comment that says it does.
 */
const STEM = "sanpo-today-indigo-emaki-background-approved-v1";
const MASTER = `${STEM}-B7ae2uy3.webp`;
const VARIANTS = [`${STEM}-438w-Le3xnTjr.webp`, `${STEM}-640w-Dj8mncxk.webp`, `${STEM}-750w-uHb43fej.webp`];
const OTHERS = ["index-CHGlXcTt.css", "index-Uulu4tkL.js", "sanpo-corporate-master-approved-v1-Y8xx-dg2.svg"];

describe("the build's Today plate family", () => {
  it("names the master as the fallback and the rest as variants", () => {
    const family = todayPlateFamily([...OTHERS, ...VARIANTS, MASTER], 3);
    expect(family.fallback).toBe(`/assets/${MASTER}`);
    expect(family.variants.sort()).toEqual([...VARIANTS].sort());
    expect(family.stem).toBe(STEM);
  });

  it("refuses a bundle whose variants never made it in", () => {
    // A variant that no module imports is never emitted, so `srcset` would
    // name a URL that 404s — and a 404 candidate paints NOTHING, because an
    // <img srcset> does not fall back to another entry.
    expect(() => todayPlateFamily([...OTHERS, MASTER], 3)).toThrow(/3 Today plate variants exist/);
    expect(() => todayPlateFamily([...OTHERS, VARIANTS[0], MASTER], 3)).toThrow(/but 1 reached/);
  });

  it("refuses a bundle with no master to fall back to", () => {
    expect(() => todayPlateFamily([...OTHERS, ...VARIANTS], 3)).toThrow(
      /exactly one Today plate master/,
    );
  });

  it("refuses a bundle with more than one master", () => {
    // Two masters means the fallback is a coin toss between them, and the one
    // NOT chosen is precached by nobody.
    expect(() => todayPlateFamily([...OTHERS, ...VARIANTS, MASTER, `${STEM}-Zz999999.webp`], 3))
      .toThrow(/found 2/);
  });

  it("does not mistake another illustration for the plate", () => {
    const foreign = "some-other-illustration-438w-Aa111111.webp";
    const family = todayPlateFamily([...OTHERS, ...VARIANTS, MASTER, foreign], 3);
    expect(family.variants).not.toContain(foreign);
  });

  it("throws a NAMED error, because the build re-throws it by type", () => {
    // `vite.config.ts` catches around this call to tolerate a `public`-only
    // build with no `dist/assets`, and has to let plate failures back out. It
    // used to decide that by matching the message text, so rewording a
    // sentence would have silently turned the re-throw off and let the build
    // swallow the failure. If a future branch here throws a bare Error, the
    // build goes quiet and this is what says so.
    for (const bad of [
      () => todayPlateFamily([...OTHERS, MASTER], 3),
      () => todayPlateFamily([...OTHERS, ...VARIANTS], 3),
      () => todayPlateFamily([...OTHERS, ...VARIANTS, MASTER, `${STEM}-Zz999999.webp`], 3),
    ]) {
      expect(bad).toThrow(PlateFamilyError);
    }
  });

  it("counts only the PLATE's source variants, not every responsive image", () => {
    // Found in review. `src/assets/illustrations/` is a shared directory, so a
    // second responsive illustration matches the width pattern perfectly well.
    // Counting it here while `todayPlateFamily` counts only the plate's own
    // files makes the two disagree by one — and the build then fails EVERY
    // time, on a repository where every Today candidate is present and
    // correct. A gate that fires on a healthy tree is how gates get deleted.
    const onDisk = [
      `${STEM}.webp`,
      `${STEM}-438w.webp`,
      `${STEM}-640w.webp`,
      `${STEM}-750w.webp`,
      "some-other-scene-320w.webp",
      "some-other-scene.webp",
    ];
    expect(plateSourceVariantCount(onDisk)).toBe(3);
    // The WIDTHS matter as much as the count: `today-plate.test.ts` compares
    // this list against the generator and against `srcset`, so a foreign
    // illustration leaking in turns three assertions red on a healthy tree.
    // That is exactly what happened when only the build's copy was scoped —
    // hence one shared helper rather than two scans of the same directory.
    expect(plateSourceVariantWidths(onDisk)).toEqual([438, 640, 750]);

    // End to end: with that foreign illustration on disk, a correct bundle
    // must still be accepted.
    expect(() =>
      todayPlateFamily([...OTHERS, ...VARIANTS, MASTER], plateSourceVariantCount(onDisk)),
    ).not.toThrow();
  });

  it("counts source variants by the un-hashed name Vite starts from", () => {
    // `<stem>-<width>w.webp` on disk; `<stem>-<width>w-<hash>.webp` in dist.
    // Matching the dist form against the source directory would count zero and
    // then "agree" with a bundle that shipped no variants at all.
    expect(PLATE_SOURCE_VARIANT_RE.test(`${STEM}-438w.webp`)).toBe(true);
    expect(PLATE_SOURCE_VARIANT_RE.test(`${STEM}.webp`)).toBe(false);
    expect(PLATE_SOURCE_VARIANT_RE.test(`${STEM}-438w-Le3xnTjr.webp`)).toBe(false);
  });
});
