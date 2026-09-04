import { expect, test, type Page } from "@playwright/test";

/**
 * Review H23. Today's contrast has been "fixed" twice and measured against the
 * wrong background both times.
 *
 * `.today-emaki__schedule` sits over a painted watercolour. It never sits on
 * flat Cream, so every ratio computed from `--sanpo-color-brand-cream` is
 * optimistic by whatever the artwork is doing underneath. The comments in
 * `components.css` claimed 3.27:1 for the "underway" stroke and 1.37:1 for the
 * base track; measured against the pixels those were 2.76:1 and 1.16:1 — both
 * wrong in the same direction, from the same method.
 *
 * So nothing here reads a token. The ink comes from the element's own computed
 * style; the backdrop comes from a SCREENSHOT of the page with that ink hidden
 * — the real pixels, watercolour and all. A token cannot be right about a
 * painting.
 *
 * The failure mode this replaces is worse than an open bug: a logged,
 * commented, confidently-reasoned ratio that is still under the floor, which
 * nobody checks again because it looks checked.
 */

const FLOOR_GRAPHIC = 3; // WCAG 1.4.11 — graphics that carry state
const FLOOR_TEXT = 4.5; // WCAG 1.4.3
const FLOOR_TEXT_LARGE = 3; // WCAG 1.4.3 — >=24px, or >=18.66px at >=700

/**
 * The backdrop is a raster, so a single centre pixel is a guess. Every pixel in
 * the element's box is measured and the worst 5% discarded: 95% of the area a
 * glyph or stroke can land on must clear the floor. Taking the outright
 * minimum would let one stray dark speck in the artwork fail a label that is
 * perfectly readable; taking the mean would hide a dark quarter.
 */
const PERCENTILE = 0.05;

type Rgb = [number, number, number];

function luminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Chromium resolves `color-mix()` to `color(srgb 0.76 0.47 0.17)` — 0..1
 * channels, not 0..255. Reading those as 8-bit values makes an amber stroke
 * look near-black and reports 16:1 for something that actually measures 2.76:1.
 * This function existed in a first draft without the `color(` branch and did
 * exactly that, which is the finding under test wearing the tester's clothes.
 */
export function parseColor(value: string): Rgb | null {
  const scale = value.trimStart().startsWith("color(") ? 255 : 1;
  const nums = value.match(/-?[\d.]+(?:e-?\d+)?/g);
  if (!nums) return null;
  // `color(srgb ...)` — drop the colour-space token if the regex caught none.
  const parts = nums.map(Number);
  if (parts.length < 3) return null;
  // An alpha below 1 makes "the ink" a composite rather than a colour, and
  // every declaration under test is opaque. Refuse rather than guess.
  if (parts.length >= 4 && parts[3] < 1) return null;
  const [r, g, b] = parts;
  return [r * scale, g * scale, b * scale];
}

/** The colour of a `text-shadow` outline, or null when there is no shadow. */
export function parseOutlineColor(textShadow: string): Rgb | null {
  if (!textShadow || textShadow === "none") return null;
  const match = textShadow.match(/(?:rgba?|color)\([^)]*\)/);
  return match ? parseColor(match[0]) : null;
}

interface Target {
  name: string;
  selector: string;
  /** `color` for text, `stroke` / `background-color` for graphics. */
  property: "color" | "stroke" | "background-color";
  /**
   * Graphics get 3:1 flat. Text derives its floor from its measured size.
   * `reference` is measured and printed but never asserted, and requires
   * `exempt` to say why — so an exemption is a sentence somebody wrote, not a
   * target quietly left off the list.
   */
  kind: "graphic" | "text" | "reference";
  exempt?: string;
  /**
   * Everything that must be invisible before the backdrop is honest. Defaults
   * to the target itself. The progress strokes overlap, so hiding one just
   * reveals the track beneath it rather than the artwork.
   */
  hide?: string;
  /**
   * This element carries a `text-shadow` outline, so its operative background
   * is its own halo rather than the artwork. The artwork is still sampled and
   * printed; the assertion is against the halo, plus a check that the halo
   * exists at all — delete the `text-shadow` and this target fails.
   */
  outlined?: true;
}

interface Sample {
  name: string;
  ink: Rgb;
  /** Worst-5%-excluded backdrop pixel inside the element's box. */
  backdrop: Rgb;
  /** The halo, for outlined text. */
  outline: Rgb | null;
  /** Against `outline` where there is one, else against `backdrop`. */
  ratio: number;
  artworkRatio: number;
  floor: number;
  fontPx: number;
  fontWeight: number;
}

function textFloor(fontPx: number, fontWeight: number): number {
  const large = fontPx >= 24 || (fontPx >= 18.66 && fontWeight >= 700);
  return large ? FLOOR_TEXT_LARGE : FLOOR_TEXT;
}

/**
 * Hide the ink, screenshot once, read every pixel of each target's box,
 * restore. The screenshot roundtrips through a canvas inside the page: Node
 * has no PNG decoder without a dependency, and the browser that painted it
 * already has one.
 */
