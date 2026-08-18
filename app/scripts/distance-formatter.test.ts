import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Review M36. Today converted metres to miles inline while `ReportCard` — the
 * report the pet owner receives — used a kilometres formatter, so one walk
 * read "7.2 mi" on the operator's home screen and "2.1 km" on the client's.
 *
 * Fixing the two call sites does not stop the third. The rule is that distance
 * is formatted in exactly one place, so this asserts the rule rather than the
 * instance.
 */

const SRC = join(import.meta.dirname, "..", "src");
const FORMATTER = join(SRC, "lib", "format.ts");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe("distance is formatted in one place", () => {
  const files = sourceFiles(SRC);

  it("finds the source tree at all", () => {
    // Vacuity guard: a wrong path makes every assertion below pass by
    // scanning nothing, which is the failure mode this repo keeps meeting.
    expect(files.length).toBeGreaterThan(30);
    expect(files).toContain(FORMATTER);
  });

  it("declares the metres-per-mile constant only in the formatter", () => {
    const offenders = files
      .filter((f) => f !== FORMATTER)
      .filter((f) => /1609(\.344)?/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(offenders, "convert distance through distanceMi(), not inline").toEqual([]);
  });

  it("keeps no kilometre formatter around for a screen to pick up", () => {
    // A call or a declaration, not a mention — and the formatter itself is
    // exempt, because its doc comment explains what the old name was and why
    // it went. A grep cannot tell a mention from a use; narrowing the pattern
    // and exempting the one file allowed to discuss it is the honest fix,
    // rather than deleting the history to satisfy the check.
    const offenders = files
      .filter((f) => f !== FORMATTER)
      .filter((f) => /\bdistanceKm\s*\(/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("still has the one formatter it is protecting", () => {
    expect(readFileSync(FORMATTER, "utf8")).toMatch(/export function distanceMi\(/);
  });
});
