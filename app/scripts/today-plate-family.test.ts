import { describe, expect, it } from "vitest";
import { PLATE_SOURCE_VARIANT_RE, todayPlateFamily } from "./today-plate-family.ts";

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

  it("counts source variants by the un-hashed name Vite starts from", () => {
    // `<stem>-<width>w.webp` on disk; `<stem>-<width>w-<hash>.webp` in dist.
    // Matching the dist form against the source directory would count zero and
    // then "agree" with a bundle that shipped no variants at all.
    expect(PLATE_SOURCE_VARIANT_RE.test(`${STEM}-438w.webp`)).toBe(true);
    expect(PLATE_SOURCE_VARIANT_RE.test(`${STEM}.webp`)).toBe(false);
    expect(PLATE_SOURCE_VARIANT_RE.test(`${STEM}-438w-Le3xnTjr.webp`)).toBe(false);
  });
});
