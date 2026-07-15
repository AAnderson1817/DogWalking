// Overage charging (spec 04): used by charge-overage and invoked in-process
// by complete-walk. A walk flagged is_overage is charged as a WHOLE at the
// client's plans.overage_rate_pence (invariant 3 — never partial credit).
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

export interface OverageWalk {
  id: string;
  operator_id: string;
  client_id: string;
  status: string;
  is_overage: boolean;
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
  const amount = billing.plan?.overage_rate_pence;

  const notifyFailure = async (reason: string): Promise<void> => {
    await deps.insertNotification({
      operator_id: walk.operator_id,
      client_id: walk.client_id,
      type: "payment_failed",
      title: "Walk payment failed",
      body: `We couldn't charge for your walk (${reason}). Please update your payment method.`,
      walk_id: walkId,
    });
    await deps.insertNotification({
      operator_id: walk.operator_id,
      client_id: null,
      type: "payment_failed",
      title: `Overage charge failed for ${billing.full_name}`,
      body: `The overage charge could not be completed (${reason}). The debt is visible in the billing console.`,
      walk_id: walkId,
    });
  };

  const failWithoutAttempt = async (
    reason: string,
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
    await notifyFailure(reason);
    return { payment, already_charged: false };
  };

  if (amount == null) return failWithoutAttempt("no plan on file");
  if (!billing.stripe_customer_id) return failWithoutAttempt("no payment method on file");
  // Narrowing doesn't survive into the closure below — capture it.
  const customerId = billing.stripe_customer_id;

  const chargeClaim = async (
    claim: OveragePayment,
  ): Promise<{ payment: OveragePayment; already_charged: false }> => {
    try {
      const pi = await deps.createOffSessionPaymentIntent({
        customerId,
        amountPence: amount,
        walkId,
        clientId: walk.client_id,
        attemptKey: `overage_${walkId}_${claim.id ?? "claim"}`,
      });
      const status = pi.status === "succeeded" ? "succeeded" : "pending";
      const payment = await deps.updatePayment(claim.id!, {
        status,
        stripe_payment_intent_id: pi.id,
        receipt_url: pi.receipt_url,
      });
      return { payment, already_charged: false };
    } catch (err) {
      if (deps.isCardError(err)) {
        // Card declined: the attempt is dead, the walk stays completed, the
        // debt shows in the billing console for a fresh re-charge attempt.
        const payment = await deps.updatePayment(claim.id!, { status: "failed" });
        await notifyFailure("card declined");
        return { payment, already_charged: false };
      }
      // Infra error (Stripe unreachable, DB write failed): keep the pending
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
    return chargeClaim(live);
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

  return chargeClaim(claim);
}
