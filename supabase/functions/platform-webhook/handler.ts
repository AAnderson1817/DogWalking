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
// Both rules are enforced IN THE WRITE, not only at the read (Codex review
// on PR #77): deliveries overlap, so a rule applied by reading the row and
// deciding in memory evaporates in the gap before the write — a deleted
// landing inside payment_failed's gap used to resurrect the row to grace.
// Every updateOperator call therefore carries an OperatorWriteGuard whose
// predicates PostgREST evaluates atomically inside the UPDATE itself; the
// in-memory checks remain only as cheap short-circuits and to pick which
// bell to ring. `guardAdmits` below is the single specification of what a
// guard means — the index.ts translation to PostgREST filters and the test
// double both answer to it.
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

/**
 * Predicates a status write carries INTO the UPDATE statement, so the rule
 * they express holds against writes landing after this arm's read. All are
 * ANDed. `guardAdmits` is the executable specification.
 */
export interface OperatorWriteGuard {
  /** The write belongs to this binding: apply only while
   * platform_subscription_id still equals it. A late event of a replaced
   * subscription then no-ops instead of mutating its successor's row. */
  whileBoundTo?: string;
  /** The row may TAKE this binding (rule 2, atomically): binding is null,
   * or dead and different (rebind over a tombstone), or already this id and
   * not dead (idempotent re-write). Refuses both a live different binding
   * (duplicate subscription) and a same-id resurrection (rule 1). */
  bindableTo?: string;
  /** Refuse when the row's status is any of these. Carries the terminal
   * 'cancelled' rule and the bell transition-gates ('past_due' on dunning
   * writes) — the returned count is then the transition signal. */
  unlessStatusIn?: string[];
}

/** What a guard MEANS, one place. The stateful test double evaluates this,
 * and index.ts's PostgREST translation is pinned against it. */
export function guardAdmits(
  guard: OperatorWriteGuard | undefined,
  row: { platform_subscription_id: string | null; platform_subscription_status: string },
): boolean {
  if (!guard) return true;
  for (const s of guard.unlessStatusIn ?? []) {
    if (row.platform_subscription_status === s) return false;
  }
  if (guard.whileBoundTo !== undefined && row.platform_subscription_id !== guard.whileBoundTo) {
    return false;
  }
  if (guard.bindableTo !== undefined) {
    const id = row.platform_subscription_id;
    const dead = row.platform_subscription_status === "cancelled";
    const admits = id === null ||
      (dead && id !== guard.bindableTo) ||
      (id === guard.bindableTo && !dead);
    if (!admits) return false;
  }
  return true;
}

/**
 * The bindableTo guard reaches PostgREST as an or-filter with the id
 * embedded in the filter STRING, so the id must not carry filter syntax.
 * Stripe ids are `[A-Za-z0-9_]+`; anything else on a signature-verified
 * platform event is malformed enough to refuse outright.
 */
export function assertFilterSafeId(id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`subscription id unsafe for a PostgREST filter: ${JSON.stringify(id)}`);
  }
}

