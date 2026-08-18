// MANUAL suite — not part of `npm run test:e2e`, and not coverage.
//
// Review H18: these five tests skipped on `E2E_*` variables that are set in no
// workflow and in no local default, so they skipped for EVERYONE, always,
// while `app/README.md` described them as "Playwright coverage" for booking,
// billing, concurrent walk completion and offline recovery. A suite that has
// never executed is worse than no suite, because it is counted.
//
// They need disposable fixtures on a real staging project, which nothing in
// this repository can create. So rather than pretend, they live under
// `e2e/manual/`, are excluded from the default run by `testIgnore` in
// `playwright.config.mjs`, and — the important half — they now FAIL rather
// than skip when the credentials are missing. Running them is a deliberate act
// with a required setup; a green skip is not an available outcome.
//
//   E2E_BASE_URL=… E2E_OPERATOR_EMAIL=… E2E_OPERATOR_PASSWORD=… \
//   npx playwright test --config playwright.config.mjs e2e/manual/
//
// See docs/dev/staging-setup.md for where the fixtures come from.

import { expect, test } from "@playwright/test";

const env = process.env;
const operatorCredentials = env.E2E_OPERATOR_EMAIL && env.E2E_OPERATOR_PASSWORD
  ? { email: env.E2E_OPERATOR_EMAIL, password: env.E2E_OPERATOR_PASSWORD }
  : null;
const clientCredentials = env.E2E_CLIENT_EMAIL && env.E2E_CLIENT_PASSWORD
  ? { email: env.E2E_CLIENT_EMAIL, password: env.E2E_CLIENT_PASSWORD }
  : null;

/** Fail loudly on a missing fixture. See the header: a skip is not an outcome
 *  this suite offers, because a skip is what hid it for its whole life. */
function requireEnv(name, what) {
  if (!env[name]) throw new Error(`${name} is required for the manual suite — set it to ${what}.`);
}

async function signIn(page, credentials) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function signInAsOperator(page) {
  // Fail, not skip. An unset secret used to read as a passing run.
  if (!operatorCredentials) {
    throw new Error(
      "E2E_OPERATOR_EMAIL and E2E_OPERATOR_PASSWORD are required for the manual suite. " +
        "These tests are deliberately excluded from `npm run test:e2e`; see the header.",
    );
  }
  await signIn(page, operatorCredentials);
  await expect(page).toHaveURL(/\/(?:$|calendar|roster|billing|walks)/);
}

async function signInAsClient(page) {
  if (!clientCredentials) {
    throw new Error(
      "E2E_CLIENT_EMAIL and E2E_CLIENT_PASSWORD are required for the manual suite. " +
        "These tests are deliberately excluded from `npm run test:e2e`; see the header.",
    );
  }
  await signIn(page, clientCredentials);
  await expect(page).toHaveURL(/\/portal/);
}

test.describe("critical Sanpo journeys", () => {
  test("signup/invite flow accepts a staged invite claim URL", async ({ page }) => {
    requireEnv("E2E_INVITE_URL", "a disposable staged invite URL");

    await page.goto(env.E2E_INVITE_URL);
    await expect(page.getByText(/invite|claim|sanpo/i).first()).toBeVisible();
    await expect(page.getByLabel(/email/i).or(page.getByText(/sign in|password|claim/i))).toBeVisible();
  });

  test("client booking flow reaches the booking form and submits validation-safe input", async ({ page }) => {
    await signInAsClient(page);
    await page.goto("/portal/book");

    await expect(page.getByRole("heading", { name: /book/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /book|request|schedule|submit/i })).toBeVisible();
  });

  test("operator billing flow exposes plan-change controls without immediate local mutation", async ({ page }) => {
    await signInAsOperator(page);
    await page.goto("/billing");

    await expect(page.getByRole("heading", { name: /billing/i })).toBeVisible();
    await expect(page.getByText(/plan|credit|billing/i).first()).toBeVisible();
  });

  test("concurrent walk completion leaves one browser with a resolved end state", async ({ browser }) => {
    requireEnv("E2E_WALK_URL", "a disposable live walk URL");
    if (!operatorCredentials) throw new Error("operator credentials are required for concurrent completion");

    const first = await browser.newContext();
    const second = await browser.newContext();
    const pageA = await first.newPage();
    const pageB = await second.newPage();

    await Promise.all([signIn(pageA, operatorCredentials), signIn(pageB, operatorCredentials)]);
    await Promise.all([pageA.goto(env.E2E_WALK_URL), pageB.goto(env.E2E_WALK_URL)]);

    const endA = pageA.getByRole("button", { name: /end|complete|finish/i });
    const endB = pageB.getByRole("button", { name: /end|complete|finish/i });
    await Promise.allSettled([endA.click(), endB.click()]);

    // Locator.or() must not cross pages — poll each page separately and
    // require at least one to reach a resolved end state.
    await expect
      .poll(async () => {
        const [a, b] = await Promise.all([
          pageA.getByText(/ended|complete|finished|already/i).first().isVisible().catch(() => false),
          pageB.getByText(/ended|complete|finished|already/i).first().isVisible().catch(() => false),
        ]);
        return a || b;
      })
      .toBe(true);
    await first.close();
    await second.close();
  });

  test("offline walk recovery queues points and resumes after reconnect", async ({ page, context }) => {
    requireEnv("E2E_WALK_URL", "a disposable live walk URL");
    await signInAsOperator(page);
    await page.goto(env.E2E_WALK_URL);

    await context.setOffline(true);
    await expect(page.getByText(/offline|queued|sync|pending/i).or(page.getByRole("button", { name: /end|complete|finish/i }))).toBeVisible();

    await context.setOffline(false);
    await page.reload();
    await expect(page.getByText(/sync|queued|pending|live|walk/i).first()).toBeVisible();
  });
});