async function sample(page: Page, targets: Target[]): Promise<Sample[]> {
  const probes = targets.map((t) => ({ selector: t.selector, property: t.property }));

  const boxes = await page.evaluate((probes) =>
    probes.map((t) => {
      const el = document.querySelector(t.selector);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        ink: style.getPropertyValue(t.property),
        textShadow: style.textShadow,
        fontPx: Number.parseFloat(style.fontSize),
        fontWeight: Number.parseFloat(style.fontWeight),
      };
    }), probes);

  const missing = targets.filter((_, i) => !boxes[i]).map((t) => `${t.name} (${t.selector})`);
  if (missing.length) throw new Error(`no element matched: ${missing.join(", ")}`);

  const hidden = [...new Set(targets.map((t) => t.hide ?? t.selector))];
  await page.evaluate((selectors: string[]) => {
    for (const s of selectors) {
      for (const el of document.querySelectorAll<HTMLElement | SVGElement>(s)) {
        el.setAttribute("data-contrast-probe", "1");
        el.style.visibility = "hidden";
      }
    }
  }, hidden);

  const shot = (await page.screenshot({ type: "png" })).toString("base64");

  const regions = await page.evaluate(
    async ({ shot, boxes, percentile }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${shot}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("no 2d context");
      ctx.drawImage(img, 0, 0);
      // The shot is in device pixels; the boxes are in CSS pixels.
      const scale = img.width / window.innerWidth;

      const lum = ([r, g, b]: number[]) => {
        const c = (v: number) => {
          const s = v / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
      };

      return boxes.map((box) => {
        if (!box) return null;
        const x = Math.max(0, Math.round(box.x * scale));
        const y = Math.max(0, Math.round(box.y * scale));
        const w = Math.min(Math.max(1, Math.round(box.width * scale)), canvas.width - x);
        const h = Math.min(Math.max(1, Math.round(box.height * scale)), canvas.height - y);
        const data = ctx.getImageData(x, y, w, h).data;
        const pixels: number[][] = [];
        for (let i = 0; i < data.length; i += 4) pixels.push([data[i], data[i + 1], data[i + 2]]);
        // Sort by luminance and take the pixel at the percentile from BOTH
        // ends, then keep whichever is closer to mid-grey — the ink can be
        // darker or lighter than the artwork, and the worst backdrop is the
        // one nearest the ink either way.
        pixels.sort((a, b) => lum(a) - lum(b));
        const lo = pixels[Math.floor((pixels.length - 1) * percentile)];
        const hi = pixels[Math.ceil((pixels.length - 1) * (1 - percentile))];
        return { lo, hi };
      });
    },
    { shot, boxes, percentile: PERCENTILE },
  );

  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>("[data-contrast-probe]")) {
      el.style.visibility = "";
      el.removeAttribute("data-contrast-probe");
    }
  });

  return targets.map((t, i) => {
    const box = boxes[i]!;
    const region = regions[i];
    if (!region) throw new Error(`${t.name}: could not sample the backdrop`);
    const ink = parseColor(box.ink);
    if (!ink) throw new Error(`${t.name}: ${t.property} is "${box.ink}" — not an opaque colour`);

    // Whichever end of the box is worse against this particular ink.
    const [worst] = [region.lo as Rgb, region.hi as Rgb].sort(
      (a, b) => contrast(ink, a) - contrast(ink, b),
    );

    const outline = t.outlined ? parseOutlineColor(box.textShadow) : null;
    if (t.outlined && !outline) {
      throw new Error(
        `${t.name}: declared outlined, but text-shadow is "${box.textShadow}". ` +
          "The halo is the only reason this text is legible over the artwork.",
      );
    }

    const floor = t.kind === "reference"
      ? 0
      : t.kind === "graphic"
      ? FLOOR_GRAPHIC
      : textFloor(box.fontPx, box.fontWeight);
    return {
      name: t.name,
      ink,
      backdrop: worst,
      outline,
      ratio: contrast(ink, outline ?? worst),
      artworkRatio: contrast(ink, worst),
      floor,
      fontPx: box.fontPx,
      fontWeight: box.fontWeight,
    };
  });
}

