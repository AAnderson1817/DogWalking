// connect-onboarding — POST, operator JWT (review B5).
//
// Creates and resumes the operator's Stripe Connect *Standard* account (the
// reasoning is in handler.ts). The rules live there behind injected deps
// (connect_onboarding_test.ts) and the wiring in deps.ts
// (connect_onboarding_deps_test.ts); this file only reads the environment
// and joins the two.
import { jsonOk, readJson, requireOperator, serveFunction } from "../_lib/http.ts";
import { adminClient } from "../_lib/admin.ts";
import { stripeClient } from "../_lib/stripe.ts";
import { makeConnectOnboardingDeps } from "./deps.ts";
import { type ConnectBody, handleConnectOnboarding } from "./handler.ts";

serveFunction(async (req) => {
  const operator = await requireOperator(req);
  const body = await readJson<ConnectBody>(req);
  const deps = makeConnectOnboardingDeps({
    db: adminClient(),
    // Eager, the operator-billing precedent (deps.ts says why).
    stripe: stripeClient(),
    base: Deno.env.get("APP_BASE_URL") ?? "http://localhost:5173",
  });
  return jsonOk(await handleConnectOnboarding(operator.id, body, deps));
});
