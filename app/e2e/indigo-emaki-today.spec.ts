import { expect, test } from "@playwright/test";

const viewports = [
  { width: 375, height: 812 },
  { width: 430, height: 884 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
];

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

    const metrics = await page.evaluate(() => {
      const action = document.querySelector(".today-emaki-current-action")?.getBoundingClientRect();
      const field = document.querySelector(".today-emaki")?.getBoundingClientRect();
      const nav = document.querySelector(".bottom-nav")?.getBoundingClientRect();
      const rows = [...document.querySelectorAll(".today-emaki-visit")].map((n) => n.getBoundingClientRect());
      const names = [...document.querySelectorAll(".today-emaki-visit__identity strong")].map((node) => node.textContent);
      return {
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
        actionHeight: action?.height ?? 0,
        fieldWidth: field?.width ?? 0,
        fieldHeight: field?.height ?? 0,
        fieldRatio: field ? field.height / field.width : 0,
        viewportHeight: window.innerHeight,
        navTop: nav?.top ?? Number.POSITIVE_INFINITY,
        navIsBottomBar: nav ? nav.top > window.innerHeight / 2 : false,
        fieldBottom: field?.bottom ?? 0,
        pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
        lastRowBottom: rows.length ? Math.max(...rows.map((r) => r.bottom)) : 0,
        rowCount: rows.length,
        names,
      };
    });

    expect(metrics.horizontalOverflow).toBe(false);
    expect(metrics.actionHeight).toBeGreaterThanOrEqual(44);
    expect(metrics.fieldWidth).toBeLessThanOrEqual(640);
    expect(metrics.names).toEqual(["Juniper", "Mochi", "Luna"]);

    // The field's aspect contract, as actually built. The artwork ratio is a
    // FLOOR, not a fixed value: on a viewport taller than 875:1798 the field
    // fills the remainder so the painted bottom border meets the screen edge
    // instead of leaving a strip of bare Cream (components.css, the bounded
    // `min-height: 100dvh` media query). Two bounds, because both directions
    // are defects — squashing crops the composition, and an unbounded stretch
    // distorts it.
    const NATURAL = 1798 / 875;
    expect(metrics.fieldRatio).toBeGreaterThanOrEqual(NATURAL - 0.01); // never squashed
    expect(metrics.fieldRatio).toBeLessThanOrEqual(NATURAL * 1.15 + 0.01); // stretch stays bounded
    if (metrics.fieldRatio > NATURAL + 0.01) {
      // When it is filling, it fills exactly — a partial fill would be the
      // bare-Cream strip coming back.
      expect(Math.abs(metrics.fieldHeight - metrics.viewportHeight)).toBeLessThanOrEqual(1);
    }

    // Geometry, not visibility. `toBeVisible` passes for a row clipped by the
    // field's `overflow: hidden` or sitting behind the fixed nav, which is
    // exactly how the schedule can silently lose its afternoon (review B8).
    expect(metrics.rowCount).toBe(3);

    // Never clipped by the field box. This is the B8 condition and it holds at
    // every viewport: a row rendered past the bottom of a fixed-ratio,
    // overflow-hidden field is gone, with no scrollbar to reveal it.
    expect(metrics.lastRowBottom).toBeLessThanOrEqual(metrics.fieldBottom + 1);

    // Behind the fixed bottom bar is only a defect when there is nowhere to
    // scroll to. Where the page scrolls, the row is reachable; where the nav
    // is a left rail (desktop), the comparison is meaningless.
    if (!metrics.pageScrolls && metrics.navIsBottomBar) {
      expect(metrics.lastRowBottom).toBeLessThanOrEqual(metrics.navTop);
    }

    const nav = page.getByRole("navigation", { name: "Primary" });
    for (const label of ["Today", "Calendar", "Clients", "Money"]) {
      await expect(nav.getByRole("link", { name: label, exact: true })).toBeVisible();
    }
    await expect(nav.getByRole("link", { name: "Today", exact: true })).toHaveClass(/bottom-nav__item--active/);
  });
}
