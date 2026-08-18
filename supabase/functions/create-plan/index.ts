// create-plan — POST, operator JWT (review B6).
//
// A plan row without a stripe_price_id cannot be checked out, and asking the
// operator to paste a `price_…` was the activation path the review called "a
// consulting engagement, not a product". This mints the Stripe Product and
// Price and writes the row with the resulting id, so creating a plan is one
// action rather than a trip through the Stripe dashboard.
//
// The Price is created on the operator's CONNECTED account (review B5) — they
// are the merchant of record, and a price on the platform account simply does
// not exist from the connected account's point of view, so checkout would
// fail later on an id that looks entirely valid.
import {
  HttpError,
  jsonOk,
  readJson,
  requireAccount,
  requireOperator,
  serveFunction,
} from "../_lib/http.ts";
import { adminClient } from "../_lib/admin.ts";
import { stripeClient } from "../_lib/stripe.ts";

interface Body {
  name?: string;
  credits_per_cycle?: number;
  price_pence?: number;
  cycle?: "weekly" | "monthly";
  rollover_policy?: "none" | "capped" | "unlimited";
  rollover_cap?: number | null;
  rollover_expiry_days?: number | null;
  overage_rate_pence?: number;
}

const CYCLES = new Set(["weekly", "monthly"]);
const POLICIES = new Set(["none", "capped", "unlimited"]);

serveFunction(async (req) => {
  const operator = await requireOperator(req);
  const body = await readJson<Body>(req);

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
  // Mirrors plans_capped_requires_cap. Checked here too so the operator gets a
  // sentence instead of a constraint name.
  if (body?.rollover_policy === "capped" && !Number.isInteger(body?.rollover_cap)) {
    throw new HttpError(400, "bad_request", "a capped plan needs a rollover cap");
  }
  if (!Number.isInteger(body?.overage_rate_pence) || (body!.overage_rate_pence as number) < 0) {
    throw new HttpError(400, "bad_request", "overage rate must be a whole number of cents");
  }

  // Refused BEFORE anything is created. A plan with no Price is unusable, and
  // a half-made plan is worse than none — the operator would see it in the
  // list and have no way to tell why checkout fails.
  const account = requireAccount(operator);

  const stripe = stripeClient();
  const price = await stripe.prices.create({
    currency: "usd",
    unit_amount: body!.price_pence as number,
    recurring: { interval: body!.cycle === "weekly" ? "week" : "month" },
    product_data: { name },
    metadata: { operator_id: operator.id },
  }, account);

  const db = adminClient();
  const { data, error } = await db
    .from("plans")
    .insert({
      operator_id: operator.id,
      name,
      credits_per_cycle: body!.credits_per_cycle as number,
      price_pence: body!.price_pence as number,
      cycle: body!.cycle,
      rollover_policy: body!.rollover_policy,
      rollover_cap: body?.rollover_policy === "capped" ? body?.rollover_cap ?? null : null,
      rollover_expiry_days: body?.rollover_expiry_days ?? null,
      overage_rate_pence: body!.overage_rate_pence as number,
      stripe_price_id: price.id,
    })
    .select()
    .single();
  // The Price is already live at this point. Left in place deliberately: an
  // orphaned Stripe Price nothing references is inert and free, whereas
  // archiving it on a transient DB error would strand a retry that then
  // creates a second one.
  if (error) {
    throw new HttpError(500, "db_error", "plan could not be saved", error, {
      operator_id: operator.id,
      stripe_price_id: price.id,
    });
  }

  return jsonOk({ plan: data });
});
