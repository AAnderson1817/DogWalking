// stripe-webhook event dispatch (spec 04), dependency-injected for tests.
// Signature verification happens in index.ts; this module maps verified
// events onto DB effects.
//
// Idempotency (re-review hardening): stripe_events is a STATEFUL claim
// ledger — rows are never deleted. claimEvent inserts status='processing';
// markProcessed flips it after effects succeed. A duplicate delivery of an
// event whose claim is 'processing' is NOT acknowledged (in_flight → the
// HTTP layer returns 409 so Stripe keeps retrying) — acking it while the
// claimant could still fail is how grants got lost. A claim stuck in
// 'processing' past its lease is taken over by the next retry.

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
  stripe_subscription_id: string | null;
}

export interface PlanRow {
  id: string;
  credits_per_cycle: number;
  stripe_price_id: string | null;
}

export type ClaimResult = "fresh" | "duplicate" | "in_flight";

export interface WebhookDeps {
  /** Claim the event: 'fresh' (we process it), 'duplicate' (already
   * processed — ack), 'in_flight' (another attempt holds a live claim —
   * do NOT ack; let Stripe retry). */
  claimEvent(id: string, type: string, payload: unknown): Promise<ClaimResult>;
  /** Mark the claim durable after all effects succeeded. */
  markProcessed(id: string): Promise<void>;
  findClientByCustomer(customerId: string): Promise<ClientRow | null>;
  getPlan(planId: string): Promise<PlanRow | null>;
  findPlanByPriceId(operatorId: string, priceId: string): Promise<PlanRow | null>;
  updateClient(id: string, fields: Record<string, unknown>): Promise<void>;
  findPendingPlanChangeIntent(args: {
    clientId: string;
    subscriptionId: string | null;
    planId: string | null;
    metadataIntentId: string | null;
  }): Promise<{ id: string; new_plan_id: string } | null>;
  applyPlanChangeIntent(intentId: string, eventId: string): Promise<number>;
  /** Atomic + idempotent invoice effects (fn_apply_invoice_paid RPC):
   * payment row + rollover + cycle grant in one transaction keyed on the
   * invoice id. Returns false when the invoice was already applied. */
  applyInvoicePaid(args: {
    clientId: string;
    credits: number;
    invoiceId: string;
    amountPence: number;
    currency: string;
    receiptUrl: string | null;
  }): Promise<boolean>;
  /** True when a payments row already exists for this invoice id. */
  hasPaymentForInvoice(invoiceId: string): Promise<boolean>;
  insertPayment(row: Record<string, unknown>): Promise<void>;
  insertNotification(row: Record<string, unknown>): Promise<void>;
}

export class InFlightError extends Error {
  constructor() {
    super("event claim is in flight");
  }
}

/**
 * Process one verified Stripe event. 'duplicate'/'ignored'/'processed' are
 * acked with 200 by the HTTP layer; InFlightError → 409; any other throw →
 * 500 (the claim stays 'processing' and the next retry takes it over after
 * the lease).
 */
export async function handleStripeEvent(
  event: StripeEventLike,
  deps: WebhookDeps,
): Promise<{ status: "processed" | "duplicate" | "ignored" }> {
  const claim = await deps.claimEvent(event.id, event.type, event);
  if (claim === "duplicate") return { status: "duplicate" };
  if (claim === "in_flight") throw new InFlightError();

  const result = await applyEvent(event, deps);
  await deps.markProcessed(event.id);
  return result;
}

const CYCLE_REASONS = new Set(["subscription_create", "subscription_cycle"]);

