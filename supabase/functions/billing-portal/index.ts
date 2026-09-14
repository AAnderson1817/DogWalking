// billing-portal — POST, client JWT (phase 07). Returns a Stripe customer
// portal session URL for payment-method / pause / cancel self-service.
//
// The rules live in handler.ts behind injected deps (billing_portal_test.ts)
// and the wiring in deps.ts (billing_portal_deps_test.ts); this file only
// reads the environment and joins the two.
import { jsonOk, requireUser, serveFunction } from "../_lib/http.ts";
import { adminClient } from "../_lib/admin.ts";
import { stripeClient } from "../_lib/stripe.ts";
import { makeBillingPortalDeps } from "./deps.ts";
import { handleBillingPortal } from "./handler.ts";

serveFunction(async (req) => {
  const user = await requireUser(req);
  const deps = makeBillingPortalDeps({
    db: adminClient(),
    // The thunk, not a client: resolved after the refusals (deps.ts).
    stripe: stripeClient,
    base: Deno.env.get("APP_BASE_URL") ?? "http://localhost:5173",
  });
  return jsonOk(await handleBillingPortal(user, deps));
});
