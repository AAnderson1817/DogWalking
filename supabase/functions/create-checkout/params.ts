// create-checkout's session shapes, as pure builders (review H32).
//
// One builder per checkout kind, returning the literal params object that
// index.ts hands to the SINGLE `stripe.checkout.sessions.create` call. Pure
// so the contracts are testable as objects: checkout_session_test.ts used to
// regex the source because index.ts had no seam, and a source regex can pin
// "the text contains billing_address_collection" but not "every kind of
// session collects the address". Now the tests assert the built objects.
import { HttpError } from "../_lib/http.ts";
import { formatMoney } from "../_lib/money.ts";
import { MAX_TOPUP_CREDITS, STRIPE_META } from "../_lib/stripe_metadata.ts";

export type CheckoutRequest =
  | { kind: "subscription"; clientId: string; planId: string }
  | { kind: "topup"; clientId: string; credits: number; amountPence: number }
  | { kind: "setup"; clientId: string };

/**
 * Exactly one of `plan_id`, `topup`, `setup`. A body naming two is a caller
 * bug, and picking one silently would turn it into the wrong money movement.
 */
export function parseCheckoutRequest(body: unknown): CheckoutRequest {
  const b = body as {
    client_id?: string;
    plan_id?: string;
    topup?: { credits?: unknown; amount_pence?: unknown };
    setup?: boolean;
  } | null;
  if (!b?.client_id) {
    throw new HttpError(400, "bad_request", "client_id is required");
  }
  const kinds = [b.plan_id ? 1 : 0, b.topup ? 1 : 0, b.setup ? 1 : 0]
    .reduce((a, n) => a + n, 0);
  if (kinds !== 1) {
    throw new HttpError(
      400,
      "bad_request",
      "exactly one of plan_id, topup, or setup is required",
    );
  }
  if (b.plan_id) {
    return { kind: "subscription", clientId: b.client_id, planId: b.plan_id };
  }
  if (b.topup) {
    const credits = b.topup.credits;
    const amount = b.topup.amount_pence;
    if (typeof credits !== "number" || !Number.isInteger(credits) || credits <= 0) {
      throw new HttpError(400, "bad_request", "topup.credits must be a positive integer");
    }
    if (credits > MAX_TOPUP_CREDITS) {
      // Refused BEFORE Stripe collects anything: past int4, the RPC that
      // grants can never encode the value, so the money would be taken and
      // the credits never land (see MAX_TOPUP_CREDITS).
      throw new HttpError(
        400,
        "bad_request",
        `topup.credits must be at most ${MAX_TOPUP_CREDITS}`,
      );
    }
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
      throw new HttpError(400, "bad_request", "topup.amount_pence must be a positive integer");
    }
    return { kind: "topup", clientId: b.client_id, credits, amountPence: amount };
  }
  return { kind: "setup", clientId: b.client_id };
}

export interface PricedService {
  name: string;
  visit_price_pence: number;
}

/**
 * Top-ups are for clients OUTSIDE a live billing cycle. A plan client's
 * balance is swept by fn_apply_rollover at every renewal — the schema
 * default policy 'none' expires the ENTIRE balance — so selling them
 * credits mid-cycle is selling credits the machinery is scheduled to
 * destroy days later, silently (caught in adversarial review; the v1
 * single-lot rollover rule, CLAUDE.md invariant 4, forbids the per-lot
 * tracking that would let purchased credit survive the sweep).
 * `fn_adjust_credits` remains the operator-judgment path for a subscribed
 * client. Same live set ClientDetail's `subscribed` uses: `past_due` is a
 * live subscription whose payment failed, and `paused` still renews.
 */
export function assertTopupAllowed(client: {
  stripe_subscription_id: string | null;
  subscription_status: string;
}): void {
  if (client.stripe_subscription_id && client.subscription_status !== "cancelled") {
    throw new HttpError(
      409,
      "client_subscribed",
      "This client is on a plan, and plan renewals expire leftover credits — a paid " +
        "top-up would be swept at their next cycle. Use Adjust credits instead.",
    );
  }
}

/** Checkout rejects custom_text over 1200 characters; stay under it with
 * room for a multibyte name or two. */
export const MANDATE_MAX_CHARS = 1150;

/**
 * The per-visit mandate (review H12's rule applied to H32): a card saved for
 * off-session use is authorised AT THE SAVE, and the authorisation has to say
 * what it authorises — with figures, for EVERY priced service. Null when
 * nothing is priced, because a disclosure with no figure in it is worse than
 * none (create-checkout's overage mandate makes the same call).
 *
 * Every service, no truncation. The first draft capped the list at six with
 * "and N more priced services" — but an omitted service still charges
 * off-session through its snapshotted visit price, so the client would have
 * authorised a card without being shown a figure that can hit it (Codex
 * finding on #76). A mandate too long for Checkout's limit is `tooLong`, and
 * the CALLER decides: setup refuses outright, a top-up runs without saving
 * the card — incomplete disclosure never quietly becomes partial disclosure.
 */