async function applyEvent(
  event: StripeEventLike,
  deps: WebhookDeps,
): Promise<{ status: "processed" | "ignored" }> {
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
      const invoiceId = typeof obj.id === "string" ? obj.id : event.id;
      const currency = String(obj.currency ?? "usd");

      // Only a new subscription or a renewal is a credit-cycle boundary.
      // Prorations/manual invoices must not grant a cycle or trigger
      // rollover (which, on rollover 'none', would wipe the balance
      // mid-period) — but the money movement is still recorded.
      const reason = typeof obj.billing_reason === "string" ? obj.billing_reason : "";
      if (!CYCLE_REASONS.has(reason)) {
        if (!(await deps.hasPaymentForInvoice(invoiceId))) {
          await deps.insertPayment({
            operator_id: client.operator_id,
            client_id: client.id,
            type: "subscription",
            amount_pence: (obj.amount_paid as number) ?? 0,
            currency: currency.toUpperCase(),
            status: "succeeded",
            stripe_invoice_id: invoiceId,
            receipt_url: obj.hosted_invoice_url ?? null,
          });
        }
        return { status: "processed" };
      }

      const plan = await resolvePlan(client, obj, deps);
      if (!plan) return { status: "ignored" };
      if (client.plan_id !== plan.id) {
        await deps.updateClient(client.id, { plan_id: plan.id });
      }

      await deps.applyInvoicePaid({
        clientId: client.id,
        credits: plan.credits_per_cycle,
        invoiceId,
        amountPence: (obj.amount_paid as number) ?? 0,
        currency,
        receiptUrl: (obj.hosted_invoice_url as string | null) ?? null,
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
        currency: String(obj.currency ?? "usd").toUpperCase(),
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
      const subId = typeof obj.id === "string" ? obj.id : null;
      const mapped = mapSubscriptionStatus(obj);
      // A customer can carry a stale/second subscription; only act on the
      // one bound to the client so an old sub can't clobber the active one.
      if (client.stripe_subscription_id && subId && client.stripe_subscription_id !== subId) {
        return { status: "ignored" };
      }
      // Unbound client (checkout.session.completed not yet delivered —
      // Stripe does not guarantee ordering): only let a LIVE subscription
      // bind; a stale sub's cancelled/past_due update must not seed state.
      if (!client.stripe_subscription_id && mapped !== "active" && mapped !== "paused") {
        return { status: "ignored" };
      }
      const fields: Record<string, unknown> = {
        stripe_subscription_id: subId,
        subscription_status: mapped,
      };
      const periodEnd = subscriptionPeriodEnd(obj);
      if (periodEnd) fields.current_period_end = periodEnd;

      const priceId = subscriptionPriceId(obj);
      const plan = priceId ? await deps.findPlanByPriceId(client.operator_id, priceId) : null;
      const meta = (obj.metadata ?? {}) as Record<string, unknown>;
      const metadataIntentId = typeof meta.pawtrail_plan_change_intent_id === "string"
        ? meta.pawtrail_plan_change_intent_id
        : null;
      // Only two matches are safe: the exact intent id stamped into the
      // subscription's metadata by change-plan, or (for pre-intent subs with
      // no metadata) sub + resolved plan — proof the price really moved to
      // the intent's target. Anything looser can apply an orphaned intent on
      // an unrelated subscription event and diverge local plan/credits from
      // what Stripe is actually billing.
      const canMatchIntent = metadataIntentId !== null || (subId !== null && plan !== null);
      const intent = canMatchIntent
        ? await deps.findPendingPlanChangeIntent({
          clientId: client.id,
          subscriptionId: subId,
          planId: plan?.id ?? null,
          metadataIntentId,
        })
        : null;
      if (intent) {
        await deps.applyPlanChangeIntent(intent.id, event.id);
        fields.plan_id = intent.new_plan_id;
      }

      await deps.updateClient(client.id, fields);
      return { status: "processed" };
    }

    case "customer.subscription.deleted": {
      const client = await deps.findClientByCustomer(String(obj.customer ?? ""));
      if (!client) return { status: "ignored" };
      const subId = typeof obj.id === "string" ? obj.id : null;
      // Never let a deletion of a sub that isn't the client's current one
      // (stale sub, or any sub while unbound mid-checkout) flip the account.
      if (!client.stripe_subscription_id) return { status: "ignored" };
      if (subId && client.stripe_subscription_id !== subId) {
        return { status: "ignored" };
      }
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

function subscriptionPriceId(obj: Record<string, unknown>): string | null {
  const items = (obj.items as { data?: Array<Record<string, unknown>> })?.data ?? [];
  const first = items[0];
  const price = first?.price as { id?: string } | undefined;
  return price?.id ?? null;
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
