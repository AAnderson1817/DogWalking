// billing-portal — POST, client JWT (phase 07). Returns a Stripe customer
// portal session URL for payment-method / pause / cancel self-service.
//
// The rules live in handler.ts behind injected deps (billing_portal_test.ts);
// this file only wires the real Stripe client and database to them.
import { type ConnectFields, HttpError, jsonOk, requireUser, serveFunction } from "../_lib/http.ts";
import { adminClient } from "../_lib/admin.ts";
import { stripeClient } from "../_lib/stripe.ts";
import { type BillingPortalDeps, handleBillingPortal } from "./handler.ts";

function makeDeps(): BillingPortalDeps {
  const db = adminClient();
  return {
    async getClientForUser(authUserId) {
      // The operator's Connect state comes back with the client: the Stripe
      // customer lives on the OPERATOR's account (review B5), so a portal
      // session created on the platform account would 404 on a customer id
      // that looks perfectly valid.
      const { data: client, error } = await db
        .from("clients")
        .select("id, stripe_customer_id, operator:operators!clients_operator_id_fkey(stripe_account_id, stripe_charges_enabled)")
        .eq("auth_user_id", authUserId)
        .maybeSingle();
      if (error) {
        throw new HttpError(500, "db_error", "client lookup failed", error, {
          auth_user_id: authUserId,
        });
      }
      if (!client) return null;
      return {
        id: client.id,
        stripe_customer_id: client.stripe_customer_id,
        // PostgREST returns a many-to-one embed as ONE object. The admin client
        // is untyped (no Database generic), so supabase-js cannot see the FK's
        // cardinality and infers an ARRAY here — this is the one place the
        // row's shape is asserted rather than inferred, the cast the shipped
        // code carried beside its accountOf() call.
        operator: client.operator as unknown as ConnectFields,
      };
    },
    createPortalSession(params, opts) {
      // Resolved here, not in makeDeps: the client is constructed AFTER the
      // refusals, so a missing STRIPE_SECRET_KEY does not turn `not_client`
      // or `no_billing` into a 500 (the shipped ordering, kept).
      return stripeClient().billingPortal.sessions.create(params, opts);
    },
    base: Deno.env.get("APP_BASE_URL") ?? "http://localhost:5173",
  };
}

serveFunction(async (req) => {
  const user = await requireUser(req);
  return jsonOk(await handleBillingPortal(user, makeDeps()));
});
