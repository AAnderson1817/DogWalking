import { expect, test } from "@playwright/test";

/**
 * Review H24, checked against the rendered product rather than against the
 * token model.
 *
 * `src/styles/role-contrast.test.ts` proves the token arithmetic: every CT-1
 * text role clears 4.5:1 on every CT-1 tint via its `-on-tint` variant, and
 * every rule that paints a tint is in the escalation list. Both of those are
 * statements about the stylesheet.
 *
 * This is the statement about the browser: walk the component gallery, find
 * every element actually painting one of the five tints, and check every piece
 * of text inside it against the pixels it is on. It catches what the model
 * cannot — a component that hardcodes a colour, an escalation that does not
 * inherit for a reason nobody predicted, a `color` set by an inline style.
 */

const TINTS = [
  "--sanpo-color-surface-attention",
  "--sanpo-color-surface-information",
  "--sanpo-color-surface-success",
  "--sanpo-color-surface-relationship",
  "--sanpo-color-surface-milestone",
];

test("every text on a CT-1 tint clears its contrast floor", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 1200 });
  await page.goto("/dev/kit");
  await page.waitForSelector(".walk-card");

  const findings = await page.evaluate((tintNames: string[]) => {
    const parse = (value: string): [number, number, number] | null => {
      const nums = value.match(/-?[\d.]+/g);
      if (!nums || nums.length < 3) return null;
      if (nums.length >= 4 && Number(nums[3]) < 1) return null;
      const scale = value.trimStart().startsWith("color(") ? 255 : 1;
      return [Number(nums[0]) * scale, Number(nums[1]) * scale, Number(nums[2]) * scale];
    };
    const lum = ([r, g, b]: number[]) => {
      const c = (v: number) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
    };
    const ratio = (a: number[], b: number[]) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };

    // Resolved through a probe element rather than by reading the custom
    // property: `getPropertyValue` hands back whatever form the token is
    // written in — `#F2D7CC` here, `color-mix(…)` elsewhere — while
    // `backgroundColor` is always a resolved `rgb()`. Reading the property
    // directly is what the first draft did, and a hex string fed to a
    // number-matching parser yields rgb(2,7,0) from "#F2D7CC". The vacuity
    // guard below is what caught it.
    const probe = document.createElement("div");
    probe.style.position = "fixed";
    probe.style.pointerEvents = "none";
    document.body.append(probe);
    const tints = new Map<string, string>();
    for (const name of tintNames) {
      probe.style.backgroundColor = `var(${name})`;
      const resolved = parse(getComputedStyle(probe).backgroundColor);
      if (resolved) tints.set(resolved.map(Math.round).join(","), name);
    }
    probe.remove();

    const out: {
      tint: string;
      selector: string;
      text: string;
      color: string;
      ratio: number;
      floor: number;
    }[] = [];

    for (const el of document.querySelectorAll<HTMLElement>("*")) {
      const bg = parse(getComputedStyle(el).backgroundColor);
      if (!bg) continue;
      const tint = tints.get(bg.map(Math.round).join(","));
      if (!tint) continue;

      // Every descendant that renders its own text directly, plus the element
      // itself. A child that paints its own opaque background is skipped along
      // with its subtree — it is no longer on the tint.
      const walk = (node: HTMLElement) => {
        for (const child of node.children) {
          const c = child as HTMLElement;
          const childBg = parse(getComputedStyle(c).backgroundColor);
          if (childBg && !tints.has(childBg.map(Math.round).join(","))) continue;
          walk(c);
        }
        const own = [...node.childNodes]
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent?.trim() ?? "")
          .join(" ")
          .trim();
        if (!own) return;
        const style = getComputedStyle(node);
        if (style.visibility === "hidden" || style.display === "none") return;
        const color = parse(style.color);
        if (!color) return;
        const px = Number.parseFloat(style.fontSize);
        const weight = Number.parseFloat(style.fontWeight);
        const floor = px >= 24 || (px >= 18.66 && weight >= 700) ? 3 : 4.5;
        const r = ratio(color, bg);
        if (r < floor) {
          out.push({
            tint,
            selector: node.className || node.tagName.toLowerCase(),
            text: own.slice(0, 40),
            color: style.color,
            ratio: Number(r.toFixed(2)),
            floor,
          });
        }
      };
      walk(el);
    }
    return { findings: out, tintsFound: [...tints.values()] };
  }, TINTS);

  // If the gallery paints no tints, the assertion below passes vacuously and
  // proves nothing — the shape of failure this repository keeps finding.
  expect(findings.tintsFound.length, "the gallery paints no CT-1 tints").toBeGreaterThan(2);

  expect(findings.findings).toEqual([]);
});
