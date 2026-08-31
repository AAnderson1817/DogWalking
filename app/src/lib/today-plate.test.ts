import { describe, expect, it } from "vitest";
import {
  TODAY_PLATE_CANDIDATES,
  TODAY_PLATE_HEIGHT,
  TODAY_PLATE_SRC,
  TODAY_PLATE_SRCSET,
  TODAY_PLATE_WIDTH,
} from "./today-plate";

/**
 * Review M17. The runtime half of the plate's contract — what the `<img>`
 * actually receives. The source-drift half (does this agree with the files on
 * disk, the generator that writes them, the hash guard, and the `--page-max`
 * expression `sizes` restates?) is `scripts/today-plate.test.ts`, which needs
 * `node:fs` and therefore belongs in the other tsconfig project.
 */
describe("the Today plate's srcset", () => {
  it("names every candidate with its own width descriptor", () => {
    // A descriptor that disagrees with the file's real width is worse than a
    // missing candidate: the browser believes it and picks on a false premise.
    for (const candidate of TODAY_PLATE_CANDIDATES) {
      expect(TODAY_PLATE_SRCSET).toContain(`${candidate.src} ${candidate.width}w`);
    }
    expect(TODAY_PLATE_SRCSET.split(",")).toHaveLength(TODAY_PLATE_CANDIDATES.length);
  });

  it("gives every candidate a distinct URL", () => {
    // Four entries pointing at one file is a srcset that compiles, renders and
    // saves nothing — inert in exactly the way that looks finished.
    const urls = new Set(TODAY_PLATE_CANDIDATES.map((candidate) => candidate.src));
    expect(urls.size).toBe(TODAY_PLATE_CANDIDATES.length);
  });

  it("falls back to the master, not a downscale, for a browser ignoring srcset", () => {
    const master = TODAY_PLATE_CANDIDATES.find((c) => c.width === TODAY_PLATE_WIDTH);
    expect(master, "no candidate is the full-width master").toBeDefined();
    expect(TODAY_PLATE_SRC).toBe(master?.src);
  });

  it("keeps the approved plate's intrinsic size", () => {
    // These drive the <img> width/height attributes, so a wrong pair reserves
    // the wrong box and shifts the whole composition before the image loads.
    expect([TODAY_PLATE_WIDTH, TODAY_PLATE_HEIGHT]).toEqual([875, 1798]);
  });
});
