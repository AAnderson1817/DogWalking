// Overage charging (spec 04): used by charge-overage and invoked in-process
// by complete-walk. A walk flagged is_overage is charged as a WHOLE at the
// client's plans.overage_rate_pence (invariant 3 — never partial credit).
// Idempotent: an existing succeeded overage payment short-circuits.

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
}

export interface OverageDeps {
  getWalk(id: string): Promise<OverageWalk | null>;
  getSucceededOveragePayment(walkId: string): Promise<OveragePayment | null>;
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
  }): Promise<{ id: string; status: string; receipt_url: string | null }>;
  insertPayment(
    row: OveragePayment & { operator_id: string; client_id: string },
  ): Promise<OveragePayment>;
  insertNotification(row: {
    operator_id: string;
    client_id: string | null;
    type: string;
    title: string;
    body: string;
    walk_id: string | null;
  }): Promise<void>;
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

export async function chargeOverageForWalk(
  walkId: string,
  deps: OverageDeps,
): Promise<{ payment: OveragePayment; already_charged: boolean }> {
  const walk = await deps.getWalk(walkId);
  if (!walk) throw new OverageError("walk_not_found", "walk not found", 404);
  if (!walk.is_overage) {
    throw new OverageError("not_overage", "walk is not flagged as overage", 409);
  }

  const existing = await deps.getSucceededOveragePayment(walkId);
  if (existing) return { payment: existing, already_charged: true };

  const billing = await deps.getClientBilling(walk.client_id);
  if (!billing) throw new OverageError("client_not_found", "client not found", 404);
  const amount = billing.plan?.overage_rate_pence;

  const fail = async (reason: string): Promise<{ payment: OveragePayment; already_charged: false }> => {
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
    return { payment, already_charged: false };
  };

  if (amount == null) return fail("no plan on file");
  if (!billing.stripe_customer_id) return fail("no payment method on file");

  try {
    const pi = await deps.createOffSessionPaymentIntent({
      customerId: billing.stripe_customer_id,
      amountPence: amount,
      walkId,
      clientId: walk.client_id,
    });
    const status = pi.status === "succeeded" ? "succeeded" : "pending";
    const payment = await deps.insertPayment({
      operator_id: walk.operator_id,
      client_id: walk.client_id,
      walk_id: walkId,
      type: "overage",
      amount_pence: amount,
      status,
      stripe_payment_intent_id: pi.id,
      receipt_url: pi.receipt_url,
    });
    return { payment, already_charged: false };
  } catch {
    // Card declined / off-session failure. Walk stays completed; the debt is
    // surfaced in the billing console (spec 04).
    return fail("card declined");
  }
}
