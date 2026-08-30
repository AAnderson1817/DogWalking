// operator-billing — POST, operator JWT (review H31).
//
// Mints the operator's own $49/month Sanpo subscription checkout, and the
// billing portal session to manage it. Platform account only: this is Sanpo
// charging the operator, so no call here carries `stripeAccount` — the
// mirror image of every client money path (review B5), asserted by
// operator_billing_test.ts.
import { HttpError, jsonOk, readJson, requireUser, serveFunction } from "../_lib/http.ts";
import { adminClient } from "../_lib/admin.ts";
import { stripeClient } from "../_lib/stripe.ts";
import { type BillingBody, handleOperatorBilling, type OperatorBillingDeps } from "./handler.ts";

const BILLING_COLUMNS =
  "id, email, business_name, trial_ends_at, platform_customer_id, platform_subscription_id, platform_subscription_status";

function makeDeps(): OperatorBillingDeps {
  const db = adminClient();
  return {
    async getOperator(id) {
      const { data, error } = await db
        .from("operators")
        .select(BILLING_COLUMNS)
        .eq("id", id)
        .maybeSingle();
      if (error) {
        throw new HttpError(500, "db_error", "operator lookup failed", error, {
          operator_id: id,
        });
      }
      return data;
    },

    async claimCustomerId(operatorId, customerId) {
      const { error } = await db
        .from("operators")
        .update({ platform_customer_id: customerId })
        .eq("id", operatorId)
        // Only claim while unclaimed: the loser of a concurrent race must
        // adopt the winner's customer, not overwrite it.
        .is("platform_customer_id", null);
      if (error) {
        throw new HttpError(500, "db_error", "failed to persist the Stripe customer", error, {
          operator_id: operatorId,
        });
      }
      const { data: after, error: readErr } = await db
        .from("operators")
        .select("platform_customer_id")
        .eq("id", operatorId)
        .maybeSingle();
      if (readErr) {
        throw new HttpError(500, "db_error", "customer re-read failed", readErr, {
          operator_id: operatorId,
        });
      }
      return (after?.platform_customer_id as string | null) ?? customerId;
    },

    stripe: stripeClient(),
    base: Deno.env.get("APP_BASE_URL") ?? "http://localhost:5173",
    now: () => Date.now(),
  };
}

serveFunction(async (req) => {
  const user = await requireUser(req);
  const body = await readJson<BillingBody>(req);
  return jsonOk(await handleOperatorBilling(user.id, body, makeDeps()));
});
