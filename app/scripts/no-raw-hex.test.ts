import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `CLAUDE.md` has said "never write a raw hex in components.css" since the
 * Indigo Emaki migration, and until now nothing enforced it. Review M37 found
 * what the rule was protecting against, twice over:
 *
 *   - `--hairline: #E6E0D8` fed `--mist`, which drew the billing-ledger row
 *     separators. Measured 1.22:1 on Cream. Worse than faint: a literal is the
 *     one thing the `prefers-contrast: more` block cannot reach, so the ledger
 *     stayed invisible for exactly the users who asked for more contrast.
 *   - `.report-card__photo` kept two hexes from the retired Biscuit palette.
 *
 * A literal bypasses the palette, its high-contrast overrides and the on-tint
 * escalation from H24 all at once, and it does so silently — the colour looks
 * fine to whoever wrote it.
 */

const STYLES = join(import.meta.dirname, "..", "src", "styles");

/**
 * Custom properties permitted to hold a literal, each for a stated reason.
 *
 * An allowlist by NAME rather than a magic comment: the exemption should be a
 * decision recorded here, next to the rule, not a marker anyone can paste onto
 * a new line.
 */
const LITERAL_ALLOWED: Record<string, string> = {
  "--emaki-paper":
    "sampled from the approved Today master (mean of its bottom rows) so the "
    + "field can continue below the artwork without a seam. Not a brand colour "
    + "and deliberately not a CT-1 role — it tracks the painting, not the palette.",
};

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "vendor" ? [] : cssFiles(p);
    return e.name.endsWith(".css") ? [p] : [];
  });
}

/** Strips comments first: prose explaining a measured ratio is not a colour. */
function literalsIn(file: string): Array<{ line: number; hex: string; text: string }> {
  const stripped = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const found: Array<{ line: number; hex: string; text: string }> = [];
  stripped.split("\n").forEach((text, i) => {
    for (const m of text.matchAll(/#[0-9A-Fa-f]{3,8}\b/g)) {
      const declared = /(--[a-zA-Z0-9-]+)\s*:\s*[^;]*$/.exec(text.slice(0, m.index))?.[1];
      if (declared && declared in LITERAL_ALLOWED) continue;
      found.push({ line: i + 1, hex: m[0], text: text.trim().slice(0, 100) });
    }
  });
  return found;
}

describe("no raw hex outside the vendor palette", () => {
  const files = cssFiles(STYLES);

  it("finds the stylesheets at all", () => {
    // Vacuity guard: a wrong path passes every assertion by scanning nothing.
    expect(files.length).toBeGreaterThan(1);
    expect(files.map((f) => f.split("/").pop())).toContain("components.css");
    expect(files.map((f) => f.split("/").pop())).toContain("tokens.css");
  });

  it("has no colour literals", () => {
    const offenders = files.flatMap((f) =>
      literalsIn(f).map((o) => `${relative(STYLES, f)}:${o.line} ${o.hex} — ${o.text}`),
    );
    expect(
      offenders,
      "colour comes from CT-1 roles; a literal bypasses the palette and its "
        + "prefers-contrast overrides. Add an entry to LITERAL_ALLOWED with a "
        + "reason if an exemption is genuinely right.",
    ).toEqual([]);
  });

  it("still permits the one documented exemption", () => {
    // In the other direction: an over-eager rule that banned everything would
    // pass the assertion above and force the Today paper into the palette,
    // where it does not belong.
    const tokens = files.find((f) => f.endsWith("tokens.css"))!;
    expect(readFileSync(tokens, "utf8")).toMatch(/--emaki-paper\s*:\s*#[0-9A-Fa-f]{6}/);
    expect(literalsIn(tokens)).toEqual([]);
  });
});
