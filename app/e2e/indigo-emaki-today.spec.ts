import { expect, test, type Page } from "@playwright/test";

const viewports = [
  { width: 375, height: 812 },
  { width: 430, height: 884 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
];

/** The approved plate is 875 x 1798 and must never be cropped or stretched. */
const PLATE_RATIO = 1798 / 875;

async function geometry(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
    const field = box(".today-emaki");
    const plate = box(".today-emaki__backdrop");
    const nav = box(".bottom-nav");
    const action = box(".today-emaki-current-action");
    const rows = [...document.querySelectorAll(".today-emaki-visit")].map((n) => n.getBoundingClientRect());
    return {
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      actionHeight: action?.height ?? 0,
      fieldWidth: field?.width ?? 0,
      fieldHeight: field?.height ?? 0,
      fieldBottom: field?.bottom ?? 0,
      plateRatio: plate ? plate.height / plate.width : 0,
      plateWidth: plate?.width ?? 0,
      plateBottom: plate?.bottom ?? 0,
      navTop: nav?.top ?? Number.POSITIVE_INFINITY,
      navIsBottomBar: nav ? nav.top > window.innerHeight / 2 : false,
      pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
      lastRowBottom: rows.length ? Math.max(...rows.map((r) => r.bottom)) : 0,
      rowCount: rows.length,
      viewportHeight: window.innerHeight,
      actionBottom: action?.bottom ?? 0,
      // A row is out of reach at first paint if it is below the fold, or
      // behind the fixed bottom bar. `toBeVisible` says nothing about either:
      // it passes for a row painted underneath an opaque nav.
      rowsBelowFold: rows.filter((r) => r.bottom > window.innerHeight).length,
      rowsUnderBar: nav && nav.top > window.innerHeight / 2
        ? rows.filter((r) => r.bottom > nav.top).length
        : 0,
      names: [...document.querySelectorAll(".today-emaki-visit__identity strong")].map((n) => n.textContent),
    };
  });
}

