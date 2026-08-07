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
      const names = [...document.querySelectorAll(".today-emaki-visit__identity strong")].map((node) => node.textContent);
      return {
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
        actionHeight: action?.height ?? 0,
        fieldWidth: field?.width ?? 0,
        fieldRatio: field ? field.height / field.width : 0,
        names,
      };
    });

    expect(metrics.horizontalOverflow).toBe(false);
    expect(metrics.actionHeight).toBeGreaterThanOrEqual(44);
    expect(metrics.fieldWidth).toBeLessThanOrEqual(640);
    expect(metrics.fieldRatio).toBeCloseTo(1798 / 875, 2);
    expect(metrics.names).toEqual(["Juniper", "Mochi", "Luna"]);

    const nav = page.getByRole("navigation", { name: "Primary" });
    for (const label of ["Today", "Calendar", "Clients", "Money"]) {
      await expect(nav.getByRole("link", { name: label, exact: true })).toBeVisible();
    }
    await expect(nav.getByRole("link", { name: "Today", exact: true })).toHaveClass(/bottom-nav__item--active/);
  });
}
