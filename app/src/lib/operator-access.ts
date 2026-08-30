// The operator subscription gate (review H31): whether the app is open,
// nagging, or locked for this operator. Pure, so the matrix is testable
// without a router or a session.
//
// The client persona never passes through this — a pet owner must not be
// locked out of walks they paid their walker for because the walker's own
// Sanpo bill failed. RequireRole applies it to role="operator" only.

/** $49/month, in cents. The edge function states the same figure from its
 * own constant (operator-billing/params.ts) and scripts/platform-price.test.ts
 * pins the two against each other — a price change that misses one side
 * fails the build rather than showing one number and charging another. */
export const PLATFORM_PRICE_PENCE = 4900;

/** Stated on /pricing and mirrored by the 0045 column default. */
export const TRIAL_DAYS = 14;

/** Under this much remaining trial, subscribing starts billing IMMEDIATELY:
 * Stripe Checkout refuses a trial_end closer than 48 hours out, so the edge
 * function omits it (operator-billing/params.ts, whose constants this is
 * pinned against by scripts/platform-price.test.ts). Settings uses this to
 * stop promising "your trial days are kept" in the window where they are
 * not — a truthfulness rule on a money sentence (H12). */
export const TRIAL_KEEP_FLOOR_MS = 48 * 60 * 60 * 1000 + 5 * 60 * 1000;

export type OperatorAccess = "full" | "grace" | "locked";

export interface OperatorBillingState {
  /** operators.trial_ends_at — NOT NULL in the schema, nullable here because
   * this type also describes what a stale cache or partial fixture holds. */
  trialEndsAt: string | null;
  /** operators.platform_subscription_status (subscription_status enum). */
  platformSubscriptionStatus: string;
  /** operators.platform_customer_id is set — Sanpo billing exists at Stripe,
   * so the locked wall can offer Manage billing instead of a Subscribe that
   * is guaranteed to be refused (adversarial review: the wall's own
   * affordances must cover every locked state that carries a subscription). */
  hasBilling: boolean;
}

/**
 * 'full'   — subscribed, or still inside the trial window.
 * 'grace'  — past_due: Stripe is dunning the card. A banner, never a wall —
 *            locking the app while Stripe is still retrying punishes a card
 *            hiccup as if it were a cancellation.
 * 'locked' — trial over and no live subscription ('none', 'cancelled', or a
 *            deliberately 'paused' one).
 *
 * Every unreadable input fails OPEN: null billing (the resolver THROWS on
 * real query errors, so null here means the state genuinely was not there),
 * an unparseable trial date, an unrecognised status. Locking a paying
 * operator out on bad data is the M39/qc(1–4) failure class — telling
 * someone at a client's door that their subscription lapsed because a fetch
 * misbehaved — and the cost of the open direction is bounded: one operator
 * using the app without paying until the data heals.
 */
export function operatorAccess(
  billing: OperatorBillingState | null,
  nowMs: number,
): OperatorAccess {
  if (!billing) return "full";
  const status = billing.platformSubscriptionStatus;
  if (status === "active") return "full";
  if (status === "past_due") return "grace";
  if (billing.trialEndsAt) {
    const t = Date.parse(billing.trialEndsAt);
    if (!Number.isFinite(t)) return "full";
    if (nowMs < t) return "full";
  }
  if (status === "none" || status === "cancelled" || status === "paused") {
    return "locked";
  }
  // A status this code has never seen: fail open, same rule as above.
  return "full";
}