export function visitPriceMandate(
  services: PricedService[],
): { kind: "none" } | { kind: "tooLong" } | { kind: "ok"; text: string } {
  if (services.length === 0) return { kind: "none" };
  const list = services
    .map((s) => `${s.name} ${formatMoney(s.visit_price_pence)}`)
    .join("; ");
  const text = `Completed walks are charged to this card after each visit: ${list}.`;
  if (text.length > MANDATE_MAX_CHARS) return { kind: "tooLong" };
  return { kind: "ok", text };
}

interface CommonArgs {
  customerId: string;
  clientId: string;
  operatorId: string;
  /** APP_BASE_URL — the return routes live on the operator's client record. */
  base: string;
}

/** L8: collect the billing address, and make it STICK. `customer_update` is
 * the half that is easy to lose — without it Checkout collects the address
 * for the payment and never writes it to the Customer. Every builder carries
 * the pair; the test pins them against each other on every kind. */
const ADDRESS_COLLECTION = {
  billing_address_collection: "required" as const,
  customer_update: { address: "auto" as const, name: "auto" as const },
};

function returnUrls({ base, clientId }: { base: string; clientId: string }) {
  return {
    success_url: `${base}/clients/${clientId}?checkout=success`,
    cancel_url: `${base}/clients/${clientId}?checkout=cancelled`,
  };
}

export function subscriptionSessionParams(
  args: CommonArgs & {
    planId: string;
    stripePriceId: string;
    overageRatePence: number | null;
  },
) {
  const metadata = {
    client_id: args.clientId,
    operator_id: args.operatorId,
    plan_id: args.planId,
  };
  return {
    mode: "subscription" as const,
    customer: args.customerId,
    line_items: [{ price: args.stripePriceId, quantity: 1 }],
    payment_method_collection: "always" as const,
    ...ADDRESS_COLLECTION,
    // Metadata on both the session (read by checkout.session.completed) and
    // the subscription (read by anything inspecting the subscription later).
    metadata,
    subscription_data: { metadata },
    ...returnUrls(args),
    /**
     * Review H12: the overage mandate, on Stripe's record. Omitted rather
     * than fudged when the plan has no overage rate — "charged at your
     * overage rate" with no figure is the kind of vague disclosure that is
     * worse than none.
     */
    ...(typeof args.overageRatePence === "number" && args.overageRatePence > 0
      ? {
        custom_text: {
          submit: {
            message: `Walks beyond the credits in this plan are charged to this card at ` +
              `${formatMoney(args.overageRatePence)} each, after the walk is completed.`,
          },
        },
      }
      : {}),
  };
}

export function topupSessionParams(
  args: CommonArgs & {
    credits: number;
    amountPence: number;
    /** Null when the operator has priced no services — the top-up still runs
     * (its own line item IS its disclosure) and the card is still saved, but
     * no per-visit promise is stated because none exists to state. */
    mandate: string | null;
  },
) {
  const plural = args.credits === 1 ? "credit" : "credits";
  return {
    mode: "payment" as const,
    customer: args.customerId,
    line_items: [{
      price_data: {
        currency: "usd",
        product_data: { name: `${args.credits} walk ${plural}` },
        unit_amount: args.amountPence,
      },
      quantity: 1,
    }],
    // The card that pays the top-up is saved for off-session visit charges —
    // one checkout makes a cash client fully chargeable (review H32) — but
    // ONLY under a mandate. A card saved with no per-visit terms is exactly
    // the state the setup branch refuses, and saving it here anyway was a
    // bypass of that rule (caught in adversarial review): the operator could
    // later set a price, the 0044 backfill would price the queued walks, and
    // the card would be charged off-session at a figure the client was never
    // shown. With nothing priced the top-up still runs — its line item
    // discloses the PAYMENT — and simply saves no card.
    payment_intent_data: {
      ...(args.mandate ? { setup_future_usage: "off_session" as const } : {}),
      metadata: { client_id: args.clientId, operator_id: args.operatorId },
    },
    ...ADDRESS_COLLECTION,
    metadata: {
      client_id: args.clientId,
      operator_id: args.operatorId,
      // Read back by stripe-webhook off checkout.session.completed; its
      // presence is what marks a payment-mode session as a Sanpo top-up.
      [STRIPE_META.topupCredits]: String(args.credits),
    },
    ...returnUrls(args),
    ...(args.mandate ? { custom_text: { submit: { message: args.mandate } } } : {}),
  };
}

export function setupSessionParams(args: CommonArgs & { mandate: string }) {
  return {
    mode: "setup" as const,
    customer: args.customerId,
    ...ADDRESS_COLLECTION,
    metadata: { client_id: args.clientId, operator_id: args.operatorId },
    ...returnUrls(args),
    // Required, not optional: index.ts refuses to mint a card-save session
    // when no visit price exists, because a card saved under no stated terms
    // is an off-session charge waiting to surprise somebody (H12).
    custom_text: { submit: { message: args.mandate } },
  };
}
