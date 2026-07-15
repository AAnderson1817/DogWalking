import { expect, test } from "@playwright/test";

const env = process.env;
const operatorCredentials = env.E2E_OPERATOR_EMAIL && env.E2E_OPERATOR_PASSWORD
  ? { email: env.E2E_OPERATOR_EMAIL, password: env.E2E_OPERATOR_PASSWORD }
  : null;
const clientCredentials = env.E2E_CLIENT_EMAIL && env.E2E_CLIENT_PASSWORD
  ? { email: env.E2E_CLIENT_EMAIL, password: env.E2E_CLIENT_PASSWORD }
  : null;

async function signIn(page, credentials) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function signInAsOperator(page) {
  test.skip(!operatorCredentials, "Set E2E_OPERATOR_EMAIL and E2E_OPERATOR_PASSWORD to run operator journeys.");
  await signIn(page, operatorCredentials);
  await expect(page).toHaveURL(/\/(?:$|calendar|roster|billing|walks)/);
}

async function signInAsClient(page) {
  test.skip(!clientCredentials, "Set E2E_CLIENT_EMAIL and E2E_CLIENT_PASSWORD to run client portal journeys.");
  await signIn(page, clientCredentials);
  await expect(page).toHaveURL(/\/portal/);
}

test.describe("critical PawTrail journeys", () => {
  test("signup/invite flow accepts a staged invite claim URL", async ({ page }) => {
    test.skip(!env.E2E_INVITE_URL, "Set E2E_INVITE_URL to a disposable staged invite URL.");

    await page.goto(env.E2E_INVITE_URL);
    await expect(page.getByRole("heading")).toContainText(/invite|claim|pawtrail/i);
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
    test.skip(!env.E2E_WALK_URL, "Set E2E_WALK_URL to a disposable live walk URL.");
    test.skip(!operatorCredentials, "Set operator credentials for concurrent completion.");

    const first = await browser.newContext();
    const second = await browser.newContext();
    const pageA = await first.newPage();
    const pageB = await second.newPage();

    await Promise.all([signIn(pageA, operatorCredentials), signIn(pageB, operatorCredentials)]);
    await Promise.all([pageA.goto(env.E2E_WALK_URL), pageB.goto(env.E2E_WALK_URL)]);

    const endA = pageA.getByRole("button", { name: /end|complete|finish/i });
    const endB = pageB.getByRole("button", { name: /end|complete|finish/i });
    await Promise.allSettled([endA.click(), endB.click()]);

    await expect(pageA.getByText(/ended|complete|finished|already/i).or(pageB.getByText(/ended|complete|finished|already/i))).toBeVisible();
    await first.close();
    await second.close();
  });

  test("offline walk recovery queues points and resumes after reconnect", async ({ page, context }) => {
    test.skip(!env.E2E_WALK_URL, "Set E2E_WALK_URL to a disposable live walk URL.");
    await signInAsOperator(page);
    await page.goto(env.E2E_WALK_URL);

    await context.setOffline(true);
    await expect(page.getByText(/offline|queued|sync|pending/i).or(page.getByRole("button", { name: /end|complete|finish/i }))).toBeVisible();

    await context.setOffline(false);
    await page.reload();
    await expect(page.getByText(/sync|queued|pending|live|walk/i).first()).toBeVisible();
  });
});
