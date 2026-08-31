import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Review M17. Three copies of one fact — the plate's candidate widths — now
 * exist: the files on disk, the generator that writes them, and the `srcset`
 * the app serves. And a fourth thing, the `sizes` attribute, restates a CSS
 * expression it cannot read at runtime.
 *
 * Every one of those pairs can drift silently. A variant on disk that no
 * `srcset` names is dead weight nobody notices; a `srcset` naming a width that
 * was never generated is a 404, which paints NOTHING because an `<img srcset>`
 * does not fall back to another candidate; and a `sizes` that stops matching
 * `--page-max` makes every device pick the wrong file while the screen still
 * looks right, so nothing would ever fail.
 */

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const COMPONENTS_CSS = read("../src/styles/components.css");
const ILLUSTRATIONS = fileURLToPath(new URL("../src/assets/illustrations", import.meta.url));

/**
 * The widths the generator declares, read out of its source.
 *
 * Parsed rather than imported: that module's whole job is to launch Chromium
 * and write files, and importing it into the test run to read one constant is
 * a hazard for the sake of a shortcut.
 */
const PLATE_MODULE = read("../src/lib/today-plate.ts");

/**
 * The widths `today-plate.ts` declares, read out of its source.
 *
 * The master's entry names the `TODAY_PLATE_WIDTH` constant rather than
 * repeating 875, so the parser resolves that one identifier from the module's
 * own declaration. A first version matched literals only and silently reported
 * three candidates where four ship — a guard that misses the one entry most
 * likely to be written symbolically is worse than none.
 */
const SERVED_WIDTHS: number[] = (() => {
  const declared = /export const TODAY_PLATE_WIDTH = (\d+);/.exec(PLATE_MODULE);
  if (!declared) throw new Error("today-plate.ts no longer declares TODAY_PLATE_WIDTH");
  const symbols: Record<string, number> = { TODAY_PLATE_WIDTH: Number(declared[1]) };
  const entries = [...PLATE_MODULE.matchAll(/\{ width: (\d+|[A-Z_]+),/g)].map((m) =>
    /^\d+$/.test(m[1]) ? Number(m[1]) : symbols[m[1]],
  );
  if (entries.some((w) => w === undefined)) {
    throw new Error("a TODAY_PLATE_CANDIDATES entry names a width this parser cannot resolve");
  }
  return entries.sort((a, b) => a - b);
})();

/** The `sizes` attribute, reassembled from the array literal that builds it. */
const SIZES: string = (() => {
  const block = /export const TODAY_PLATE_SIZES: string = \[([\s\S]*?)\]\.join\(", "\);/
    .exec(PLATE_MODULE);
  if (!block) throw new Error("TODAY_PLATE_SIZES is no longer an array literal joined with \", \"");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).join(", ");
})();

/** Kept as literals here on purpose: parsing them out of the module too would
    let the module and its guard drift together, which is no guard at all. */
const PLATE_WIDTH = 875;
const PLATE_HEIGHT = 1798;

const GENERATOR_WIDTHS: number[] = (() => {
  const source = read("./generate-today-plate-variants.mjs");
  const declaration = /export const VARIANT_WIDTHS = \[([^\]]*)\];/.exec(source);
  if (!declaration) {
    throw new Error("could not find VARIANT_WIDTHS in generate-today-plate-variants.mjs");
  }
  return declaration[1].split(",").map((n) => Number(n.trim()));
})();

/**
 * Split a `sizes` list on its TOP-LEVEL commas.
 *
 * A plain `split(", ")` cuts straight through `clamp(420px, calc(...), 640px)`
 * and hands back fragments, so every `toContain` below would then be asking a
 * question about a piece of an expression. The first draft of this file did
 * exactly that and reported the attribute as malformed when it was correct.
 */
