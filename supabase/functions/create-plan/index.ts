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
//
// The rules live in handler.ts behind injected deps (create_plan_test.ts);
// this file only wires the real Stripe client and database to them.
import { HttpError, jsonOk, readJson, requireOperator, serveFunction } from "../_lib/http.ts";
import { adminClient } from "../_lib/admin.ts";
import { stripeClient } from "../_lib/stripe.ts";
import { type CreatePlanDeps, handleCreatePlan, type PlanBody } from "./handler.ts";

function makeDeps(operatorId: string): CreatePlanDeps {
  const stripe = stripeClient();
  const db = adminClient();
  return {
    createPrice(params, opts) {
      return stripe.prices.create(params, opts);
    },
    async insertPlan(row) {
      const { data, error } = await db.from("plans").insert(row).select().single();
      if (error) {
        throw new HttpError(500, "db_error", "plan could not be saved", error, {
          operator_id: operatorId,
          stripe_price_id: row.stripe_price_id,
        });
      }
      return data;
    },
  };
}

serveFunction(async (req) => {
  const operator = await requireOperator(req);
  const body = await readJson<PlanBody>(req);
  return jsonOk(await handleCreatePlan(operator, body, makeDeps(operator.id)));
});