for (const viewport of viewports) {
  test(`locked Today composition at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/dev/today");

    const emaki = page.getByTestId("today-illustrated-schedule");
    await expect(emaki).toBeVisible();
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
    await expect(page.getByRole("link", { name: "End walk" })).toBeVisible();
    await expect(page.getByText("Juniper", { exact: true })).toBeVisible();
    await expect(page.getByText("Mochi", { exact: true })).toBeVisible();
    await expect(page.getByText("Luna", { exact: true })).toBeVisible();
    await expect(page.getByText("UP NEXT", { exact: true })).toBeVisible();
    await expect(page.getByText("DONE", { exact: true })).toBeVisible();
    await expect(page.getByText("Open walk", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Today's schedule", { exact: true })).toHaveCount(0);
    await expect(emaki.locator("img")).toHaveCount(1);

    const m = await geometry(page);

    expect(m.horizontalOverflow).toBe(false);
    expect(m.actionHeight).toBeGreaterThanOrEqual(44);
    expect(m.fieldWidth).toBeLessThanOrEqual(640);
    expect(m.names).toEqual(["Juniper", "Mochi", "Luna"]);
    expect(m.rowCount).toBe(3);

    // Spec 07: the component "must never crop or independently stretch the
    // illustrated scene". Asserted on the plate itself, not on the field —
    // the field is now free to be any height, and the previous version of
    // this test checked the FIELD's ratio, which said nothing about whether
    // the artwork inside it had been distorted to fit. It had been, by up to
    // 14.7% (review H28).
    expect(m.plateRatio).toBeCloseTo(PLATE_RATIO, 2);
    expect(m.plateWidth).toBeCloseTo(m.fieldWidth, 0);

    // The illustration is never cut off: the field is at least as tall as the
    // plate, and its own paper carries on below.
    expect(m.fieldHeight).toBeGreaterThanOrEqual(m.plateWidth * PLATE_RATIO - 1);

    // Review H27. An ordinary three-visit day has to land on one screen at the
    // two viewports this spec names for testing — operators schedule and bill
    // on a laptop, and an investor demo runs on one. Before the fit-to-height
    // bound, 1440x900 put `END WALK` across the fold at 853-914 and Luna
    // entirely off-screen at 935-1035, while 768x1024 ran the last row to 1035
    // against a nav whose top edge is 967. Both were red against the old CSS.
    if (viewport.width >= 768) {
      expect(m.rowsBelowFold, "a visit is below the fold at first paint").toBe(0);
      expect(m.rowsUnderBar, "a visit is behind the bottom bar").toBe(0);
      expect(m.actionBottom, "END WALK is cut off by the fold").toBeLessThanOrEqual(m.viewportHeight);
      // The bound must actually bind, rather than the field silently staying
      // 640 wide because the expression failed to parse.
      expect(m.fieldWidth).toBeLessThan(640);
    }

    const nav = page.getByRole("navigation", { name: "Primary" });
    for (const label of ["Today", "Calendar", "Clients", "Money"]) {
      await expect(nav.getByRole("link", { name: label, exact: true })).toBeVisible();
    }
    await expect(nav.getByRole("link", { name: "Today", exact: true })).toHaveClass(/bottom-nav__item--active/);
  });
}

// The defect this suite exists for. The target customer runs six to ten visits
// a day; at 390x844 the old fixed-ratio, overflow-hidden field put row six
// behind the nav, row eight below the viewport and lost five of twelve
// outright — with scrollHeight === innerHeight, so there was no scrollbar and
// no cue that anything was missing (review B8).
for (const count of [8, 12]) {
  for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 1024 }]) {
    test(`a ${count}-visit day survives at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/dev/today?visits=${count}`);
      await page.waitForSelector(".today-emaki-visit");

      const m = await geometry(page);
      expect(m.rowCount).toBe(count);
      expect(m.horizontalOverflow).toBe(false);

      // Every row is inside the field's own box — nothing is rendered past a
      // clipped edge.
      expect(m.lastRowBottom).toBeLessThanOrEqual(m.fieldBottom + 1);

      // And the page can actually reach it. This is the assertion that would
      // have failed before: the rows existed, but the document was exactly one
      // viewport tall.
      expect(m.pageScrolls).toBe(true);

      // Scrolled to the end, the last row clears the fixed nav rather than
      // sitting under it forever.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(100);
      const scrolled = await geometry(page);
      if (scrolled.navIsBottomBar) {
        expect(scrolled.lastRowBottom).toBeLessThanOrEqual(scrolled.navTop);
      }

      // The plate is still undistorted at a length the artwork was never
      // drawn for.
      expect(scrolled.plateRatio).toBeCloseTo(PLATE_RATIO, 2);
    });
  }
}

test("schedule rows are links with complete accessible labels", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dev/today");

  // Spec 05: "Clickable rows are native buttons with complete accessible
  // labels." Today shipped with six focusable elements — the inbox, End walk
  // and the four nav links — and no way to open a walk, read a visit note or
  // reach a door code (review H30).
  const row = page.getByRole("link", { name: /Mochi, 11:30, Lakeside Loop, underway/ });
  await expect(row).toHaveCount(1);
  await expect(page.getByRole("link", { name: /Juniper, 9:00, Maple Walk, done/ })).toHaveCount(1);
  await expect(page.getByRole("link", { name: /Luna, 2:00, Oak Trail, up next/ })).toHaveCount(1);

  // END WALK is its own control, not nested inside the row link.
  const endWalkInsideRow = await page.evaluate(
    () => document.querySelectorAll(".today-emaki-visit__link .today-emaki-current-action").length,
  );
  expect(endWalkInsideRow).toBe(0);
});

test("an empty day offers a way to fill it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dev/today?visits=0");

  await expect(page.getByText("No visits scheduled today.")).toBeVisible();
  // The empty state was a single sentence with no call to action, on the one
  // day that most needs one.
  await expect(page.getByRole("link", { name: "Add a walk" })).toBeVisible();
});

// A candidate must earn its space on a phone. These assertions run against
// the real shared component, rather than a separately drawn mockup.
for (const viewport of [{ width: 320, height: 740 }, ...viewports]) {
  test(`compact Today keeps the current action and three visits in view at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/dev/today?layout=compact");
    await page.getByText("Mochi", { exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    const art = await page.locator(".today-emaki__backdrop").boundingBox();
    expect(art!.height, "decorative art must fit the compact header budget").toBeLessThanOrEqual(96);
    const m = await geometry(page);
    expect(m.names).toEqual(["Juniper", "Mochi", "Luna"]);
    expect(m.horizontalOverflow).toBe(false);
    expect(m.rowsBelowFold).toBe(0);
    expect(m.rowsUnderBar).toBe(0);
    expect(m.actionHeight).toBeGreaterThanOrEqual(44);
    expect(m.actionBottom).toBeLessThanOrEqual(m.navIsBottomBar ? m.navTop : viewport.height);
    await expect(page.getByRole("link", { name: "End walk" })).toHaveAttribute("href", "/walks/walk-mochi/live");
    await expect(page.getByRole("link", { name: /Mochi, 11:30, Lakeside Loop, underway/ })).toHaveAttribute("href", "/clients/fixture-mochi");
  });
}

test("compact Today retains every visit and nav clearance with enlarged text", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/dev/today?layout=compact&visits=12");
  await page.getByText("Mochi", { exact: true }).waitFor();
  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  const m = await geometry(page);
  expect(m.rowCount).toBe(12);
  expect(m.horizontalOverflow).toBe(false);
  expect(m.pageScrolls).toBe(true);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const scrolled = await geometry(page);
  expect(scrolled.lastRowBottom).toBeLessThanOrEqual(scrolled.navTop);
});

test("compact empty day keeps its add action and can switch back to the baseline", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dev/today?layout=compact&visits=0");
  await expect(page.getByRole("link", { name: "Add a walk" })).toHaveAttribute("href", "/calendar");
  await page.goto("/dev/today");
  const art = await page.locator(".today-emaki__backdrop").boundingBox();
  expect(art!.height / art!.width).toBeCloseTo(PLATE_RATIO, 2);
});