function sizeClauses(sizes: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < sizes.length; i += 1) {
    const c = sizes[i];
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (c === "," && depth === 0) {
      out.push(sizes.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(sizes.slice(start).trim());
  return out;
}

/** `<stem>-<width>w.webp` on disk, before Vite hashes it. */
const variantWidthsOnDisk = readdirSync(ILLUSTRATIONS)
  .map((file) => /-(\d+)w\.webp$/.exec(file))
  .filter((match): match is RegExpExecArray => match !== null)
  .map((match) => Number(match[1]))
  .sort((a, b) => a - b);

describe("the Today plate's candidate set is one fact, not four", () => {
  it("generates exactly the variants that exist on disk", () => {
    expect([...GENERATOR_WIDTHS].sort((a, b) => a - b)).toEqual(variantWidthsOnDisk);
  });

  it("serves exactly the variants that exist on disk, plus the master", () => {
    expect(SERVED_WIDTHS).toEqual([...variantWidthsOnDisk, PLATE_WIDTH].sort((a, b) => a - b));
  });

  it("hash-guards every variant it ships", () => {
    // `verify:brand-assets` only checks the paths it is given, so a variant
    // added without an entry is simply never verified — the guard passes by
    // not looking, which is this repository's most-recorded failure.
    const guard = read("./verify-sanpo-assets.mjs");
    for (const width of variantWidthsOnDisk) {
      expect(
        guard,
        `the ${width}w variant is not in verify-sanpo-assets.mjs, so nothing checks it`,
      ).toContain(`sanpo-today-indigo-emaki-background-approved-v1-${width}w.webp`);
    }
  });
});

/**
 * `sizes` is resolved before layout, so it cannot ask the element how wide it
 * will be: the `--page-max` expression has to be restated in the attribute.
 * This is the guard that makes that duplication safe — it reads BOTH out of
 * `components.css` and fails when they stop agreeing.
 */
describe("the Today plate's sizes attribute mirrors --page-max", () => {
  /** The `.page.today-emaki-page` block's own `--page-max`, per breakpoint. */
  function pageMaxFor(breakpoint: "base" | "768" | "1024"): string {
    if (breakpoint === "base") {
      const block = /\.page\.today-emaki-page \{([\s\S]*?)\n\}/.exec(COMPONENTS_CSS);
      expect(block, "the base .page.today-emaki-page rule has moved or been renamed").not.toBeNull();
      const declaration = /--page-max:\s*([^;]+);/.exec(block![1]);
      expect(declaration, "the base rule no longer declares --page-max").not.toBeNull();
      return declaration![1].replace(/\s+/g, " ").trim();
    }
    const media = new RegExp(
      `@media \\(min-width: ${breakpoint}px\\) \\{([\\s\\S]*?)\\n\\}\\n`,
    ).exec(COMPONENTS_CSS);
    expect(media, `no @media (min-width: ${breakpoint}px) block for Today`).not.toBeNull();
    return media![1].replace(/\s+/g, " ").trim();
  }

  it("uses the breakpoints the stylesheet uses", () => {
    expect(SIZES).toContain("(min-width: 1024px)");
    expect(SIZES).toContain("(min-width: 768px)");
    // Order matters in `sizes`: the FIRST matching media condition wins, so a
    // 768 clause written before the 1024 one would swallow every desktop.
    expect(SIZES.indexOf("(min-width: 1024px)")).toBeLessThan(
      SIZES.indexOf("(min-width: 768px)"),
    );
  });

  it("carries the same cap, floor and plate ratio as the stylesheet", () => {
    const desktop = pageMaxFor("768");
    // The numbers the CSS clamp is built from. Read out of the stylesheet
    // rather than written here, so changing the CSS is what fails this.
    const clamp = /--page-max:\s*clamp\(\s*(\d+)px,[\s\S]*?(\d+)\s*\/\s*(\d+)\s*\),\s*(\d+)px\s*\)/
      .exec(desktop);
    expect(clamp, "the desktop --page-max is no longer a clamp(floor, ratio, cap)").not.toBeNull();
    const [, floor, ratioW, ratioH, cap] = clamp!;

    expect(ratioW).toBe(String(PLATE_WIDTH));
    expect(ratioH).toBe(String(PLATE_HEIGHT));
    for (const segment of ["(min-width: 1024px)", "(min-width: 768px)"]) {
      const clause = sizeClauses(SIZES).find((s) => s.startsWith(segment));
      expect(clause, `no sizes clause for ${segment}`).toBeDefined();
      expect(clause).toContain(`clamp(${floor}px`);
      expect(clause).toContain(`${ratioW} / ${ratioH}`);
      expect(clause).toContain(`${cap}px)`);
    }

    // Below 768 the field is simply the page: `width: 100%` capped at the same
    // number. A bare `100vw` there would over-state the width on any viewport
    // wider than the cap and pick a candidate that is too big.
    expect(sizeClauses(SIZES).at(-1)).toBe(`min(100vw, ${cap}px)`);
    expect(pageMaxFor("base")).toBe(`${cap}px`);
  });

  it("reserves the nav exactly where the stylesheet does, and nowhere else", () => {
    // The reserve is `calc(72px + env(safe-area-inset-bottom, 0px))` below
    // 1024px and 0 above it, because the desktop rail takes no vertical space.
    // `env()` cannot be resolved this early, so `sizes` uses the bare 72 — an
    // UNDER-statement, which errs toward a larger candidate. Erring large
    // costs bytes; erring small costs resolution.
    const reserve = /--today-nav-reserve:\s*calc\((\d+)px \+ env\(safe-area-inset-bottom/
      .exec(COMPONENTS_CSS);
    expect(reserve, "the nav reserve is no longer a calc(<n>px + env(...))").not.toBeNull();

    const wide = sizeClauses(SIZES).find((s) => s.startsWith("(min-width: 1024px)"))!;
    const mid = sizeClauses(SIZES).find((s) => s.startsWith("(min-width: 768px)"))!;
    expect(mid).toContain(`- ${reserve![1]}px`);
    expect(wide, "the >=1024px clause must not reserve nav space — the rail is horizontal")
      .not.toContain(`- ${reserve![1]}px`);
    expect(pageMaxFor("1024")).toContain("--today-nav-reserve: 0px");
  });
});