/** Everything on Today whose legibility is load-bearing. */
const TARGETS: Target[] = [
  {
    name: "progress: untravelled track",
    selector: ".today-emaki-progress__base",
    property: "stroke",
    kind: "reference",
    exempt:
      "The track is the container; what carries the state is the coloured " +
      "stroke drawn on it. Measured and printed every run so the number is " +
      "never guessed — its comment claimed 1.37:1 and it was 1.16:1.",
    hide: ".today-emaki-progress svg > *",
  },
  // The four progress strokes are hidden together: they overlap, so hiding
  // only the one under test reveals the track beneath it. `svg > *` and not
  // `path`, because the "you are here" marker is a <line> — with `path` it
  // sampled its own pixel and reported a serene 1.00:1.
  {
    name: "progress: travelled",
    selector: ".today-emaki-progress__complete",
    property: "stroke",
    kind: "graphic",
    hide: ".today-emaki-progress svg > *",
  },
  {
    name: "progress: underway",
    selector: ".today-emaki-progress__current",
    property: "stroke",
    kind: "graphic",
    hide: ".today-emaki-progress svg > *",
  },
  {
    name: "progress: you are here",
    selector: ".today-emaki-progress__marker",
    property: "stroke",
    kind: "graphic",
    hide: ".today-emaki-progress svg > *",
  },
  {
    name: "row accent: underway",
    selector: ".today-emaki-visit--current .today-emaki-visit__bar",
    property: "background-color",
    kind: "graphic",
  },
  {
    name: "row accent: done",
    selector: ".today-emaki-visit--completed .today-emaki-visit__bar",
    property: "background-color",
    kind: "graphic",
  },
  {
    name: "date",
    selector: ".today-emaki__date",
    property: "color",
    kind: "text",
    outlined: true,
  },
  { name: "h1", selector: ".today-emaki__schedule h1", property: "color", kind: "text" },
  { name: "summary", selector: ".today-emaki__summary", property: "color", kind: "text" },
  {
    name: "pace (On time)",
    selector: ".today-emaki-progress__copy strong",
    property: "color",
    kind: "text",
  },
  {
    name: "next visit",
    selector: ".today-emaki-progress__copy",
    property: "color",
    kind: "text",
  },
  {
    name: "row time",
    selector: ".today-emaki-visit--upcoming .today-emaki-visit__time",
    property: "color",
    kind: "text",
  },
  {
    name: "row pet name",
    selector: ".today-emaki-visit--upcoming .today-emaki-visit__identity strong",
    property: "color",
    kind: "text",
  },
  {
    name: "row route",
    selector: ".today-emaki-visit--upcoming .today-emaki-visit__identity > span",
    property: "color",
    kind: "text",
  },
  {
    name: "state: UP NEXT",
    selector: ".today-emaki-visit__state",
    property: "color",
    kind: "text",
  },
  {
    name: "state: DONE",
    selector: ".today-emaki-visit__completed",
    property: "color",
    kind: "text",
  },
];

const rgb = (c: Rgb) => `rgb(${c.map((n) => Math.round(n)).join(",")})`;

function report(samples: Sample[]): string {
  return samples
    .map((s) => {
      const on = s.outline ? `${rgb(s.outline)} halo (artwork ${s.artworkRatio.toFixed(2)}:1)` : rgb(s.backdrop);
      const verdict = s.floor === 0 ? "ref " : s.ratio >= s.floor ? "ok  " : "FAIL";
      const floor = s.floor === 0 ? "exempt" : `floor ${s.floor}`;
      return `${verdict} ${s.ratio.toFixed(2)}:1 (${floor}) ${s.name} — ${rgb(s.ink)} on ${on}`;
    })
    .join("\n");
}

// The backdrop is a raster, so the pixels under a given element genuinely
// change with viewport width. 390x844 is spec 07's reference phone; 640 is the
// field's maximum width, where the artwork's detail is coarsest.
for (const viewport of [{ width: 390, height: 844 }, { width: 640, height: 1200 }]) {
  test(`Today clears its contrast floors on the rendered backdrop at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/dev/today");
    await page.waitForSelector(".today-emaki-visit");
    // The backdrop is the whole point. Measuring before it decodes would
    // sample --emaki-paper and quietly reproduce the bug being fixed.
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>(".today-emaki__backdrop");
      return !!img && img.complete && img.naturalWidth > 0;
    });

    const samples = await sample(page, TARGETS);
    console.log(`\n${viewport.width}x${viewport.height}\n${report(samples)}`);

    // Proof that the sampler is looking at the artwork and not at a flat
    // token. If every backdrop came back identical we would be measuring the
    // same mistake with a more expensive method.
    expect(new Set(samples.map((s) => rgb(s.backdrop))).size).toBeGreaterThan(1);

    // An exemption has to be argued in the target, so `reference` cannot be
    // used to make an inconvenient number go away without leaving a sentence.
    for (const t of TARGETS) {
      if (t.kind === "reference") expect(t.exempt, `${t.name} is exempt without a reason`).toBeTruthy();
    }

    const failures = samples.filter((s) => s.floor > 0 && s.ratio < s.floor);
    expect(failures.map((f) => `${f.name} ${f.ratio.toFixed(2)}:1 < ${f.floor}`)).toEqual([]);
  });
}

for (const increasedContrast of [false, true]) {
  test(`compact Today clears rendered contrast floors${increasedContrast ? " with increased contrast" : ""}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    if (increasedContrast) await page.emulateMedia({ contrast: "more" });
    await page.goto("/dev/today?layout=compact");
    await page.getByText("Mochi", { exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    // The compact date sits on flat Cream, not a painted field. It needs no
    // halo; sample the actual background rather than invoking the baseline's
    // explicit outlined-text exception. All other targets keep their rules.
    const targets = TARGETS.map((target) => target.name === "date"
      ? { ...target, outlined: undefined }
      : target);
    const samples = await sample(page, targets);
    console.log(`\nCompact Today\n${report(samples)}`);
    const failures = samples.filter((s) => s.floor > 0 && s.ratio < s.floor);
    expect(failures.map((f) => `${f.name} ${f.ratio.toFixed(2)}:1 < ${f.floor}`)).toEqual([]);
  });
}
