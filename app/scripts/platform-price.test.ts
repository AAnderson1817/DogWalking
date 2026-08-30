// The $49 figure exists twice on purpose — once in the app
// (src/lib/operator-access.ts, what /pricing and /signup STATE) and once in
// the edge function (supabase/functions/operator-billing/params.ts, what
// Stripe CHARGES) — because the two runtimes cannot import each other. This
// test is the bridge: a price change that misses one side shows one number
// and charges another, which is the class of silent drift the payment-status
// sets already paid for (recorded in _lib/payment_status.ts).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PLATFORM_PRICE_PENCE, TRIAL_DAYS, TRIAL_KEEP_FLOOR_MS } from "../src/lib/operator-access.js";

const REPO = resolve(__dirname, "..", "..");

function constFrom(file: string, name: string): number {
  // Accepts a literal OR simple arithmetic (48 * 60 * 60 * 1000): the RHS is
  // validated to digits/operators/whitespace before being evaluated.
  const src = readFileSync(resolve(REPO, file), "utf8");
  const m = src.match(new RegExp(`export const ${name} = ([^;]+);`));
  if (!m) throw new Error(`${name} not found in ${file} — the parity this test pins is gone`);
  const expr = m[1].trim();
  if (!/^[\d\s*+()-]+$/.test(expr)) {
    throw new Error(`${name} in ${file} is not a plain numeric expression: ${expr}`);
  }
  return new Function(`return (${expr});`)() as number;
}

describe("platform price parity", () => {
  it("the app states the figure the edge function charges", () => {
    expect(PLATFORM_PRICE_PENCE).toBe(
      constFrom("supabase/functions/operator-billing/params.ts", "OPERATOR_PRICE_PENCE"),
    );
  });

  it("the lookup key carries the same amount", () => {
    const src = readFileSync(
      resolve(REPO, "supabase/functions/operator-billing/params.ts"),
      "utf8",
    );
    const m = src.match(/OPERATOR_PRICE_LOOKUP_KEY = "([^"]+)"/);
    expect(m?.[1]).toContain(String(PLATFORM_PRICE_PENCE));
  });

  it("the trial the pages advertise is the trial the 0045 default grants", () => {
    const migration = readFileSync(
      resolve(REPO, "supabase/migrations/0045_operator_billing.sql"),
      "utf8",
    );
    expect(migration).toContain(`interval '${TRIAL_DAYS} days'`);
  });
});

describe("trial floor parity", () => {
  it("the sentence's floor equals the checkout's floor", () => {
    // Settings stops promising "your trial days are kept" exactly where the
    // edge function stops passing trial_end through — two constants in two
    // runtimes, one rule.
    const min = constFrom("supabase/functions/operator-billing/params.ts", "TRIAL_MIN_REMAINING_MS");
    const margin = constFrom(
      "supabase/functions/operator-billing/params.ts",
      "TRIAL_FLOOR_MARGIN_MS",
    );
    expect(TRIAL_KEEP_FLOOR_MS).toBe(min + margin);
  });
});
