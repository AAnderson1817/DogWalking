import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Review M19. State marks must be drawn, not typed.
 *
 * `PaymentStatus` rendered `✓ … ! ↩ ⚠` as text, and Nunito does not contain
 * three of them. Verified in Chromium through `CSS.getPlatformFontsForNode`
 * — not by comparing advance widths, which was inconclusive because U+2713
 * and U+21A9 happen to share one — that U+2713, U+21A9 and U+26A0 are
 * rendered by DejaVu Sans, the system fallback, while `…`, `!` and `—` do
 * come from Nunito.
 *
 * So the two most important marks on the money surface, the check beside DONE
 * on Today, the check on the CLIENT'S OWN REPORT CARD, the mark-read control
 * and the care toggles were all drawn by whatever font the device happened to
 * have, with synthesised weight. Literally a different shape on the operator's
 * Pixel and on the reviewer's Mac.
 *
 * The review named two of those six places. Fixing the named ones would have
 * left four, which is why this asserts the rule.
 */

const SRC = join(import.meta.dirname, "..", "src");

/**
 * Characters confirmed absent from Nunito, so a fallback font draws them.
 *
 * Deliberately NOT a blanket ban on non-ASCII: `…`, `—` and `–` are in the
 * font, read better than their ASCII substitutes, and appear throughout the
 * copy. A rule that banned them would be wrong and would be turned off.
 */
const FALLBACK_DRAWN = ["✓", "✔", "↩", "⚠", "✗", "✘"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** Strips `//` and block comments: prose about a glyph is not a rendered one. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("state marks are drawn, not typed", () => {
  const files = sourceFiles(SRC);

  it("finds the source tree at all", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it("uses no character the shipped font cannot draw", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const text = code(f);
      text.split("\n").forEach((line, i) => {
        for (const ch of FALLBACK_DRAWN) {
          if (line.includes(ch)) {
            offenders.push(
              `${relative(SRC, f)}:${i + 1} U+${ch.codePointAt(0)!.toString(16).toUpperCase()} — ${line.trim().slice(0, 80)}`,
            );
          }
        }
      });
    }
    expect(
      offenders,
      "Nunito does not contain these; a fallback font draws them, differently on "
        + "every device. Use <ApprovedIcon> — the masters are on the 24x24 grid.",
    ).toEqual([]);
  });

  it("still allows the punctuation the font does contain", () => {
    // The other direction. An over-eager rule banning all non-ASCII would pass
    // the assertion above while making the copy worse.
    const all = files.map((f) => code(f)).join("\n");
    expect(all).toContain("…"); // … in placeholders and busy labels
    expect(all).toContain("—"); // — as an empty-value dash
  });
});
