// platform-webhook event dispatch (review H31), dependency-injected for
// tests. Signature verification happens in index.ts; this module maps
// verified PLATFORM-account events — the operator's own $49/month Sanpo
// subscription — onto operators.platform_* state.
//
// The mirror image of stripe-webhook: that endpoint listens on CONNECTED
// accounts and ignores any event with no `account`; this one listens on
// "Your account" and ignores any event WITH one. A connected-account event
// arriving here means the Stripe endpoint is misconfigured, and processing
// it would put attacker-influenceable Connect data (session metadata any
// operator can mint in their own dashboard) adjacent to platform billing
// state. Platform events carry no such problem: only operator-billing mints
// platform sessions, so their metadata is ours.
//
// No payments rows are written here, deliberately: payments is tenant-scoped
// (client_id NOT NULL) and records money moving TO operators. Sanpo's own
// revenue has Stripe's platform account as its book of record.

export interface PlatformEventLike {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
  /** Present only on Connect events. This endpoint handles platform events,
   * so a value here means "not ours". */
  account?: string;
}

export type ClaimResult = "fresh" | "duplicate" | "in_flight";

export interface OperatorBillingRef {
  id: string;
  platform_subscription_id: string | null;
}

export interface PlatformWebhookDeps {
  /** Same stripe_events claim ledger as stripe-webhook — event ids are
   * globally unique, so the two endpoints cannot collide. */
  claimEvent(id: string, type: string, payload: unknown): Promise<ClaimResult>;
  markProcessed(id: string): Promise<void>;
  findOperatorBySubscription(subscriptionId: string): Promise<OperatorBillingRef | null>;
  findOperatorByCustomer(customerId: string): Promise<OperatorBillingRef | null>;
  /** Update the operator's platform billing fields. When `unlessStatus` is
   * given, rows already in that status are left untouched — the returned
   * count is then the transition signal that gates notifications, so a
   * redelivered dunning event does not ring the bell twice. */
  updateOperator(
    id: string,
    fields: Record<string, unknown>,
    unlessStatus?: string,
  ): Promise<number>;
  insertNotification(row: Record<string, unknown>): Promise<void>;
}

export class InFlightError extends Error {}

/**
 * Stripe subscription status → our enum. `trialing` is `active` on purpose:
 * the app-side gate already grants the trial window from trial_ends_at, and
 * a subscribed-but-still-trialing operator is a paying customer in waiting,
 * not a delinquent one. `incomplete` maps to null — an unfinished checkout
 * must never DOWNGRADE a live row (the no-guessing rule: an event that says
 * nothing definite changes nothing).
 */
export function mapPlatformSubscriptionStatus(stripeStatus: unknown): string | null {
  switch (stripeStatus) {
    case "trialing":
    case "active":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "paused":
      return "paused";
    case "canceled":
    case "incomplete_expired":
      return "cancelled";
    default:
      return null;
  }
}

interface HandleResult {
  status: "processed" | "duplicate" | "ignored";
}

export async function handlePlatformEvent(
  event: PlatformEventLike,
  deps: PlatformWebhookDeps,
): Promise<HandleResult> {
  if (event.account) {
    // Misconfigured endpoint delivering Connect events here: ignore, never
    // process. stripe-webhook owns those.
    return { status: "ignored" };
  }

  const claim = await deps.claimEvent(event.id, event.type, event);
  if (claim === "duplicate") return { status: "duplicate" };
  if (claim === "in_flight") throw new InFlightError();

  const result = await applyEvent(event, deps);
  await deps.markProcessed(event.id);
  return result;
}

async function applyEvent(
  event: PlatformEventLike,
  deps: PlatformWebhookDeps,
): Promise<HandleResult> {
  const obj = event.data.object;

  switch (event.type) {
    case "checkout.session.completed": {
      if (obj.mode !== "subscription") return { status: "ignored" };
      const meta = (obj.metadata ?? {}) as Record<string, string>;
      const operatorId = meta.operator_id;
      const subscriptionId = typeof obj.subscription === "string" ? obj.subscription : null;
      if (!operatorId || !subscriptionId) return { status: "ignored" };
      // The H32 lesson, applied before it can bite: a delayed-notification
      // payment method completes the session with payment_status 'unpaid',
      // and 'active' on an unpaid session is service granted for money that
      // may never arrive. A trial's first session is 'no_payment_required'.
      const paid = obj.payment_status === "paid" ||
        obj.payment_status === "no_payment_required";
      await deps.updateOperator(operatorId, {
        platform_subscription_id: subscriptionId,
        ...(paid ? { platform_subscription_status: "active" } : {}),
      });
      return { status: "processed" };
    }

    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const subscriptionId = typeof obj.id === "string" ? obj.id : null;
      const customerId = typeof obj.customer === "string" ? obj.customer : null;
      if (!subscriptionId) return { status: "ignored" };
      const mapped = mapPlatformSubscriptionStatus(obj.status);
      if (mapped === null) return { status: "ignored" };

      let op = await deps.findOperatorBySubscription(subscriptionId);
      if (!op && customerId) {
        // subscription.created can beat checkout.session.completed. Binding
        // through the customer is safe only while the operator has no bound
        // subscription: a row already bound to a DIFFERENT subscription must
        // not be clobbered by some other subscription's late event.
        const byCustomer = await deps.findOperatorByCustomer(customerId);
        if (byCustomer && byCustomer.platform_subscription_id === null) op = byCustomer;
      }
      if (!op) return { status: "ignored" };

      await deps.updateOperator(op.id, {
        platform_subscription_id: subscriptionId,
        platform_subscription_status: mapped,
      });
      return { status: "processed" };
    }

    case "customer.subscription.deleted": {
      const subscriptionId = typeof obj.id === "string" ? obj.id : null;
      if (!subscriptionId) return { status: "ignored" };
      const op = await deps.findOperatorBySubscription(subscriptionId);
      if (!op) return { status: "ignored" };
      const changed = await deps.updateOperator(
        op.id,
        { platform_subscription_status: "cancelled" },
        "cancelled",
      );
      if (changed > 0) {
        await deps.insertNotification({
          operator_id: op.id,
          client_id: null,
          type: "subscription_cancelled",
          title: "Your Sanpo subscription has ended",
          body: "Your Sanpo subscription is cancelled. Subscribe again from Settings to keep using Sanpo.",
        });
      }
      return { status: "processed" };
    }

    case "invoice.payment_failed": {
      const subscriptionId = typeof obj.subscription === "string" ? obj.subscription : null;
      if (!subscriptionId) return { status: "ignored" };
      const op = await deps.findOperatorBySubscription(subscriptionId);
      if (!op) return { status: "ignored" };
      // Transition-gated: Stripe redelivers payment_failed on every dunning
      // retry with a fresh event id the claim ledger cannot dedupe (the H13
      // lesson) — the status write is idempotent, and the bell rings only on
      // the transition into past_due.
      const changed = await deps.updateOperator(
        op.id,
        { platform_subscription_status: "past_due" },
        "past_due",
      );
      if (changed > 0) {
        await deps.insertNotification({
          operator_id: op.id,
          client_id: null,
          type: "payment_failed",
          title: "Sanpo subscription payment failed",
          body: "Your Sanpo subscription payment did not go through. Update your card in Settings → Manage billing to keep your subscription active.",
        });
      }
      return { status: "processed" };
    }

    default:
      return { status: "ignored" };
  }
}
