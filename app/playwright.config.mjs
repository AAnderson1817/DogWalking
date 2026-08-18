import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

export default defineConfig({
  testDir: "./e2e",
  // The manual suite needs disposable fixtures on a real staging project and
  // is excluded from the default run (review H18). It used to sit alongside
  // the rest and skip on unset `E2E_*` variables, so it never executed and was
  // nonetheless counted as coverage. Run it explicitly:
  //   npx playwright test --config playwright.config.mjs e2e/manual/
  testIgnore: "**/manual/**",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // Opt-in escape hatch for environments that already ship a Chromium whose
    // build number does not match this @playwright/test pin (containers with a
    // preinstalled browser, air-gapped runners). Unset in CI, which downloads
    // the matching build via `playwright install`.
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
      : {}),
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run dev -- --host 127.0.0.1",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
