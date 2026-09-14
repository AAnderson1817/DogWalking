// connect-onboarding — POST, operator JWT (review B5).
//
// Creates and resumes the operator's Stripe Connect *Standard* account (the
// reasoning is in handler.ts). The rules live there behind injected deps
// (connect_onboarding_test.ts); this file only wires the real Stripe client
// and database to them.
import {
  HttpError,
  jsonOk,
  readJson,
  requireOperator,
  serveFunction,
} from "../_lib/http.ts";
import { adminClient } from "../_lib/admin.ts";
import { stripeClient } from "../_lib/stripe.ts";
import {
  type ConnectBody,
  type ConnectOnboardingDeps,
  handleConnectOnboarding,
} from "./handler.ts";

function makeDeps(): ConnectOnboardingDeps {
  const db = adminClient();
  return {
    async getOperator(id) {
      const { data: row, error } = await db
        .from("operators")
        // Single string literal, not a concatenation: supabase-js infers the row
        // type from the literal, and a `+` expression degrades it to an error type.
        .select("id, email, business_name, stripe_account_id, stripe_charges_enabled, stripe_payouts_enabled, stripe_details_submitted")
        .eq("id", id)
        .maybeSingle();
      if (error) {
        throw new HttpError(500, "db_error", "operator lookup failed", error, {
          operator_id: id,
        });
      }
      return row;
    },

    async claimAccountId(operatorId, accountId) {
      const { error: uErr } = await db
        .from("operators")
        .update({
          stripe_account_id: accountId,
          stripe_account_connected_at: new Date().toISOString(),
        })
        .eq("id", operatorId)
        // Only claim the row if it is still unclaimed: two concurrent 'start'
        // calls would otherwise each create an account and the loser would
        // overwrite the winner.
        .is("stripe_account_id", null);
      if (uErr) {
        throw new HttpError(500, "db_error", "failed to persist the Stripe account", uErr, {
          operator_id: operatorId,
          stripe_account_id: accountId,
        });
      }

      // Re-read: if the conditional update matched nothing, another request won
      // the race and its account is the real one. Ours is an orphan — harmless,
      // because an account with no onboarding and no charges is inert.
      //
      // The re-read's error is INSPECTED (it used to be discarded): a failed
      // read here is not "nobody else claimed it", it is "we do not know which
      // account is real", and falling through to ours would return an onboarding
      // link for an account the row does not carry — an operator finishing
      // Stripe's forms on an orphan. Same idiom as operator-billing's customer
      // re-read.
      const { data: after, error: readErr } = await db
        .from("operators").select("stripe_account_id").eq("id", operatorId).maybeSingle();
      if (readErr) {
        throw new HttpError(500, "db_error", "account re-read failed", readErr, {
          operator_id: operatorId,
          stripe_account_id: accountId,
        });
      }
      return (after?.stripe_account_id as string | null) ?? accountId;
    },

    // Eager, the operator-billing precedent: `status` still 500s without
    // STRIPE_SECRET_KEY, exactly as it did when the client was built at the
    // top of the request. Recorded, not changed.
    stripe: stripeClient(),
    base: Deno.env.get("APP_BASE_URL") ?? "http://localhost:5173",
  };
}

serveFunction(async (req) => {
  const operator = await requireOperator(req);
  const body = await readJson<ConnectBody>(req);
  return jsonOk(await handleConnectOnboarding(operator.id, body, makeDeps()));
});
