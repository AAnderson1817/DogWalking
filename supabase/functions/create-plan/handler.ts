// create-plan decision logic (review B6), dependency-injected for tests.
//
// Everything that decides whether a plan may be minted lives here, behind a
// seam, because `index.ts` binds a port on import and so nothing in it could
// be driven by a test — the blind spot that hid two defects in
// send-notification's deps and one in overage_deps. The rule this file
// exists for (PR C of the spec-drift audit): a plan's overage rate must be
// POSITIVE. 0026 enforces `plans_overage_rate_positive` (`> 0`) and the
// owner's decision behind it is that an overage rate of 0 is invalid — a
// walk credits cannot cover is charged in full at that rate, and "in full
// at nothing" is a silent free walk, not a price. The shipped check refused
// only `< 0`, so a zero-rate body passed validation, minted the Stripe Price
// on the operator's connected account, and THEN hit the CHECK on insert:
// the operator saw "plan could not be saved" with no rule named, and the
// Price was left orphaned on every attempt. The order below is the fix as
// much as the predicate: every refusal happens before the first Stripe call.
import { type ConnectFields, HttpError, requireAccount } from "../_lib/http.ts";

export interface PlanBody {
  name?: string;
  credits_per_cycle?: number;
  price_pence?: number;
  cycle?: "weekly" | "monthly";
  rollover_policy?: "none" | "capped" | "unlimited";
  rollover_cap?: number | null;
  rollover_expiry_days?: number | null;
  overage_rate_pence?: number;
}

/** A body every rule has accepted; the only shape that reaches Stripe. */
export interface ValidPlan {
  name: string;
  credits_per_cycle: number;
  price_pence: number;
  cycle: "weekly" | "monthly";
  rollover_policy: "none" | "capped" | "unlimited";
  rollover_cap: number | null;
  rollover_expiry_days: number | null;
  overage_rate_pence: number;
}

const CYCLES = new Set(["weekly", "monthly"]);
const POLICIES = new Set(["none", "capped", "unlimited"]);

export const OVERAGE_RATE_MESSAGE =
  "overage rate must be a whole number of cents greater than zero — a walk credits cannot cover is charged in full at this rate, and a rate of zero is a free walk, not a price";

/**
 * The pure half: every 400 this function can answer, in order, with a
 * sentence naming the rule rather than a constraint name. Mirrors the CHECKs
 * on `plans` (plans_capped_requires_cap, plans_overage_rate_positive) so the
 * database is the backstop and never the first thing the operator hears.
 */
export function validatePlanBody(body: PlanBody | null): ValidPlan {
  const name = body?.name?.trim();
  if (!name) throw new HttpError(400, "bad_request", "name is required");
  if (!Number.isInteger(body?.credits_per_cycle) || (body!.credits_per_cycle as number) <= 0) {
    throw new HttpError(400, "bad_request", "credits_per_cycle must be a positive whole number");
  }
  if (!Number.isInteger(body?.price_pence) || (body!.price_pence as number) < 0) {
    throw new HttpError(400, "bad_request", "price must be a whole number of cents");
  }
  if (!CYCLES.has(String(body?.cycle))) {
    throw new HttpError(400, "bad_request", "cycle must be weekly or monthly");
  }
  if (!POLICIES.has(String(body?.rollover_policy))) {
    throw new HttpError(400, "bad_request", "rollover_policy must be none, capped or unlimited");
  }
  if (body?.rollover_policy === "capped" && !Number.isInteger(body?.rollover_cap)) {
    throw new HttpError(400, "bad_request", "a capped plan needs a rollover cap");
  }
  // `> 0`, not `>= 0`: the 0026 rule. A zero here used to reach Stripe.
  if (!Number.isInteger(body?.overage_rate_pence) || (body!.overage_rate_pence as number) <= 0) {
    throw new HttpError(400, "bad_request", OVERAGE_RATE_MESSAGE);
  }
  return {
    name,
    credits_per_cycle: body!.credits_per_cycle as number,
    price_pence: body!.price_pence as number,
    cycle: body!.cycle as "weekly" | "monthly",
    rollover_policy: body!.rollover_policy as "none" | "capped" | "unlimited",
    rollover_cap: body?.rollover_policy === "capped" ? (body?.rollover_cap ?? null) : null,
    rollover_expiry_days: body?.rollover_expiry_days ?? null,
    overage_rate_pence: body!.overage_rate_pence as number,
  };
}

export interface PriceParams {
  currency: "usd";
  unit_amount: number;
  recurring: { interval: "week" | "month" };
  product_data: { name: string };
  metadata: { operator_id: string };
}

export type PlanInsert = ValidPlan & { operator_id: string; stripe_price_id: string };

export interface CreatePlanDeps {
  /** stripe.prices.create on the operator's CONNECTED account (review B5):
   * the second argument is Stripe's per-request options and must carry the
   * account, asserted over every recorded call by create_plan_test.ts. */
  createPrice(params: PriceParams, opts: { stripeAccount: string }): Promise<{ id: string }>;
  /** Inserts the row and returns it; throws HttpError(500, db_error) on a
   * database failure. The Price is already live by then and is deliberately
   * left in place — an orphan nothing references is inert and free, whereas
   * archiving it on a transient error would strand a retry into a second one. */
  insertPlan(row: PlanInsert): Promise<Record<string, unknown>>;
}

export interface PlanOperator extends ConnectFields {
  id: string;
}

export async function handleCreatePlan(
  operator: PlanOperator,
  body: PlanBody | null,
  deps: CreatePlanDeps,
): Promise<{ plan: Record<string, unknown> }> {
  const plan = validatePlanBody(body);
  // Refused BEFORE anything is created. A plan with no Price is unusable, and
  // a half-made plan is worse than none — the operator would see it in the
  // list and have no way to tell why checkout fails.
  const account = requireAccount(operator);
  const price = await deps.createPrice({
    currency: "usd",
    unit_amount: plan.price_pence,
    recurring: { interval: plan.cycle === "weekly" ? "week" : "month" },
    product_data: { name: plan.name },
    metadata: { operator_id: operator.id },
  }, account);
  const row = await deps.insertPlan({ ...plan, operator_id: operator.id, stripe_price_id: price.id });
  return { plan: row };
}
