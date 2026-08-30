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
// Stripe guarantees NEITHER ordering NOR single delivery, and the claim
// ledger dedupes only identical event ids — dunning exhaustion emits the
// final invoice.payment_failed and customer.subscription.deleted moments
// apart in either order, and a delivery that 500'd is retried for days. The
// H31 adversarial review broke the first version of this file on exactly
// that: a late payment_failed resurrected a cancelled row to past_due —
// grace, i.e. free access forever, with the honest resubscribe then refused
// as already_subscribed. Hence the two structural rules below:
//
//   1. `cancelled` is TERMINAL for the subscription id it died with. The
//      deleted arm keeps platform_subscription_id as a tombstone, and every
//      other arm that finds the operator BY that id refuses to write — a
//      dead subscription emits nothing that can legitimately revive it.
//   2. A NEW subscription may replace a dead binding. The customer fallback
//      and the checkout arm both rebind when the existing binding is null
//      or cancelled — which is also what heals a resubscribe whose
//      checkout.session.completed was lost — and never when it is live:
//      a live binding is only ever replaced by nothing.
//
// Known residual, accepted: two subscriptions created AND cancelled inside
// Stripe's ~3-day redelivery window, followed by a redelivered stale live
// event of the older one, could rebind the older dead id. That needs three
// independent rarities and self-corrects on the next real event; guarding
// it would need a tombstone table.
//
// No payments rows are written here, deliberately: payments is tenant-scoped
// (client_id NOT NULL) and records money moving TO operators. Sanpo's own
// revenue has Stripe's platform account as its book of record.
import { invoiceSubscriptionId } from "../_lib/stripe_shapes.ts";

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
  /** The current status is an INPUT to every write decision here — the
   * terminal-cancelled rule cannot be expressed without it. */
  platform_subscription_status: string;
}

export interface PlatformWebhookDeps {
  /** Same stripe_events claim ledger as stripe-webhook — event ids are
   * globally unique, so the two endpoints cannot collide. */
  claimEvent(id: string, type: string, payload: unknown): Promise<ClaimResult>;
  markProcessed(id: string): Promise<void>;
  findOperatorById(id: string): Promise<OperatorBillingRef | null>;
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
 *
 * `unpaid` maps to past_due, which is GRACE — correct only while the
 * dashboard's dunning setting cancels a subscription when retries exhaust
 * (the default). Both runbooks pin that setting in bold, because under
 * "mark as unpaid" this mapping would leave a non-payer in grace forever.
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

/** Rule 2 above: only a null or dead binding may be replaced. */
function bindingReplaceable(op: OperatorBillingRef): boolean {
  return op.platform_subscription_id === null ||
    op.platform_subscription_status === "cancelled";
}

const PAST_DUE_BELL = {
  type: "payment_failed",
  title: "Sanpo subscription payment failed",
  body:
    "Your Sanpo subscription payment did not go through. Update your card in Settings → Manage billing to keep your subscription active.",
};

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
      const op = await deps.findOperatorById(operatorId);
      if (!op) return { status: "ignored" };

      if (
        op.platform_subscription_id !== null &&
        op.platform_subscription_id !== subscriptionId &&
        !bindingReplaceable(op)
      ) {
        // A second completed session while a LIVE subscription is bound:
        // two subscriptions now bill at Stripe. Never clobber the binding —
        // the sibling subscription arm has always refused this — but never
        // stay silent either: an invisible duplicate is $49/month the
        // operator cannot see from inside the product.
        await deps.insertNotification({
          operator_id: op.id,
          client_id: null,
          type: "payment_taken",
          title: "A second Sanpo subscription was created",
          body:
            "A checkout completed while you already had a live Sanpo subscription, so Stripe now holds two. Open Settings → Manage billing and cancel the extra one.",
        });
        return { status: "processed" };
      }

      // The H32 lesson, applied before it can bite: a delayed-notification
      // payment method completes the session with payment_status 'unpaid',
      // and 'active' on an unpaid session is service granted for money that
      // may never arrive. A trial's first session is 'no_payment_required'.
      const paid = obj.payment_status === "paid" ||
        obj.payment_status === "no_payment_required";
      await deps.updateOperator(op.id, {
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
      if (op) {
        // Rule 1: the id it died with is terminal. A redelivered or late
        // event of the dead subscription must not revive it; only the
        // deleted arm's own idempotent write may touch a cancelled row.
        if (op.platform_subscription_status === "cancelled" && mapped !== "cancelled") {
          return { status: "ignored" };
        }
      } else if (customerId) {
        // subscription.created can beat checkout.session.completed — and a
        // resubscribe's completed event can be lost outright — so a NEW
        // subscription binds through the customer wherever the existing
        // binding is null or dead (rule 2). A row bound to a DIFFERENT live
        // subscription is never clobbered by some other subscription's
        // event.
        const byCustomer = await deps.findOperatorByCustomer(customerId);
        if (byCustomer && bindingReplaceable(byCustomer)) op = byCustomer;
      }
      if (!op) return { status: "ignored" };

      if (mapped === "past_due") {
        // The dunning bell lives on the TRANSITION, and Stripe emits
        // subscription.updated(past_due) and invoice.payment_failed for the
        // same failure in either order — so both arms gate on the same
        // status flip and whichever processes first rings the one bell
        // (the H13 lesson, extended to the race the review found).
        const changed = await deps.updateOperator(
          op.id,
          {
            platform_subscription_id: subscriptionId,
            platform_subscription_status: "past_due",
          },
          "past_due",
        );
        if (changed > 0) {
          await deps.insertNotification({ operator_id: op.id, client_id: null, ...PAST_DUE_BELL });
        }
        return { status: "processed" };
      }

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
      // platform_subscription_id is deliberately KEPT: it is the tombstone
      // rule 1 reads. Nulling it here would let a redelivered live event of
      // this same subscription rebind through the customer fallback.
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
      // Both invoice shapes: Stripe's Basil release moved the subscription
      // reference, and the endpoint's API version — not the SDK pin —
      // decides which shape arrives (see _lib/stripe_shapes.ts).
      const subscriptionId = invoiceSubscriptionId(obj);
      if (!subscriptionId) return { status: "ignored" };
      const op = await deps.findOperatorBySubscription(subscriptionId);
      if (!op) return { status: "ignored" };
      // Rule 1 again: dunning exhaustion delivers this and deleted in
      // either order, and after deleted the row must stay cancelled.
      if (op.platform_subscription_status === "cancelled") {
        return { status: "ignored" };
      }
      const changed = await deps.updateOperator(
        op.id,
        { platform_subscription_status: "past_due" },
        "past_due",
      );
      if (changed > 0) {
        await deps.insertNotification({ operator_id: op.id, client_id: null, ...PAST_DUE_BELL });
      }
      return { status: "processed" };
    }

    default:
      return { status: "ignored" };
  }
}
