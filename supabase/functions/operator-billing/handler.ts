// operator-billing flow (review H31), dependency-injected for tests.
//
// The operator's own $49/month subscription to Sanpo — the one money path in
// the tree that runs on the PLATFORM Stripe account, because here Sanpo is
// the merchant and the operator is the customer. Everything client-facing
// stays on the operator's connected account (review B5) and none of it is
// touched by this function.
import { HttpError } from "../_lib/http.ts";
import { operatorCheckoutParams, operatorPriceParams, trialEndSeconds } from "./params.ts";

export interface OperatorBillingRow {
  id: string;
  email: string | null;
  business_name: string | null;
  trial_ends_at: string | null;
  platform_customer_id: string | null;
  platform_subscription_id: string | null;
  platform_subscription_status: string;
}

/** The slice of the Stripe SDK this handler touches, parameter-typed by the
 * builders above so the REAL client is assignable without a cast (a cast
 * would hide exactly the drift a type is for). The test passes a recorder
 * that asserts no call ever carries `stripeAccount` — these are platform
 * objects, and routing them to a connected account would put Sanpo's own
 * revenue in some operator's balance. */
export interface PlatformStripe {
  customers: {
    create(params: {
      email?: string;
      name?: string;
      metadata: { operator_id: string };
    }): Promise<{ id: string }>;
  };
  prices: {
    list(params: {
      lookup_keys: string[];
      active: boolean;
      limit: number;
    }): Promise<{ data: Array<{ id: string }> }>;
    create(
      params: ReturnType<typeof operatorPriceParams>,
      opts?: { idempotencyKey: string },
    ): Promise<{ id: string }>;
  };
  checkout: {
    sessions: {
      create(
        params: ReturnType<typeof operatorCheckoutParams>,
      ): Promise<{ id: string; url: string | null }>;
    };
  };
  billingPortal: {
    sessions: {
      create(params: { customer: string; return_url: string }): Promise<{ url: string }>;
    };
  };
}

export interface OperatorBillingDeps {
  getOperator(id: string): Promise<OperatorBillingRow | null>;
  /** Persist the Stripe customer id iff the column is still null, then
   * return whatever the row now holds — the connect-onboarding idiom: the
   * loser of a concurrent race adopts the winner's customer and its own
   * becomes an inert orphan. */
  claimCustomerId(operatorId: string, customerId: string): Promise<string>;
  stripe: PlatformStripe;
  /** APP_BASE_URL. */
  base: string;
  now(): number;
}

export interface BillingBody {
  action?: "checkout" | "portal";
}

/**
 * Resolve the $49/month Price by lookup key, creating it on first ever use.
 * The create is race-safe the boring way: Stripe refuses a second active
 * price with the same lookup_key, and the loser just lists again and finds
 * the winner's.
 */
async function ensurePrice(stripe: PlatformStripe): Promise<string> {
  const key = operatorPriceParams().lookup_key;
  const found = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 });
  if (found.data.length > 0) return found.data[0].id;
  try {
    const created = await stripe.prices.create(operatorPriceParams(), {
      idempotencyKey: `sanpo-operator-price-${key}`,
    });
    return created.id;
  } catch (e) {
    const again = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 });
    if (again.data.length > 0) return again.data[0].id;
    throw new HttpError(500, "stripe_error", "could not resolve the subscription price", e);
  }
}

export async function handleOperatorBilling(
  operatorId: string,
  body: BillingBody | null,
  deps: OperatorBillingDeps,
): Promise<{ url: string | null }> {
  const op = await deps.getOperator(operatorId);
  if (!op) throw new HttpError(403, "not_operator", "caller is not an operator");

  const action = body?.action;
  if (action !== "checkout" && action !== "portal") {
    throw new HttpError(400, "bad_request", "action must be 'checkout' or 'portal'");
  }

  if (action === "portal") {
    if (!op.platform_customer_id) {
      throw new HttpError(
        409,
        "no_billing",
        "There is no Sanpo billing to manage yet — subscribe first.",
      );
    }
    const session = await deps.stripe.billingPortal.sessions.create({
      customer: op.platform_customer_id,
      return_url: `${deps.base}/settings`,
    });
    return { url: session.url };
  }

  // A live (or half-bound) subscription never gets a second checkout: a
  // past_due one is fixed in the portal, and a bound-but-unconfirmed one is
  // a webhook away from live. Only 'cancelled' (and never-subscribed) may
  // start over.
  if (op.platform_subscription_id && op.platform_subscription_status !== "cancelled") {
    throw new HttpError(
      409,
      "already_subscribed",
      "You already have a Sanpo subscription — use Manage billing to update it.",
    );
  }

  let customerId = op.platform_customer_id;
  if (!customerId) {
    const customer = await deps.stripe.customers.create({
      email: op.email ?? undefined,
      name: op.business_name ?? undefined,
      metadata: { operator_id: operatorId },
    });
    // Persisted BEFORE the session is minted (the connect-onboarding rule):
    // losing the checkout link is recoverable, losing which customer is ours
    // is not.
    customerId = await deps.claimCustomerId(operatorId, customer.id);
  }

  const priceId = await ensurePrice(deps.stripe);
  const session = await deps.stripe.checkout.sessions.create(operatorCheckoutParams({
    customerId,
    operatorId,
    priceId,
    trialEnd: trialEndSeconds(op.trial_ends_at, deps.now()),
    base: deps.base,
  }));
  return { url: session.url };
}
