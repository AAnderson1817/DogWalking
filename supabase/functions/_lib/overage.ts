// Off-session walk charging (spec 04): used by charge-overage and invoked
// in-process by complete-walk. A walk flagged is_overage is charged as a
// WHOLE (invariant 3 — never partial credit) at the rate snapshotted when it
// was created: the client's plan overage rate, or — for a client on no plan —
// the service's visit price (review H32). See the resolution order at the
// `amount` assignment below.
//
// Double-charge protection (re-review hardening):
//   1. A 'pending' payments row is inserted BEFORE the Stripe confirm — it
//      claims the walk under uq_overage_payment_per_walk, so concurrent or
//      crashed attempts can never charge twice.
//   2. The Stripe idempotency key is per-CLAIM (walkId + claim row id):
//      a crash-retry of the same claim replays the same Stripe attempt, while
//      a genuinely new claim after a definitive decline/cancel gets a fresh
//      key (a fixed per-walk key would replay the stored decline for ~24h and
//      brick the console re-charge).
//   3. A found 'pending' claim is reconciled against Stripe live before we
//      decide anything, so async PI settlement can't deadlock collection.
//   4. Card errors mark the claim failed (re-chargeable); infra errors leave
//      the claim pending and rethrow — the caller 500s and retries.

import { formatMoney } from "./money.ts";

export interface OverageWalk {
  id: string;
  operator_id: string;
  client_id: string;
  status: string;
  is_overage: boolean;
  /** The client's plan overage rate when the walk was created (0043).
   * Null = no plan at creation, or a pre-0043 row. */
  overage_rate_pence: number | null;
  /** The service's cash visit price when the walk was created (0044).
   * Null = the service had no visit price, or a pre-0044 row. */
  visit_price_pence: number | null;
}

export interface OveragePayment {
  id?: string;
  walk_id: string;
  type: "overage";
  amount_pence: number;
  status: "succeeded" | "failed" | "pending";
  stripe_payment_intent_id: string | null;
  receipt_url: string | null;
  created_at?: string;
}

export interface OverageDeps {
  getWalk(id: string): Promise<OverageWalk | null>;
  /** Newest succeeded OR pending overage payment for the walk (live rows). */
  getLiveOveragePayment(walkId: string): Promise<OveragePayment | null>;
  /** Live PaymentIntent state from Stripe, for reconciling pending claims. */
  retrievePaymentIntent(piId: string): Promise<{ status: string; receipt_url: string | null }>;
  getClientBilling(clientId: string): Promise<
    | {
      stripe_customer_id: string | null;
      plan: { overage_rate_pence: number } | null;
      full_name: string;
    }
    | null
  >;
  /** Create + confirm an off-session PaymentIntent; throws on card decline. */
  createOffSessionPaymentIntent(args: {
    customerId: string;
    amountPence: number;
    walkId: string;
    clientId: string;
    /** Stripe idempotency key for THIS payment claim. */
    attemptKey: string;
    /** Which promise priced the charge — drives the PI description the
     * client sees on their statement/receipt. Required, not defaulted: a
     * call site that has not decided is a call site that will label a
     * pay-per-visit client's charge "overage". */
    pricing: "plan_rate" | "visit_price";
  }): Promise<{ id: string; status: string; receipt_url: string | null }>;
  insertPayment(
    row: OveragePayment & { operator_id: string; client_id: string },
  ): Promise<OveragePayment>;
  updatePayment(id: string, fields: Record<string, unknown>): Promise<OveragePayment>;
  insertNotification(row: {
    operator_id: string;
    client_id: string | null;
    type: string;
    title: string;
    body: string;
    walk_id: string | null;
  }): Promise<void>;
  /** True for card/payment failures (decline etc.) vs infra/DB errors. */
  isCardError(err: unknown): boolean;
  /** True for a failure that RETRYING CANNOT FIX — a malformed request, a
   * customer that does not exist on this account, no saved card. Distinct from
   * a card decline (the client can fix it) and from a transient fault (time
   * can fix it). Without this third class every permanent failure was treated
   * as transient: rethrown, leaving the claim pending, so the walk never
   * completed and the operator's retry hit the same wall forever. */
  isPermanentError?(err: unknown): boolean;
  /** Throws when the operator cannot take money yet. Optional so the pure
   * tests can omit it; the real deps always supply it. */
  resolveAccount?(): { stripeAccount: string };
  now?(): number;
}

