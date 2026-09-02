// create-plan: every refusal happens BEFORE the first Stripe call, and the
// overage rate must be positive (0026's plans_overage_rate_positive; PR C
// of the spec-drift audit). The shipped check refused only `< 0`, so a
// zero-rate body minted a Stripe Price on the connected account and then
// died on the CHECK at insert — "plan could not be saved", no rule named,
// one orphaned Price per attempt. The ordering is asserted on a deps
// recorder rather than trusted from the code's shape.
import { assert, assertEquals, assertRejects } from "./asserts.ts";
import { HttpError } from "../_lib/http.ts";
import {
  type CreatePlanDeps,
  handleCreatePlan,
  OVERAGE_RATE_MESSAGE,
  type PlanBody,
  type PlanOperator,
  validatePlanBody,
} from "../create-plan/handler.ts";

const OP: PlanOperator = {
  id: "00000000-0000-4000-a000-0000000000aa",
  stripe_account_id: "acct_connected",
  stripe_charges_enabled: true,
};

const GOOD: PlanBody = {
  name: "Weekly walks",
  credits_per_cycle: 8,
  price_pence: 4000,
  cycle: "monthly",
  rollover_policy: "none",
  overage_rate_pence: 1250,
};

interface Recorded {
  call: string;
  args: unknown[];
}

function recordingDeps(opts: { insertFails?: boolean } = {}): { deps: CreatePlanDeps; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  return {
    recorded,
    deps: {
      createPrice(params, o) {
        recorded.push({ call: "prices.create", args: [params, o] });
        return Promise.resolve({ id: "price_minted" });
      },
      insertPlan(row) {
        recorded.push({ call: "plans.insert", args: [row] });
        if (opts.insertFails) {
          return Promise.reject(new HttpError(500, "db_error", "plan could not be saved"));
        }
        return Promise.resolve({ id: "plan_1", ...row });
      },
    },
  };
}

async function refused(body: PlanBody, operator: PlanOperator = OP): Promise<{ err: HttpError; recorded: Recorded[] }> {
  const { deps, recorded } = recordingDeps();
  const err = await assertRejects(() => handleCreatePlan(operator, body, deps));
  assert(err instanceof HttpError, `expected HttpError, got ${err.constructor.name}: ${err.message}`);
  return { err, recorded };
}

Deno.test("a zero overage rate is refused with the rule named, before any Stripe call", async () => {
  const { err, recorded } = await refused({ ...GOOD, overage_rate_pence: 0 });
  assertEquals(err.status, 400);
  assertEquals(err.message, OVERAGE_RATE_MESSAGE);
  assert(err.message.includes("greater than zero"), err.message);
  assertEquals(recorded, []);
});

Deno.test("a negative overage rate is still refused before any Stripe call", async () => {
  const { err, recorded } = await refused({ ...GOOD, overage_rate_pence: -1 });
  assertEquals(err.status, 400);
  assertEquals(recorded, []);
});

Deno.test("a fractional overage rate is refused (cents are whole numbers)", async () => {
  const { err, recorded } = await refused({ ...GOOD, overage_rate_pence: 12.5 });
  assertEquals(err.status, 400);
  assertEquals(recorded, []);
});

Deno.test("validatePlanBody accepts one cent (the smallest positive rate) and returns the normalised plan", () => {
  const plan = validatePlanBody({ ...GOOD, overage_rate_pence: 1, rollover_policy: "unlimited", rollover_cap: 9 });
  assertEquals(plan.overage_rate_pence, 1);
  // A cap is only meaningful for a capped policy and is dropped otherwise.
  assertEquals(plan.rollover_cap, null);
  assertEquals(plan.rollover_expiry_days, null);
});

Deno.test("every other 400 also lands before Stripe: name, credits, price, cycle, policy, cap", async () => {
  for (const body of [
    { ...GOOD, name: "  " },
    { ...GOOD, credits_per_cycle: 0 },
    { ...GOOD, price_pence: -1 },
    { ...GOOD, cycle: "daily" as unknown as "weekly" },
    { ...GOOD, rollover_policy: "sometimes" as unknown as "none" },
    { ...GOOD, rollover_policy: "capped" as const, rollover_cap: null },
  ]) {
    const { err, recorded } = await refused(body);
    assertEquals(err.status, 400, JSON.stringify(body));
    assertEquals(recorded, [], JSON.stringify(body));
  }
});

Deno.test("an operator without a connected account is refused before Stripe", async () => {
  const { err, recorded } = await refused(GOOD, { ...OP, stripe_account_id: null });
  assertEquals(err.code, "stripe_not_connected");
  assertEquals(recorded, []);
});

Deno.test("an operator whose charges are disabled is refused before Stripe", async () => {
  const { err, recorded } = await refused(GOOD, { ...OP, stripe_charges_enabled: false });
  assertEquals(err.code, "stripe_charges_disabled");
  assertEquals(recorded, []);
});

Deno.test("a valid plan mints the Price on the CONNECTED account and writes its id into the row", async () => {
  const { deps, recorded } = recordingDeps();
  const { plan } = await handleCreatePlan(OP, GOOD, deps);
  assertEquals(recorded.map((r) => r.call), ["prices.create", "plans.insert"]);
  const [params, opts] = recorded[0].args as [Record<string, unknown>, Record<string, unknown>];
  assertEquals(params.unit_amount, 4000);
  assertEquals(params.recurring, { interval: "month" });
  assertEquals(params.product_data, { name: "Weekly walks" });
  assertEquals(params.metadata, { operator_id: OP.id });
  // Every Stripe call carries the connected account — asserted over every
  // recorded call, the overage_deps rule, so a call added later is covered.
  for (const r of recorded.filter((r) => r.call.startsWith("prices."))) {
    assertEquals((r.args[1] as Record<string, unknown>).stripeAccount, "acct_connected", r.call);
  }
  const row = recorded[1].args[0] as Record<string, unknown>;
  assertEquals(row.stripe_price_id, "price_minted");
  assertEquals(row.operator_id, OP.id);
  assertEquals(row.overage_rate_pence, 1250);
  assertEquals(plan.id, "plan_1");
});

Deno.test("a weekly plan bills weekly", async () => {
  const { deps, recorded } = recordingDeps();
  await handleCreatePlan(OP, { ...GOOD, cycle: "weekly" }, deps);
  assertEquals((recorded[0].args[0] as { recurring: unknown }).recurring, { interval: "week" });
});

Deno.test("a failed insert propagates the database error and leaves the Price in place (no archive call)", async () => {
  const { deps, recorded } = recordingDeps({ insertFails: true });
  const err = await assertRejects(() => handleCreatePlan(OP, GOOD, deps));
  assert(err instanceof HttpError && err.status === 500 && err.code === "db_error", err.message);
  assertEquals(recorded.map((r) => r.call), ["prices.create", "plans.insert"]);
});
