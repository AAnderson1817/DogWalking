import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Review M21. The product used only the top of a 200-1000 weight axis: of 84
 * weight declarations, none was below `body`'s 600, and all fourteen rules
 * pairing the de-emphasis colour with a weight sat at 700 or 800. So a client
 * name under a pet name, a route, a timestamp — text that is subordinate by
 * definition — rendered HEAVIER than the body text it sits under, and
 * de-emphasis fell entirely on colour and size.
 *
 * That matters beyond taste: `--sanpo-color-text-secondary` is 4.73:1 on Cream,
 * 0.23 above the AA floor, so the colour channel has nothing left to spend
 * (H24). Weight is the axis that was available and unused.
 *
 * The rule: **text painted in a de-emphasis colour is never heavier than body.**
 *
 * It scans TSX as well as CSS. A CSS-only check would have missed
 * `ScheduleEditor.tsx:117`, a 12px paused-window caption in the de-emphasis
 * colour at weight 800 — and "the grep only looked at one of the two places"
 * is a failure this repository has already recorded more than once.
 */

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel: string) => readFileSync(here(rel), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every alias that resolves to the de-emphasis role. */
const DEEMPHASIS = [
  "--sanpo-color-text-secondary",
  "--text-2",
  "--ink-700",
  "--ink-500",
  "--ink-mono",
];

const BODY_WEIGHT = 600;

/**
 * Controls are deliberately out of scope. `.segmented-control__button` and
 * `.choice-button` carry active/inactive separation in their weight, which is
 * an affordance decision rather than a text-hierarchy one; changing them is a
 * different change and needs its own argument. Named here so the exemption is
 * a sentence somebody wrote, not a silent gap.
 */
const CONTROL_EXEMPTIONS = [".segmented-control__button", ".choice-button"];

describe("the type ramp has a quiet voice", () => {
  const components = stripComments(read("../src/styles/components.css"));
  const tokens = stripComments(read("../src/styles/tokens.css"));

  it("declares the ramp tokens", () => {
    expect(tokens).toMatch(/--fw-quiet\s*:\s*500/);
    expect(tokens).toMatch(/--fw-body\s*:\s*600/);
  });

  it("no CSS rule paints a de-emphasis colour heavier than body", () => {
    const offenders: string[] = [];
    for (const match of components.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1].trim().split("\n").map((l) => l.trim()).join(" ");
      const body = match[2];
      if (!DEEMPHASIS.some((d) => body.includes(d))) continue;
      if (CONTROL_EXEMPTIONS.some((c) => selector.includes(c))) continue;
      const weight = /font-weight:\s*(\d+)/.exec(body);
      if (weight && Number(weight[1]) > BODY_WEIGHT) {
        offenders.push(`${selector} — weight ${weight[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no inline style does either", () => {
    const root = here("../src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith(".tsx")) continue;
        const text = readFileSync(full, "utf8");
        for (const match of text.matchAll(/style=\{\{([^}]*)\}\}/g)) {
          const body = match[1];
          if (!DEEMPHASIS.some((d) => body.includes(d))) continue;
          const weight = /fontWeight:\s*"?(\d+)"?/.exec(body);
          if (weight && Number(weight[1]) > BODY_WEIGHT) {
            const line = text.slice(0, match.index ?? 0).split("\n").length;
            offenders.push(`${full.slice(root.length + 1)}:${line} — weight ${weight[1]}`);
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it("actually uses the quiet weight somewhere", () => {
    // A rule nothing satisfies is a rule nothing is testing. The twelve rules
    // that moved are the reason the token exists; if they were reverted, this
    // catches it even though the rule above would still pass.
    const uses = components.match(/var\(--fw-quiet\)/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(10);
  });
});
