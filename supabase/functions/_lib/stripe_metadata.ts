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
  /** Credits a payment-mode Checkout Session buys (review H32) — written by
   * create-checkout, read back by stripe-webhook off checkout.session.completed.
   * Its PRESENCE is also the discriminator: a payment-mode session without it
   * is not a Sanpo top-up and is ignored. The value is attacker-controlled on
   * a Connect endpoint like all session metadata; the webhook validates it and
   * scopes the client by the event's account before granting anything. */
  topupCredits: "sanpo_topup_credits",
} as const;

/**
 * Upper bound on one top-up's credit count, enforced by BOTH sides of the
 * handshake: create-checkout refuses before Stripe collects anything, and
 * stripe-webhook's parse treats a larger value as not-ours. The failure the
 * bound prevents is asymmetric (Codex finding on #76): `fn_apply_topup`
 * takes `p_credits int`, so a JavaScript integer past 2^31-1 passes every
 * `Number.isInteger` check, Checkout collects the independently-valid
 * amount, and then every webhook retry fails to ENCODE the RPC — the client
 * charged forever, the credits never granted. 10,000 is a product bound
 * (twenty-plus years of daily walks), not merely the int4 ceiling.
 */
export const MAX_TOPUP_CREDITS = 10_000;
