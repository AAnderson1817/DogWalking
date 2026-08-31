import { expect, test, type Browser } from "@playwright/test";

/**
 * Review M17. The Today plate ships four candidates so a device stops
 * downloading pixels it cannot paint. Whether that actually happens is decided
 * by the `sizes` attribute, and `sizes` is the one part of this change that
 * CANNOT be checked by looking at the page: a wrong value picks the wrong file
 * and the screen still looks perfect, because every candidate is the same
 * picture. Nothing else in the suite would ever go red.
 *
 * So this asserts the pick against the width the browser ACTUALLY rendered,
 * rather than against a table of expected filenames. The candidate list and
 * the layout both come from the running page, so the test keeps meaning what
 * it says when a width is added or the field's CSS changes — and it fails the
 * moment `sizes` stops describing the layout.
 *
 * The selection rule itself was verified in this Chromium before being relied
 * on here: the browser takes the smallest candidate whose `w` descriptor is at
 * least the CSS width times the device pixel ratio, and the largest candidate
 * when none of them reaches it.
 */

/** Viewports spec 07 names for testing, plus the phone widths in its table. */
const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 430, height: 884 },
  { width: 768, height: 1024 },
  { width: 1024, height: 1366 },
  { width: 1440, height: 900 },
];
/** 1 is every non-retina laptop and desktop; 2 and 3 are the phones. */
const RATIOS = [1, 2, 3];

interface Pick {
  picked: string;
  candidates: { url: string; width: number }[];
  cssWidth: number;
}

async function plate(browser: Browser, viewport: { width: number; height: number }, dpr: number) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: dpr });
  try {
    const page = await context.newPage();
    await page.goto("/dev/today");
    await page.waitForSelector(".today-emaki__backdrop");
    // `currentSrc` is only settled once the browser has chosen and started the
    // load; without this the first read can be the bare `src`.
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>(".today-emaki__backdrop");
      return Boolean(img && img.currentSrc);
    });
    return await page.evaluate((): Pick => {
      const img = document.querySelector<HTMLImageElement>(".today-emaki__backdrop")!;
      return {
        picked: img.currentSrc,
        candidates: img.srcset.split(",").map((entry) => {
          const [url, descriptor] = entry.trim().split(/\s+/);
          return { url: new URL(url, location.href).href, width: Number(descriptor.replace("w", "")) };
        }),
        cssWidth: img.getBoundingClientRect().width,
      };
    });
  } finally {
    await context.close();
  }
}

for (const viewport of VIEWPORTS) {
  for (const dpr of RATIOS) {
    test(`the plate picked at ${viewport.width}x${viewport.height} @${dpr}x covers what it paints`, async ({
      browser,
    }) => {
      const { picked, candidates, cssWidth } = await plate(browser, viewport, dpr);

      expect(candidates.length, "the plate is not offering candidates at all").toBeGreaterThan(1);
      const needed = Math.ceil(cssWidth * dpr);
      const sorted = [...candidates].sort((a, b) => a.width - b.width);
      const expected = sorted.find((c) => c.width >= needed) ?? sorted[sorted.length - 1];

      expect(
        picked,
        `renders ${cssWidth}px at ${dpr}x (needs ${needed}px) but fetched ${picked.split("/").pop()}`,
      ).toBe(expected.url);
    });
  }
}

test("a DPR-1 desktop is not served the full-size master", async ({ browser }) => {
  // The defect in one sentence: at 1440x900 the field is 438px wide and DPR 1,
  // so 438 device pixels are painted — and the browser was downloading all 875.
  // This is the case the change exists for, so it is asserted directly rather
  // than only through the rule above, which a broken `sizes` could satisfy by
  // making every candidate "correct" for a wrong width.
  const { picked, candidates, cssWidth } = await plate(browser, { width: 1440, height: 900 }, 1);
  const widest = [...candidates].sort((a, b) => b.width - a.width)[0];

  expect(cssWidth).toBeLessThan(500);
  expect(picked, "the desktop still downloads the full plate").not.toBe(widest.url);
});

test("every candidate the page offers actually exists", async ({ browser }) => {
  // A 404 candidate is the worst outcome available here: the browser does NOT
  // fall back to another entry, it renders nothing at all. Measured in this
  // Chromium — a picked candidate that 404s leaves naturalWidth at 0.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await page.goto("/dev/today");
    await page.waitForSelector(".today-emaki__backdrop");
    const urls = await page.evaluate(() => {
      const img = document.querySelector<HTMLImageElement>(".today-emaki__backdrop")!;
      return img.srcset.split(",").map((e) => new URL(e.trim().split(/\s+/)[0], location.href).href);
    });
    expect(urls.length).toBeGreaterThan(1);
    for (const url of urls) {
      const response = await page.request.get(url);
      expect(response.status(), `${url} is named in srcset but does not exist`).toBe(200);
    }

    // And the one the browser chose really decoded, rather than silently
    // failing to a blank field.
    const decoded = await page.evaluate(() => {
      const img = document.querySelector<HTMLImageElement>(".today-emaki__backdrop")!;
      return { naturalWidth: img.naturalWidth, ratio: img.naturalHeight / img.naturalWidth };
    });
    expect(decoded.naturalWidth).toBeGreaterThan(0);
    // Every candidate is the same composition: a variant whose ratio drifted
    // would distort the locked plate at exactly one breakpoint.
    expect(decoded.ratio).toBeCloseTo(1798 / 875, 2);
  } finally {
    await context.close();
  }
});