export class OverageError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/**
 * Turn a permanent Stripe failure into something an operator can act on.
 * Stripe's own message is written for a developer ("No such customer:
 * cus_123"), and the operator needs to know which of their own settings is
 * wrong.
 */
function permanentReason(err: unknown): string {
  const e = err as { code?: string; message?: string } | null;
  if (e?.code === "resource_missing") {
    return "This client's payment details are not on your Stripe account — they may need to subscribe again or save a card";
  }
  if (e?.message?.includes("no payment method on file")) {
    return "This client has no card saved, so there is nothing to charge — send them a card link from their client page";
  }
  return "Stripe rejected the charge as invalid, so retrying will not help";
}

/** Stripe PI states that mean the attempt is dead and re-chargeable. */
const PI_DEAD = new Set(["canceled", "requires_payment_method"]);
/** How long an id-less pending claim blocks before retrying the same claim. */
const CLAIM_LEASE_MS = 10 * 60_000;

export async function chargeOverageForWalk(
  walkId: string,
  deps: OverageDeps,
): Promise<{ payment: OveragePayment; already_charged: boolean }> {
  const walk = await deps.getWalk(walkId);
  if (!walk) throw new OverageError("walk_not_found", "walk not found", 404);
  if (!walk.is_overage) {
    throw new OverageError("not_overage", "walk is not flagged as overage", 409);
  }

  const live = await deps.getLiveOveragePayment(walkId);
  if (live?.status === "succeeded") return { payment: live, already_charged: true };
  if (live?.status === "pending" && live.stripe_payment_intent_id) {
    // Reconcile an identified PaymentIntent before loading billing details:
    // this may be a completed charge even if the client was later archived.
    const pi = await deps.retrievePaymentIntent(live.stripe_payment_intent_id);
    if (pi.status === "succeeded") {
      const settled = await deps.updatePayment(live.id!, {
        status: "succeeded",
        receipt_url: pi.receipt_url,
      });
      return { payment: settled, already_charged: true };
    }
    if (!PI_DEAD.has(pi.status)) {
      // processing / requires_action: genuinely in flight — do not re-charge.
      return { payment: live, already_charged: true };
    }
    await deps.updatePayment(live.id!, { status: "failed" });
  }

  const billing = await deps.getClientBilling(walk.client_id);
  if (!billing) throw new OverageError("client_not_found", "client not found", 404);

  /**
   * The price the walk is charged at, in the order the promises were made
   * (review H32, completing 0043/L7):
   *
   *   1. `walks.overage_rate_pence` — the client's PLAN rate when the walk
   *      was created. Written since 0043 and, until this change, read by
   *      NOTHING: the charge billed the live plan rate, so a Settings edit
   *      re-priced every walk already on the calendar — the exact defect
   *      0043 was recorded as closing.
   *   2. `walks.visit_price_pence` — the service's cash price when the walk
   *      was created (0044). The snapshot trigger fills it whenever the
   *      service has one, plan client or not, so this ORDER — plan rate
   *      first — is what keeps a plan client off the cash price.
   *   3. The live plan rate — walks with no snapshot at all: pre-0043 rows
   *      (exactly the behaviour they shipped with), and walks created with
   *      neither a plan nor a visit price whose client subscribed before
   *      completion. For those there was no figure to snapshot; charging
   *      the plan they since agreed to beats refusing their walk.
   *
   * All three null → refuse below. Null is "nothing agreed", never "free"
   * (0043's rule, restated on both new columns).
   */
  const amount = walk.overage_rate_pence ??
    walk.visit_price_pence ??
    billing.plan?.overage_rate_pence;
  const pricing: "plan_rate" | "visit_price" =
    walk.overage_rate_pence == null && walk.visit_price_pence != null
      ? "visit_price"
      : "plan_rate";

  /**
   * Who hears about a failed charge depends on whose fault it is (review B6).
   *
   * A CARD fault is the client's: their card was declined, and updating it is
   * something only they can do. Both personas are told.
   *
   * A CONFIGURATION fault is the operator's: no plan exists, no billing
   * profile was ever set up, or the operator has not connected Stripe. The
   * client can do nothing about any of these. Telling them "we couldn't charge
   * for your walk, please update your payment method" is wrong twice over —
   * it blames them for the operator's setup and points at a payment method
   * they may not even have. An un-configured operator would otherwise dun
   * their own customers on every single walk.
   */
  const notifyFailure = async (
    reason: string,
    fault: "card" | "configuration",
  ): Promise<void> => {
    if (fault === "card") {
      await deps.insertNotification({
        operator_id: walk.operator_id,
        client_id: walk.client_id,
        type: "payment_failed",
        title: "Walk payment failed",
        body: `We couldn't charge for your walk (${reason}). Please update your payment method.`,
        walk_id: walkId,
      });
    }
    await deps.insertNotification({
      operator_id: walk.operator_id,
      client_id: null,
      type: "payment_failed",
      title: fault === "card"
        ? `Overage charge failed for ${billing.full_name}`
        : `Walk for ${billing.full_name} could not be billed — check your setup`,
      body: fault === "card"
        ? `The overage charge could not be completed (${reason}). The debt is visible in the billing console.`
        : `${reason}. The walk is recorded and the charge is waiting in the billing console; `
          + `your client has not been contacted about it.`,
      walk_id: walkId,
    });
  };

  const failWithoutAttempt = async (
    reason: string,
    fault: "card" | "configuration" = "configuration",
  ): Promise<{ payment: OveragePayment; already_charged: false }> => {
    const payment = await deps.insertPayment({
      operator_id: walk.operator_id,
      client_id: walk.client_id,
      walk_id: walkId,
      type: "overage",
      amount_pence: amount ?? 0,
      status: "failed",
      stripe_payment_intent_id: null,
      receipt_url: null,
    });
    await notifyFailure(reason, fault);
    return { payment, already_charged: false };
  };

  if (amount == null) {
    return failWithoutAttempt(
      "This client is not on a plan and this walk has no visit price on record — "
        + "set a visit price in Settings and future walks will carry it",
    );
  }
  if (!billing.stripe_customer_id) {
    // No Stripe customer means no checkout of any kind ever ran for this
    // client, so there is no card anywhere to charge and no way for them to
    // add one unaided.
    return failWithoutAttempt(
      "This client has no billing profile yet — send them a plan to subscribe to, "
        + "or a card link so visit charges have a card to land on",
    );
  }
  // Narrowing doesn't survive into the closure below — capture it.
  const customerId = billing.stripe_customer_id;

  // "Operator has not connected Stripe" is a configuration fault like the two
  // above, not an exception: the walk still happened and the record of it
  // should survive. Resolving here rather than at the top of complete-walk is
  // what lets a credit-funded walk complete for an un-connected operator.
  try {
    deps.resolveAccount?.();
  } catch {
    return failWithoutAttempt(
      "Connect a Stripe account before charging — your clients pay you directly, so the money needs somewhere to land",
    );
  }

  const chargeClaim = async (
    claim: OveragePayment,
    // What THIS claim charges. For a fresh claim it is the resolution above;
    // for a lease-expired retry it is the amount the claim was minted with —
    // the idempotency key is per-claim, and replaying the same key with a
    // different amount makes Stripe answer idempotency_error (transient to
    // our taxonomy, so the claim would wedge for the key's ~24h lifetime and
    // then charge — or double-charge — at the drifted figure). Caught in
    // adversarial review; drift is reachable on the live-rate fallback path
    // and across the deploy that changed the resolution.
    chargePence: number,
  ): Promise<{ payment: OveragePayment; already_charged: false }> => {
    try {
      const pi = await deps.createOffSessionPaymentIntent({
        customerId,
        amountPence: chargePence,
        walkId,
        clientId: walk.client_id,
        attemptKey: `overage_${walkId}_${claim.id ?? "claim"}`,
        pricing,
      });
      const status = pi.status === "succeeded" ? "succeeded" : "pending";
      const payment = await deps.updatePayment(claim.id!, {
        status,
        stripe_payment_intent_id: pi.id,
        receipt_url: pi.receipt_url,
      });
      /**
       * Review H12. Until now a SUCCESSFUL off-session charge told nobody.
       * `notifyFailure` existed with no counterpart, so the only message the
       * client received was `walk_complete` — "Your walk report card is ready"
       * — carrying no amount and no mention that money had moved. Their card
       * was charged while they were not present, for a walk they were never
       * quoted, and the first they could learn of it was the statement. An
       * unannounced off-session charge is the highest-yield generator of
       * chargebacks in consumer services, and this system has none of the
       * machinery to contest one.
       *
       * Only on `succeeded`. A `pending` PaymentIntent has taken nothing yet,
       * and announcing a charge that may still decline is worse than silence —
       * it would be contradicted by the failure notification minutes later.
       *
       * `formatMoney`'s currency defaults to USD because the product is
       * USD-only (CLAUDE.md) and the overage path carries no currency in
       * scope; the parameter exists so the first multi-currency call site has
       * somewhere to put it rather than a `$` glued to a number.
       */
      if (status === "succeeded") {
        const money = formatMoney(chargePence);
        // The wording follows the promise that priced the charge (H32): the
        // plan sentence presupposes credits that were used up, which is false
        // for a pay-per-visit client who never had any — telling them their
        // "plan credits were used up" would be an announcement of a plan
        // they are not on.
        const explanation = pricing === "visit_price"
          ? `This walk was charged at your walker's per-visit price. ${money} was `
            + "taken from the card on file."
          : "Your plan credits were used up, so this walk was charged at your walker's "
            + `overage rate. ${money} was taken from the card on file.`;
        await deps.insertNotification({
          operator_id: walk.operator_id,
          client_id: walk.client_id,
          type: "payment_taken",
          title: `${money} charged for your walk`,
          body: explanation + (pi.receipt_url ? ` Receipt: ${pi.receipt_url}` : ""),
          walk_id: walkId,
        });
      }
      return { payment, already_charged: false };
    } catch (err) {
      if (deps.isCardError(err)) {
        // Card declined: the attempt is dead, the walk stays completed, the
        // debt shows in the billing console for a fresh re-charge attempt.
        const payment = await deps.updatePayment(claim.id!, { status: "failed" });
        await notifyFailure("card declined", "card");
        return { payment, already_charged: false };
      }
      // Permanent: retrying changes nothing. Resolve the claim to 'failed'
      // so the walk can complete and the debt is visible, and tell the
      // operator — this is theirs to fix, not the client's. Leaving it pending
      // (the old behaviour for everything non-card) meant the walk never
      // completed at all and every retry hit the same wall.
      if (deps.isPermanentError?.(err)) {
        const payment = await deps.updatePayment(claim.id!, { status: "failed" });
        await notifyFailure(permanentReason(err), "configuration");
        return { payment, already_charged: false };
      }
      // Transient (Stripe unreachable, DB write failed): keep the pending
      // claim (it blocks double-charging) and rethrow — the caller 500s and a
      // retry reuses this claim's idempotency key instead of creating a new
      // Stripe attempt.
      throw err;
    }
  };

  if (live?.status === "pending" && !live.stripe_payment_intent_id) {
    // Claimed but no PI recorded: an attempt may still be in progress. Once
    // the lease expires, retry THE SAME claim with THE SAME idempotency key.
    // If Stripe succeeded before the previous crash, this replays that PI
    // instead of creating a second charge.
    const now = deps.now?.() ?? Date.now();
    const age = live.created_at ? now - Date.parse(live.created_at) : Infinity;
    if (age < CLAIM_LEASE_MS) return { payment: live, already_charged: true };
    return chargeClaim(live, live.amount_pence);
  }

  // Claim the walk (uq_overage_payment_per_walk serializes concurrent
  // attempts: the loser's insert throws and its caller retries into the
  // reconcile path above).
  const claim = await deps.insertPayment({
    operator_id: walk.operator_id,
    client_id: walk.client_id,
    walk_id: walkId,
    type: "overage",
    amount_pence: amount,
    status: "pending",
    stripe_payment_intent_id: null,
    receipt_url: null,
  });

  return chargeClaim(claim, amount);
}
