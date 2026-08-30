// operator-billing's Stripe shapes, as pure builders (the create-checkout
// pattern): testable as objects, handed to single call sites in handler.ts.
//
// Everything here happens on Sanpo's PLATFORM account — the operator paying
// Sanpo, not a client paying the operator — so unlike every other money path
// in the tree, NO call built from these params may carry `stripeAccount`.
// operator_billing_test.ts asserts that over every call, the inverse of the
// overage guard.

/** $49/month, in cents (the *_pence naming convention holds cents — CLAUDE.md).
 * The public /pricing page states the same figure from its own constant, and
 * a test pins the two against each other. */
export const OPERATOR_PRICE_PENCE = 4900;

/** The amount is in the key on purpose: a future price change mints a NEW
 * lookup key (and a new Stripe Price), so existing subscriptions keep the
 * price they agreed to and the old key is never quietly repointed. */
export const OPERATOR_PRICE_LOOKUP_KEY = "sanpo_operator_monthly_4900";

/** Stripe Checkout refuses subscription_data.trial_end closer than 48 hours
 * out. An operator subscribing with less trial than that left simply starts
 * paying now — omitting the field — rather than having the button 500. */
export const TRIAL_MIN_REMAINING_MS = 48 * 60 * 60 * 1000;

/** Margin over Stripe's floor. A trial_end minted at exactly 48h out is
 * UNDER the floor by the time the request reaches Stripe (transit latency,
 * clock skew), and Stripe then rejects the whole session — the Subscribe
 * button failing for exactly the operators closest to needing it
 * (adversarial review). Five minutes of trial forfeited at the boundary is
 * the cheap side of that trade. */
export const TRIAL_FLOOR_MARGIN_MS = 5 * 60 * 1000;

/**
 * The remaining trial as a Stripe timestamp, or null when it must be
 * omitted: no trial recorded, unparseable, or within the margin of Stripe's
 * 48-hour floor. Subscribing mid-trial keeps the days already promised —
 * the subscription starts billing when the trial was always going to end,
 * not the moment the operator adds a card, so subscribing early is never
 * punished. (Settings states the under-48h exception in words; the app-side
 * constant is pinned against this one by platform-price.test.ts.)
 */
export function trialEndSeconds(trialEndsAt: string | null, nowMs: number): number | null {
  if (!trialEndsAt) return null;
  const t = Date.parse(trialEndsAt);
  if (!Number.isFinite(t)) return null;
  if (t - nowMs < TRIAL_MIN_REMAINING_MS + TRIAL_FLOOR_MARGIN_MS) return null;
  return Math.floor(t / 1000);
}

/** The $49/month Price, created lazily on first use. It lives in Stripe
 * keyed by lookup_key rather than in a config table here: Stripe is the
 * platform account's book of record, and an id cached in Postgres is one
 * restore away from pointing at nothing. */
export function operatorPriceParams() {
  return {
    currency: "usd",
    unit_amount: OPERATOR_PRICE_PENCE,
    recurring: { interval: "month" as const },
    lookup_key: OPERATOR_PRICE_LOOKUP_KEY,
    product_data: { name: "Sanpo" },
  };
}

export function operatorCheckoutParams(args: {
  customerId: string;
  operatorId: string;
  priceId: string;
  /** From trialEndSeconds; null omits the field entirely. */
  trialEnd: number | null;
  /** APP_BASE_URL — the return routes live on the operator's Settings. */
  base: string;
}) {
  const metadata = { operator_id: args.operatorId };
  return {
    mode: "subscription" as const,
    customer: args.customerId,
    line_items: [{ price: args.priceId, quantity: 1 }],
    // A trialing subscription with no card is a lockout scheduled for the
    // trial's end; collect it now, while the person is already here.
    payment_method_collection: "always" as const,
    // L8, same as every client-facing builder: collect the billing address
    // and make it stick to the Customer.
    billing_address_collection: "required" as const,
    customer_update: { address: "auto" as const, name: "auto" as const },
    // On the session (read by platform-webhook's checkout arm) and on the
    // subscription — where nothing reads it today (the subscription arms
    // bind through the customer, not metadata); it rides along so a person
    // in the Stripe dashboard can tell whose subscription they are looking
    // at.
    metadata,
    subscription_data: {
      metadata,
      ...(args.trialEnd !== null ? { trial_end: args.trialEnd } : {}),
    },
    success_url: `${args.base}/settings?sanpo_billing=success`,
    cancel_url: `${args.base}/settings?sanpo_billing=cancelled`,
  };
}
