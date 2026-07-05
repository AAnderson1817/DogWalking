// stripe-webhook event dispatch (spec 04), dependency-injected for tests.
// Signature verification and the idempotency ledger happen in index.ts /
// recordEvent; this module maps verified events onto DB effects.

export interface StripeEventLike {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export interface ClientRow {
  id: string;
  operator_id: string;
  full_name: string;
  plan_id: string | null;
  subscription_status: string;
}

export interface PlanRow {
  id: string;
  credits_per_cycle: number;
  stripe_price_id: string | null;
}

export interface WebhookDeps {
  /** Insert into stripe_events; false ⇒ duplicate (already processed). */
  recordEvent(id: string, type: string, payload: unknown): Promise<boolean>;
  findClientByCustomer(customerId: string): Promise<ClientRow | null>;
  getPlan(planId: string): Promise<PlanRow | null>;
  findPlanByPriceId(operatorId: string, priceId: string): Promise<PlanRow | null>;
  updateClient(id: string, fields: Record<string, unknown>): Promise<void>;
  applyRollover(clientId: string): Promise<void>;
  grantCredits(clientId: string, amount: number, note: string): Promise<void>;
  insertPayment(row: Record<string, unknown>): Promise<void>;
  insertNotification(row: Record<string, unknown>): Promise<void>;
}

/**
 * Process one verified Stripe event. Returns what happened; the HTTP layer
 * always replies 200 to verified events regardless (spec 04).
 */
export async function handleStripeEvent(
  event: StripeEventLike,
  deps: WebhookDeps,
): Promise<{ status: "processed" | "duplicate" | "ignored" }> {
  const fresh = await deps.recordEvent(event.id, event.type, event);
  if (!fresh) return { status: "duplicate" };

  const obj = event.data.object;

  switch (event.type) {
    case "checkout.session.completed": {
      const meta = (obj.metadata ?? {}) as Record<string, string>;
      const clientId = meta.client_id;
      if (!clientId || (obj.mode ?? "subscription") !== "subscription") {
        return { status: "ignored" };
      }
      const fields: Record<string, unknown> = {
        stripe_subscription_id: obj.subscription ?? null,
        subscription_status: "active",
      };
      if (meta.plan_id) fields.plan_id = meta.plan_id;
      if (obj.customer) fields.stripe_customer_id = obj.customer;
      await deps.updateClient(clientId, fields);
      return { status: "processed" };
    }

    case "invoice.paid": {
      if (!invoiceSubscriptionId(obj)) return { status: "ignored" };
      const client = await deps.findClientByCustomer(String(obj.customer ?? ""));
      if (!client) return { status: "ignored" };

      const plan = await resolvePlan(client, obj, deps);
      if (!plan) return { status: "ignored" };
      if (client.plan_id !== plan.id) {
        await deps.updateClient(client.id, { plan_id: plan.id });
      }

      // Cycle boundary: rollover BEFORE the new cycle's grant (spec 02).
      await deps.applyRollover(client.id);
      await deps.grantCredits(
        client.id,
        plan.credits_per_cycle,
        `cycle grant ${obj.id ?? event.id}`,
      );
      await deps.insertPayment({
        operator_id: client.operator_id,
        client_id: client.id,
        type: "subscription",
        amount_pence: (obj.amount_paid as number) ?? 0,
        status: "succeeded",
        stripe_invoice_id: obj.id ?? null,
        receipt_url: obj.hosted_invoice_url ?? null,
      });
      return { status: "processed" };
    }

    case "invoice.payment_failed": {
      const client = await deps.findClientByCustomer(String(obj.customer ?? ""));
      if (!client) return { status: "ignored" };
      await deps.updateClient(client.id, { subscription_status: "past_due" });
      await deps.insertPayment({
        operator_id: client.operator_id,
        client_id: client.id,
        type: "subscription",
        amount_pence: (obj.amount_due as number) ?? 0,
        status: "failed",
        stripe_invoice_id: obj.id ?? null,
        receipt_url: null,
      });
      await deps.insertNotification({
        operator_id: client.operator_id,
        client_id: client.id,
        type: "payment_failed",
        title: "Payment failed",
        body: "Your subscription payment failed. Please update your payment method — we'll retry automatically.",
        walk_id: null,
      });
      await deps.insertNotification({
        operator_id: client.operator_id,
        client_id: null,
        type: "payment_failed",
        title: `Payment failed for ${client.full_name}`,
        body: "Stripe will retry automatically; the account is past due until it succeeds.",
        walk_id: null,
      });
      return { status: "processed" };
    }

    case "invoice.upcoming": {
      const client = await deps.findClientByCustomer(String(obj.customer ?? ""));
      if (!client) return { status: "ignored" };
      await deps.insertNotification({
        operator_id: client.operator_id,
        client_id: client.id,
        type: "renewal_upcoming",
        title: "Your plan renews soon",
        body: "Your next cycle's credits will be granted when the renewal payment completes.",
        walk_id: null,
      });
      return { status: "processed" };
    }

    case "customer.subscription.updated": {
      const client = await deps.findClientByCustomer(String(obj.customer ?? ""));
      if (!client) return { status: "ignored" };
      const fields: Record<string, unknown> = {
        stripe_subscription_id: obj.id ?? null,
        subscription_status: mapSubscriptionStatus(obj),
      };
      const periodEnd = subscriptionPeriodEnd(obj);
      if (periodEnd) fields.current_period_end = periodEnd;
      await deps.updateClient(client.id, fields);
      return { status: "processed" };
    }

    case "customer.subscription.deleted": {
      const client = await deps.findClientByCustomer(String(obj.customer ?? ""));
      if (!client) return { status: "ignored" };
      await deps.updateClient(client.id, { subscription_status: "cancelled" });
      return { status: "processed" };
    }

    default:
      return { status: "ignored" };
  }
}

function invoiceSubscriptionId(obj: Record<string, unknown>): string | null {
  if (typeof obj.subscription === "string" && obj.subscription) return obj.subscription;
  const parent = obj.parent as { subscription_details?: { subscription?: string } } | undefined;
  return parent?.subscription_details?.subscription ?? null;
}

async function resolvePlan(
  client: ClientRow,
  invoice: Record<string, unknown>,
  deps: WebhookDeps,
): Promise<PlanRow | null> {
  if (client.plan_id) {
    const plan = await deps.getPlan(client.plan_id);
    if (plan) return plan;
  }
  // First invoice can arrive before checkout.session.completed binds the
  // plan; fall back to matching the invoice line price against plans.
  const lines = (invoice.lines as { data?: Array<Record<string, unknown>> })?.data ?? [];
  for (const line of lines) {
    const price = (line.price as { id?: string })?.id ??
      (line.pricing as { price_details?: { price?: string } })?.price_details?.price;
    if (price) {
      const plan = await deps.findPlanByPriceId(client.operator_id, price);
      if (plan) return plan;
    }
  }
  return null;
}

/** Renewal date cache for the billing console (phase 07). Newer Stripe API
 * versions carry the period on the subscription item. */
function subscriptionPeriodEnd(sub: Record<string, unknown>): string | null {
  const direct = sub.current_period_end as number | undefined;
  const item = (sub.items as { data?: Array<{ current_period_end?: number }> })?.data?.[0];
  const epoch = direct ?? item?.current_period_end;
  return epoch ? new Date(epoch * 1000).toISOString() : null;
}

/** Map a Stripe subscription object onto our subscription_status enum. */
export function mapSubscriptionStatus(sub: Record<string, unknown>): string {
  if (sub.pause_collection) return "paused";
  switch (sub.status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
      return "cancelled";
    case "paused":
      return "paused";
    default:
      return "active";
  }
}
