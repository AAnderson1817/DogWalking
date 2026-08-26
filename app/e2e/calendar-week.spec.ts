import { expect, test } from "@playwright/test";

/**
 * Review M20. Two properties of the Calendar week that only a rendered page can
 * answer, both measured against `/dev/calendar` — the same markup and classes
 * the screen uses, since Calendar itself needs a backend.
 *
 * 1. A day column has to gain something from a wider screen. Before this, the
 *    seven days measured 86.84px each at 768x1024 AND at 1440x900: widening the
 *    browser from 768 to 1440 gained the grid exactly zero pixels, because the
 *    constraint was the 640px `.page` cap, not the viewport.
 *
 * 2. A pet name has to stay inside its own day. Before this, "11:30 AM
 *    Bartholomew" painted 6.16px past its chip border and 2.16px into the
 *    NEIGHBOURING day's column at 1440x900, and 13px / 9px at 390x844.
 *
 * Numbers here are floors and containment rules rather than exact pixel
 * equalities: an exact width would fail on the next type-scale change for a
 * reason that has nothing to do with M20.
 */

const RAIL = 88;
const CAP = 1120;

test.describe("Calendar week grid", () => {
  for (const [width, height] of [
    [390, 844],
    [768, 1024],
    [1024, 768],
    [1280, 800],
    [1440, 900],
  ] as const) {
    test(`stays inside its own columns at ${width}x${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto("/dev/calendar");
      const week = page.getByTestId("calendar-week");
      await expect(week).toBeVisible();

      // Every chip's text must end inside its own day column. `getClientRects`
      // on the text range rather than the element box: the element can be
      // narrower than the text painted out of it, which is the entire defect —
      // a `toBeVisible` or a bounding-box check passes straight through it.
      const overflow = await page.evaluate(() => {
        const worst: { pet: string; pastChip: number; intoNextDay: number }[] = [];
        for (const chip of document.querySelectorAll<HTMLElement>(".calendar-walk")) {
          const day = chip.closest<HTMLElement>(".calendar-week__day");
          const summary = chip.querySelector(".calendar-walk__summary");
          if (!day || !summary) continue;
          const range = document.createRange();
          range.selectNodeContents(summary);
          const rects = [...range.getClientRects()];
          if (rects.length === 0) continue;
          const textRight = Math.max(...rects.map((r) => r.right));
          worst.push({
            pet: summary.textContent ?? "",
            pastChip: +(textRight - chip.getBoundingClientRect().right).toFixed(2),
            intoNextDay: +(textRight - day.getBoundingClientRect().right).toFixed(2),
          });
        }
        return worst;
      });

      expect(overflow.length).toBeGreaterThan(3); // the fixture has to have rendered chips
      for (const row of overflow) {
        expect(row.pastChip, `"${row.pet}" paints past its own chip`).toBeLessThanOrEqual(0);
        expect(row.intoNextDay, `"${row.pet}" paints into the next day`).toBeLessThanOrEqual(0);
      }
    });
  }

  test("a wider screen gives the week wider days", async ({ page }) => {
    const dayWidth = async (width: number, height: number) => {
      await page.setViewportSize({ width, height });
      await page.goto("/dev/calendar");
      await expect(page.getByTestId("calendar-week")).toBeVisible();
      return (await page.getByTestId("day-Mon").boundingBox())?.width ?? 0;
    };

    const narrow = await dayWidth(768, 1024);
    const wide = await dayWidth(1440, 900);
    // The cap lifts at 1024, so 768 keeps the reading measure and 1440 does not.
    expect(narrow).toBeLessThan(100);
    expect(wide).toBeGreaterThan(narrow * 1.5);
  });

  test("the wide page never overflows the document", async ({ page }) => {
    // `--page-max: min(1120px, 100% - 88px)`. The `100% - 88px` term is
    // load-bearing: with a bare 1120px, a 1024px viewport resolves max-width to
    // the full 1024 while the rail centring still subtracts 88, and the
    // document overflows by exactly the rail width — measured 1112 against
    // 1024 before it was clamped.
    for (const width of [1024, 1100, 1280, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/dev/calendar");
      // Await the element rather than reading straight after `goto`. The first
      // version did not, and paired that with `?? 0` — so a page that had not
      // rendered yet reported a left edge of 0, which is a plausible number
      // and not an obvious absence. It failed for that reason, not for a real
      // one.
      await expect(page.getByTestId("calendar-week")).toBeVisible();
      const box = await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>(".page--wide");
        if (!el) throw new Error("no .page--wide on the page");
        const rect = el.getBoundingClientRect();
        return {
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
          page: rect.width,
          left: rect.left,
        };
      });
      expect(box.scroll, `document overflows at ${width}`).toBeLessThanOrEqual(box.client);
      expect(box.page).toBeLessThanOrEqual(Math.min(CAP, width - RAIL));
      expect(box.left).toBeGreaterThanOrEqual(RAIL);
    }
  });
});