export interface PlatformWebhookDeps {
  /** Same stripe_events claim ledger as stripe-webhook — event ids are
   * globally unique, so the two endpoints cannot collide. */
  claimEvent(id: string, type: string, payload: unknown): Promise<ClaimResult>;
  markProcessed(id: string): Promise<void>;
  findOperatorById(id: string): Promise<OperatorBillingRef | null>;
  findOperatorBySubscription(subscriptionId: string): Promise<OperatorBillingRef | null>;
  findOperatorByCustomer(customerId: string): Promise<OperatorBillingRef | null>;
  /** Update the operator's platform billing fields, guarded atomically —
   * the guard's predicates run inside the UPDATE, and the returned count is
   * both the race outcome and the transition signal that gates bells. */
  updateOperator(
    id: string,
    fields: Record<string, unknown>,
    guard?: OperatorWriteGuard,
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

      const duplicateBell = () =>
        // A second completed session while a LIVE subscription is bound:
        // two subscriptions now bill at Stripe. Never clobber the binding —
        // the sibling subscription arm has always refused this — but never
        // stay silent either: an invisible duplicate is $49/month the
        // operator cannot see from inside the product.
        deps.insertNotification({
          operator_id: op.id,
          client_id: null,
          type: "payment_taken",
          title: "A second Sanpo subscription was created",
          body:
            "A checkout completed while you already had a live Sanpo subscription, so Stripe now holds two. Open Settings → Manage billing and cancel the extra one.",
        });

      if (
        op.platform_subscription_id !== null &&
        op.platform_subscription_id !== subscriptionId &&
        !bindingReplaceable(op)
      ) {
        await duplicateBell();
        return { status: "processed" };
      }

      // The H32 lesson, applied before it can bite: a delayed-notification
      // payment method completes the session with payment_status 'unpaid',
      // and 'active' on an unpaid session is service granted for money that
      // may never arrive. A trial's first session is 'no_payment_required'.
      const paid = obj.payment_status === "paid" ||
        obj.payment_status === "no_payment_required";
      const wrote = await deps.updateOperator(op.id, {
        platform_subscription_id: subscriptionId,
        ...(paid ? { platform_subscription_status: "active" } : {}),
      }, { bindableTo: subscriptionId });
      if (wrote === 0) {
        // The read above raced a concurrent write. Re-read to tell WHICH
        // refusal this was: a rival session's binding won the gap (ring the
        // duplicate bell the pre-check would have rung), or this same
        // subscription was cancelled before its completed event landed
        // (rule 1 — stay silent, the row is correct as it stands).
        const now = await deps.findOperatorById(operatorId);
        if (
          now &&
          now.platform_subscription_id !== null &&
          now.platform_subscription_id !== subscriptionId &&
          !bindingReplaceable(now)
        ) {
          await duplicateBell();
        }
      }
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
        // event of the dead subscription must not revive it — the cheap
        // read-time short-circuit; the write guard below re-enforces it
        // atomically for the delivery that races the deletion.
        if (op.platform_subscription_status === "cancelled" && mapped !== "cancelled") {
          return { status: "ignored" };
        }
      } else if (customerId && mapped !== "cancelled") {
        // subscription.created can beat checkout.session.completed — and a
        // resubscribe's completed event can be lost outright — so a NEW
        // subscription binds through the customer wherever the existing
        // binding is null or dead (rule 2). A row bound to a DIFFERENT live
        // subscription is never clobbered by some other subscription's
        // event. A DEAD subscription claims nothing: stamping a tombstone
        // onto a never-subscribed row is excluded before the lookup.
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
          { bindableTo: subscriptionId, unlessStatusIn: ["past_due"] },
        );
        if (changed > 0) {
          await deps.insertNotification({ operator_id: op.id, client_id: null, ...PAST_DUE_BELL });
        }
        return { status: "processed" };
      }

      if (mapped === "cancelled") {
        // subscription.updated can carry `canceled`/`incomplete_expired`
        // itself. Same terminal write and same transition-gated bell as the
        // deleted arm — whichever of the two deliveries lands first tells
        // the operator once, and the loser's write is refused by the guard.
        const changed = await deps.updateOperator(
          op.id,
          { platform_subscription_status: "cancelled" },
          { whileBoundTo: subscriptionId, unlessStatusIn: ["cancelled"] },
        );
        if (changed > 0) {
          await deps.insertNotification({
            operator_id: op.id,
            client_id: null,
            type: "subscription_cancelled",
            title: "Your Sanpo subscription has ended",
            body:
              "Your Sanpo subscription is cancelled. Subscribe again from Settings to keep using Sanpo.",
          });
        }
        return { status: "processed" };
      }

      await deps.updateOperator(op.id, {
        platform_subscription_id: subscriptionId,
        platform_subscription_status: mapped,
      }, { bindableTo: subscriptionId });
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
      // whileBoundTo pins the cancel to the binding it belongs to: if a
      // rebind won the gap since the read, this late deleted must miss the
      // successor's row rather than cancel a subscription that is alive.
      const changed = await deps.updateOperator(
        op.id,
        { platform_subscription_status: "cancelled" },
        { whileBoundTo: subscriptionId, unlessStatusIn: ["cancelled"] },
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
      // either order, and after deleted the row must stay cancelled. The
      // read-time check is the cheap path; 'cancelled' in the write guard
      // is what holds when the deleted lands inside this arm's gap.
      if (op.platform_subscription_status === "cancelled") {
        return { status: "ignored" };
      }
      const changed = await deps.updateOperator(
        op.id,
        { platform_subscription_status: "past_due" },
        { whileBoundTo: subscriptionId, unlessStatusIn: ["past_due", "cancelled"] },
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
