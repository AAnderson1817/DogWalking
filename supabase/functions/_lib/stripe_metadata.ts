/**
 * The metadata keys we stamp onto Stripe objects.
 *
 * One module rather than two string literals, because these keys are a
 * handshake between two functions that never call each other: `change-plan`
 * writes them onto the subscription, and `stripe-webhook` reads them back off
 * an event that may arrive minutes later. A rename applied to one side and not
 * the other does not fail to compile and does not fail a test that mocks the
 * other side — it silently stops matching, and a plan change the client paid
 * for never applies. Naming them once makes that halfway rename impossible
 * rather than merely detectable.
 *
 * They were `pawtrail_*` until review L23. Stripe metadata is an external
 * system of record — and under Connect Standard it is the OPERATOR's account,
 * so these keys are visible to them, to their accountant and to anyone doing
 * diligence. Renamed outright with no dual-read: `deploy-production.yml` has
 * never run, and no workflow, smoke suite or e2e spec invokes `change-plan`,
 * so nothing in any account carries the old keys.
 */
export const STRIPE_META = {
  /** `plan_change_intents.id` — proves which intent this subscription update is for. */
  planChangeIntentId: "sanpo_plan_change_intent_id",
  /** `plans.id` — the target plan, for a human reading the Stripe dashboard. */
  planId: "sanpo_plan_id",
} as const;
