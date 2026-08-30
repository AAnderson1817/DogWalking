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

// The only imports in this module: `handler.ts` is otherwise entirely
// dependency-injected. Constants and pure helpers, not dependencies —
// and sharing the metadata keys with their writer is the point (review L23),
// as is sharing the invoice shape with platform-webhook.
import { MAX_TOPUP_CREDITS, STRIPE_META } from "../_lib/stripe_metadata.ts";
import { formatMoney } from "../_lib/money.ts";
import { invoiceSubscriptionId } from "../_lib/stripe_shapes.ts";

export interface StripeEventLike {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
  /** Set on every Connect event: the acct_… the event happened on. Absent on
   * platform-account events, which belong to platform-webhook (the operator's
   * own Sanpo subscription, review H31) and are ignored here — operators are
   * the merchant of record for client money (review B5). */
  account?: string;
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
  /** Scoped to the operator resolved from `event.account`. A Connect endpoint
   * receives events for EVERY connected account, so an unscoped lookup would
   * let one operator's Stripe account drive effects on another operator's
   * client — the tenancy boundary that `event.account` exists to draw. */
  findClientByCustomer(customerId: string, operatorId: string): Promise<ClientRow | null>;
  /** acct_… → operator id, or null when the account belongs to nobody here. */
  resolveOperatorByAccount(accountId: string): Promise<string | null>;
  /** Mirror Stripe's view of the connected account onto operators.*. */
  updateConnectState(accountId: string, fields: Record<string, unknown>): Promise<void>;
  getPlan(planId: string): Promise<PlanRow | null>;
  findPlanByPriceId(operatorId: string, priceId: string): Promise<PlanRow | null>;
  /** Scoped: the update must match BOTH the client id and the operator the
   * event's account resolved to. Session metadata is attacker-controlled on a
   * Connect endpoint — an operator can craft a Checkout Session in their own
   * dashboard carrying another operator's client_id — so the id alone is not
   * an authorization. Returns the number of rows actually changed. */
  updateClient(id: string, fields: Record<string, unknown>, operatorId: string): Promise<number>;
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
    /** TRUE only for subscription_cycle. Rollover carries what is left of the
     * cycle that just ended, and a first invoice has no prior cycle — running
     * it there books an expiry for the whole balance on rollover 'none',
     * destroying credit granted before billing started. */
    isRenewal: boolean;
  }): Promise<boolean>;
  /** True when a SUCCEEDED (or reversed) payments row exists for this invoice. */
  hasPaymentForInvoice(invoiceId: string): Promise<boolean>;
  /** True when a failed row already exists for this invoice — Stripe redelivers
   * invoice.payment_failed on every dunning retry, each with a fresh event id
   * the claim ledger cannot dedupe. */
  hasFailedPaymentForInvoice(invoiceId: string): Promise<boolean>;
  /** Atomic + idempotent top-up effects (fn_apply_topup RPC, 0044): payment
   * row + credit grant in one transaction keyed on the PaymentIntent id.
   * Returns false when this intent was already applied — including a
   * redelivery after the payment was refunded, which must not grant again. */
  applyTopup(args: {
    clientId: string;
    credits: number;
    paymentIntentId: string;
    amountPence: number;
  }): Promise<boolean>;
  insertPayment(row: Record<string, unknown>): Promise<void>;
  insertNotification(row: Record<string, unknown>): Promise<void>;

  /** Locate the payments row a Stripe reversal refers to. Tried in the order
   * the identifiers are trustworthy: the payment intent (what overage rows
   * store), then the invoice (what subscription rows store), then the charge
   * id we may have recorded on a previous reversal. */
  findPaymentForReversal(ref: {
    paymentIntentId?: string | null;
    invoiceId?: string | null;
    chargeId?: string | null;
    /** Same boundary: only this operator's payments are reversible by this
     * account's events, whatever Stripe id the event carries. */
    operatorId: string;
  }): Promise<PaymentRow | null>;
  /** fn_reverse_payment: definer, per-client row lock, ledger-only balance
   * movement. p_amount_pence is the CUMULATIVE reversed total. */
  reversePayment(args: {
    paymentId: string;
    kind: "refund" | "dispute";
    amountPence: number;
    reason: string;
  }): Promise<ReversalResult>;
  /** Records the charge id once we learn it, so a later dispute on the same
   * charge is findable even when it carries no payment intent. */
  noteChargeId(paymentId: string, chargeId: string): Promise<void>;
}

export interface PaymentRow {
  id: string;
  operator_id: string;
  client_id: string;
  type: string;
  amount_pence: number;
  status: string;
  stripe_charge_id: string | null;
}

export interface ReversalResult {
  outcome: "reversed" | "noop";
  credits_reversed: number;
  credits_unrecovered: number;
  needs_review: boolean;
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

/**
 * The Sanpo top-up shape of a Checkout Session object, or null when the
 * session is not ours or is malformed. Everything here is attacker-controlled
 * on a Connect endpoint (any operator can mint a session in their own
 * dashboard carrying any metadata), so this validates shape only — the
 * tenancy control is the customer→client lookup scoped to the event's
 * operator, in applyTopupFromSession. An operator inflating credits for
 * their own client gains nothing they do not already have through
 * fn_adjust_credits.
 */
function parseTopupSession(
  obj: Record<string, unknown>,
): { credits: number; paymentIntentId: string; amountPence: number } | null {
  const meta = (obj.metadata ?? {}) as Record<string, string>;
  const creditsRaw = meta[STRIPE_META.topupCredits];
  if (!creditsRaw) return null;
  const credits = Number(creditsRaw);
  if (!Number.isInteger(credits) || credits <= 0 || credits > MAX_TOPUP_CREDITS) {
    // Past the bound, fn_apply_topup's int parameter cannot encode the value:
    // applying would 500 on every retry with the money already taken. Only a
    // dashboard-crafted session can carry one (create-checkout refuses first).
    return null;
  }
  const pi = typeof obj.payment_intent === "string" ? obj.payment_intent : null;
  if (!pi) return null;
  const amount = obj.amount_total;
  // A session with no positive amount is outside the contract of anything
  // create-checkout mints; recording it would write an unrefundable $0
  // 'succeeded' row (fn_apply_topup refuses those too — this is the outer
  // wall of the same rule).
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) return null;
  return { credits, paymentIntentId: pi, amountPence: amount };
}

/** Resolve the client through the session's CUSTOMER scoped to the event's
 * operator — a crafted session naming another tenant's customer resolves to
 * nothing — then apply atomically and announce once. */
async function applyTopupFromSession(
  topup: { credits: number; paymentIntentId: string; amountPence: number },
  obj: Record<string, unknown>,
  operatorId: string,
  deps: WebhookDeps,
): Promise<{ status: "processed" | "ignored" }> {
  const client = await deps.findClientByCustomer(String(obj.customer ?? ""), operatorId);
  if (!client) return { status: "ignored" };

  const applied = await deps.applyTopup({
    clientId: client.id,
    credits: topup.credits,
    paymentIntentId: topup.paymentIntentId,
    amountPence: topup.amountPence,
  });
  // Notify only when this delivery actually granted: Stripe redelivers for
  // three days, and a bell row per redelivery would announce one payment
  // several times.
  if (applied) {
    const money = formatMoney(topup.amountPence);
    const plural = topup.credits === 1 ? "credit" : "credits";
    await deps.insertNotification({
      operator_id: operatorId,
      client_id: client.id,
      type: "payment_taken",
      title: `Top-up received — ${topup.credits} ${plural} added`,
      body: `Your ${money} top-up went through and ${topup.credits} ${plural} ` +
        "were added to your balance.",
      walk_id: null,
    });
    await deps.insertNotification({
      operator_id: operatorId,
      client_id: null,
      type: "payment_taken",
      title: `${client.full_name} topped up ${topup.credits} ${plural}`,
      body: `${money} was collected. The credits are already on their balance.`,
      walk_id: null,
    });
  }
  return { status: "processed" };
}

async function applyEvent(
  event: StripeEventLike,
  deps: WebhookDeps,
): Promise<{ status: "processed" | "ignored" }> {
  const obj = event.data.object;

  // ── The Connect tenancy boundary (review B5) ──────────────────────────
  // A Connect endpoint receives events for EVERY account connected to the
  // platform, not just ours. `event.account` is therefore an authorization
  // input, not a routing hint: everything below is scoped to the operator it
  // resolves to, so one operator's Stripe account can never drive an effect
  // on another operator's client.
  //
  // No account at all means a platform-account event — the operator's own
  // Sanpo subscription, which belongs to platform-webhook (review H31), a
  // separate endpoint with its own signing secret. The ignore stays: this
  // endpoint's Stripe configuration should never deliver one, and processing
  // it here would put attacker-influenceable Connect metadata adjacent to
  // platform billing state.
  if (!event.account) return { status: "ignored" };
  const operatorId = await deps.resolveOperatorByAccount(event.account);
  if (!operatorId) return { status: "ignored" };

  switch (event.type) {
    // Stripe's view of the connected account changed — onboarding finished,
    // a requirement came due, or charges were disabled. Mirrored locally
    // because otherwise every checkout would need a synchronous round-trip
    // to Stripe to learn whether the operator can be paid.
    case "account.updated": {
      await deps.updateConnectState(event.account, {
        stripe_charges_enabled: Boolean(obj.charges_enabled),
        stripe_payouts_enabled: Boolean(obj.payouts_enabled),
        stripe_details_submitted: Boolean(obj.details_submitted),
      });
      return { status: "processed" };
    }

    case "checkout.session.completed": {
      const meta = (obj.metadata ?? {}) as Record<string, string>;
      const mode = (obj.mode ?? "subscription") as string;

      // ── Payment mode: a top-up (review H32) ─────────────────────────────
      // Granted only when the session is PAID. checkout.session.completed
      // also fires with payment_status 'unpaid' for delayed-notification
      // methods (ACH, one dashboard toggle away for a Standard operator),
      // where the money arrives — or bounces — days later via the
      // async_payment_* events below. Granting on completion alone would
      // hand out spendable credits for money never received, record a
      // 'succeeded' payment, and leave no reversal path when the debit
      // fails (a failed debit is not a refund; charge.refunded never
      // fires). Caught in adversarial review; the migration comment "an
      // unpaid session never completes" recorded exactly this false
      // assumption and is corrected.
      if (mode === "payment") {
        const topup = parseTopupSession(obj);
        if (!topup) return { status: "ignored" };
        if ((obj.payment_status ?? "") !== "paid") {
          // Ours, but the money is still in flight — the async event decides.
          return { status: "processed" };
        }
        return await applyTopupFromSession(topup, obj, operatorId, deps);
      }

      // ── Setup mode: a card was saved (review H32) ───────────────────────
      // The moment a pay-per-visit client becomes chargeable. Operator-only:
      // card_saved is not in CLIENT_FACING, so no email is attempted, and the
      // client was present for the save.
      if (mode === "setup") {
        const client = await deps.findClientByCustomer(String(obj.customer ?? ""), operatorId);
        if (!client) return { status: "ignored" };
        await deps.insertNotification({
          operator_id: operatorId,
          client_id: null,
          type: "card_saved",
          title: `${client.full_name} saved a card`,
          body: "Their card is on file now, so completed walks beyond their credits " +
            "can be charged per visit.",
          walk_id: null,
        });
        return { status: "processed" };
      }

      // ── Subscription mode: unchanged ────────────────────────────────────
      const clientId = meta.client_id;
      if (!clientId || mode !== "subscription") {
        return { status: "ignored" };
      }
      const fields: Record<string, unknown> = {
        stripe_subscription_id: obj.subscription ?? null,
        subscription_status: "active",
      };
      if (meta.plan_id) fields.plan_id = meta.plan_id;
      if (obj.customer) fields.stripe_customer_id = obj.customer;
      const changed = await deps.updateClient(clientId, fields, operatorId);
      // Zero rows means the metadata named a client this account does not
      // own. Ignored rather than 500'd: it is a well-formed event that simply
      // is not ours to act on, and retrying it forever would not change that.
      if (changed === 0) return { status: "ignored" };
      return { status: "processed" };
    }

    // A delayed-notification top-up's money arrived. Same application path
    // as a paid completion — fn_apply_topup's PI-keyed idempotency makes it
    // safe even if both events raced to apply.
    case "checkout.session.async_payment_succeeded": {
      const topup = parseTopupSession(obj);
      if (!topup) return { status: "ignored" };
      return await applyTopupFromSession(topup, obj, operatorId, deps);
    }

    // The debit bounced days after the session completed. Nothing was ever
    // granted (the completed arm defers on 'unpaid'), so this is disclosure,
    // not reversal: the client may believe they paid, and the operator may
    // be counting on the credits.
    case "checkout.session.async_payment_failed": {
      const topup = parseTopupSession(obj);
      if (!topup) return { status: "ignored" };
      const client = await deps.findClientByCustomer(String(obj.customer ?? ""), operatorId);
      if (!client) return { status: "ignored" };
      await deps.insertNotification({
        operator_id: operatorId,
        client_id: client.id,
        type: "payment_failed",
        title: "Your top-up didn't go through",
        body: "The bank payment for your credit top-up failed, so no credits were " +
          "added. You can try again with a different payment method.",
        walk_id: null,
      });
      await deps.insertNotification({
        operator_id: operatorId,
        client_id: null,
        type: "payment_failed",
        title: `${client.full_name}'s top-up payment failed`,
        body: "Their bank payment bounced after checkout, so no credits were granted " +
          "and no money arrived.",
        walk_id: null,
      });
      return { status: "processed" };
    }

    case "invoice.paid": {
      const paidSubId = invoiceSubscriptionId(obj);
      if (!paidSubId) return { status: "ignored" };
      const client = await deps.findClientByCustomer(String(obj.customer ?? ""), operatorId);
      if (!client) return { status: "ignored" };
      // Scoped to the subscription actually bound to this client — the two
      // sibling subscription arms both do this and say why, and this one did
      // not. A customer can carry more than one live subscription (nothing
      // stopped a second checkout), and their invoices have DIFFERENT ids, so
      // uq_payments_subscription_invoice does not catch it: the result is two
      // cycle grants and two rollovers for one client.
      //
      // An unbound client is allowed through: checkout.session.completed and
      // invoice.paid race, and refusing here would drop the first cycle of
      // every new subscription.
      if (client.stripe_subscription_id && client.stripe_subscription_id !== paidSubId) {
        return { status: "ignored" };
      }
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
        // The safety net for H11, and until `resolvePlan` changed precedence
        // this line was unreachable: resolvePlan returned the CACHED plan, so
        // the ids could never differ. It now fires when a price change was
        // missed by `customer.subscription.updated` — a dropped event, or a
        // subscription created already on the new price — and reconciles at
        // the moment the money actually moves.
        await deps.updateClient(client.id, { plan_id: plan.id }, operatorId);
        await deps.insertNotification({
          operator_id: client.operator_id,
          client_id: null,
          type: "plan_changed_externally",
          title: `${client.full_name}'s plan was corrected from their invoice`,
          body: "Stripe billed them for a different plan than Sanpo had on file, so their "
            + "plan here now matches what was charged.",
          walk_id: null,
        });
      }

      await deps.applyInvoicePaid({
        clientId: client.id,
        credits: plan.credits_per_cycle,
        invoiceId,
        amountPence: (obj.amount_paid as number) ?? 0,
        currency,
        receiptUrl: (obj.hosted_invoice_url as string | null) ?? null,
        // CYCLE_REASONS admits subscription_create too, and both grant a
        // cycle — but only a renewal has a previous cycle to roll over.
        isRenewal: reason === "subscription_cycle",
      });
      return { status: "processed" };
    }

    case "invoice.payment_failed": {
      const client = await deps.findClientByCustomer(String(obj.customer ?? ""), operatorId);
      if (!client) return { status: "ignored" };
      await deps.updateClient(client.id, { subscription_status: "past_due" }, operatorId);
      // Stripe retries a failed invoice on its own dunning schedule and
      // redelivers the event, and each delivery is a distinct event id — so
      // the stripe_events claim ledger does not dedupe them. Without this the
      // Money screen accrues one "Needs attention" row per retry for a single
      // unpaid invoice. The invoice.paid non-cycle branch has always guarded
      // this way; this arm never did.
      const failedInvoiceId = asString(obj.id);
      if (failedInvoiceId && await deps.hasFailedPaymentForInvoice(failedInvoiceId)) {
        return { status: "processed" };
      }
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
      const client = await deps.findClientByCustomer(String(obj.customer ?? ""), operatorId);
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
      const client = await deps.findClientByCustomer(String(obj.customer ?? ""), operatorId);
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
      // See the write site in `change-plan/index.ts` for why this is renamed
      // rather than dual-read (review L23).
      const rawIntentId = meta[STRIPE_META.planChangeIntentId];
      const metadataIntentId = typeof rawIntentId === "string" ? rawIntentId : null;
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
      } else if (plan && plan.id !== client.plan_id) {
        // Review H11. Until now `plan_id` was written ONLY inside the branch
        // above, so a price change that did not originate in change-plan left
        // `clients.plan_id` pointing at the old plan — and per B5/B6 the Stripe
        // dashboard is the only place a subscription's price exists to be
        // edited, which makes an out-of-band change the ordinary support
        // action rather than an exotic one.
        //
        // The divergence then SELF-PERPETUATES: at the next `invoice.paid`,
        // `resolvePlan` short-circuited on the cached id and granted the OLD
        // plan's credits while Stripe collected the NEW price, every cycle,
        // with nothing in the app or the ledger flagging it.
        //
        // **Stripe is the source of truth for what is being billed.** If the
        // subscription is on this price, this is the plan, whatever we had
        // cached. The intent branch still wins when it matches, because an
        // in-app change carries the operator's stated intention and its
        // bookkeeping.
        fields.plan_id = plan.id;
        await deps.insertNotification({
          operator_id: client.operator_id,
          client_id: null,
          type: "plan_changed_externally",
          title: `${client.full_name}'s plan changed outside Sanpo`,
          body: "The subscription's price was changed in Stripe, so their plan here has been "
            + "updated to match. Their next renewal grants the new plan's credits.",
          walk_id: null,
        });
      } else if (priceId && !plan) {
        // A price Sanpo has no plan for. This one CANNOT be reconciled — there
        // is no local plan to point at — so `plan_id` is deliberately left
        // alone rather than nulled, and the operator is told, because silently
        // continuing to grant the old plan's credits against an unknown price
        // is exactly the divergence H11 describes.
        await deps.insertNotification({
          operator_id: client.operator_id,
          client_id: null,
          type: "plan_changed_externally",
          title: `${client.full_name} is on a price Sanpo does not know`,
          body: "Their Stripe subscription uses a price that matches no plan here, so Sanpo "
            + "cannot tell how many credits a renewal should grant. Until this is resolved "
            + "they keep receiving their current plan's credits.",
          walk_id: null,
        });
      }

      await deps.updateClient(client.id, fields, operatorId);
      return { status: "processed" };
    }

    case "customer.subscription.deleted": {
      const client = await deps.findClientByCustomer(String(obj.customer ?? ""), operatorId);
      if (!client) return { status: "ignored" };
      const subId = typeof obj.id === "string" ? obj.id : null;
      // Never let a deletion of a sub that isn't the client's current one
      // (stale sub, or any sub while unbound mid-checkout) flip the account.
      if (!client.stripe_subscription_id) return { status: "ignored" };
      if (subId && client.stripe_subscription_id !== subId) {
        return { status: "ignored" };
      }
      // Clear the binding as well as the status. Leaving stripe_subscription_id
      // set means change-plan still takes the Stripe path on a dead
      // subscription — and it commits a pending plan-change intent BEFORE the
      // Stripe call, so the failure leaves an intent behind and surfaces as a
      // bare "internal error". current_period_end goes too: the Money screen
      // renders it as a confident renewal date for a subscription that will
      // never renew.
      await deps.updateClient(client.id, {
        subscription_status: "cancelled",
        stripe_subscription_id: null,
        current_period_end: null,
      }, operatorId);
      // The operator otherwise learns about this when the client asks why
      // their walks stopped — and after 0026 they DO stop, because the
      // materializer and fn_book_walk both refuse a cancelled subscription.
      await deps.insertNotification({
        operator_id: client.operator_id,
        client_id: null,
        type: "subscription_cancelled",
        title: `${client.full_name} cancelled their subscription`,
        body: "No further walks will be scheduled or bookable for them, and no more credits will be granted. Walks already on the calendar are untouched.",
        walk_id: null,
      });
      return { status: "processed" };
    }

    // ── Reversals (review B4) ────────────────────────────────────────────
    // None of these existed. A refund issued from the Stripe dashboard — the
    // only way to issue one — left the payments row reading 'succeeded' with
    // the cycle grant still in the ledger, so the client kept credits they
    // had been refunded for, and the operator learned about a dispute only
    // if they happened to read Stripe's email.
    //
    // Every arm funnels into one definer function so the row lock, the
    // clawback floor and the idempotency live in exactly one place.
    case "charge.refunded": {
      // amount_refunded is CUMULATIVE across partial refunds, which is the
      // quantity fn_reverse_payment expects. Passing a per-refund delta here
      // would double-claw on Stripe's redelivery.
      return await reverse(deps, {
        paymentIntentId: asString(obj.payment_intent),
        invoiceId: asString(obj.invoice),
        chargeId: asString(obj.id),
        operatorId,
      }, "refund", numberOr(obj.amount_refunded, 0), "refunded in Stripe");
    }

    case "charge.dispute.created":
    case "charge.dispute.funds_withdrawn": {
      const reason = asString(obj.reason) ?? "disputed";
      return await reverse(deps, {
        paymentIntentId: asString(obj.payment_intent),
        chargeId: asString(obj.charge),
        operatorId,
      }, "dispute", numberOr(obj.amount, 0), `dispute: ${reason}`);
    }

    case "credit_note.created": {
      // A credit note against an already-paid invoice is a refund by another
      // name. post_payment_credit_notes_amount is the invoice's cumulative
      // credited total; the note's own amount is not, so prefer it and fall
      // back only when Stripe did not expand the invoice.
      const inv = obj.invoice as Record<string, unknown> | string | null;
      // Stripe sends `invoice` either as a bare id or as an expanded object,
      // and the expanded case is the one that carries the cumulative total we
      // want. Reach into `.id` for it — reading the object itself as a string
      // yields null, which silently drops the reversal.
      const invoiceId = typeof inv === "string" ? inv : asString(inv?.id);
      const cumulative = typeof inv === "object" && inv
        ? numberOr(inv.post_payment_credit_notes_amount, NaN)
        : NaN;
      const amount = Number.isFinite(cumulative) ? cumulative : numberOr(obj.amount, 0);
      return await reverse(deps, { invoiceId, operatorId }, "refund", amount, "credit note issued");
    }

    case "invoice.voided": {
      const invoiceId = asString(obj.id);
      if (!invoiceId) return { status: "ignored" };
      return await reverse(deps, { invoiceId, operatorId }, "refund",
        numberOr(obj.amount_paid, 0), "invoice voided");
    }

    default:
      return { status: "ignored" };
  }
}

/**
 * Shared tail for every reversal event. Returns 'ignored' when the charge
 * belongs to no payment we know about — a customer can have charges created
 * outside Sanpo, and inventing a row for one would be worse than skipping it.
 */
async function reverse(
  deps: WebhookDeps,
  ref: {
    paymentIntentId?: string | null;
    invoiceId?: string | null;
    chargeId?: string | null;
    operatorId: string;
  },
  kind: "refund" | "dispute",
  amountPence: number,
  reason: string,
): Promise<{ status: "processed" | "ignored" }> {
  const payment = await deps.findPaymentForReversal(ref);
  if (!payment) return { status: "ignored" };
  if (amountPence <= 0) return { status: "ignored" };

  // Remember the charge id the first time we see it: a dispute can arrive
  // carrying only `charge`, and older overage rows store only the intent.
  if (ref.chargeId && !payment.stripe_charge_id) {
    await deps.noteChargeId(payment.id, ref.chargeId);
  }

  const result = await deps.reversePayment({
    paymentId: payment.id,
    kind,
    amountPence,
    reason,
  });
  if (result.outcome === "noop") return { status: "processed" };

  await deps.insertNotification({
    operator_id: payment.operator_id,
    client_id: null,
    type: kind === "dispute" ? "payment_disputed" : "payment_refunded",
    title: kind === "dispute" ? "Payment disputed" : "Payment refunded",
    body: reversalBody(kind, result),
    walk_id: null,
  });
  return { status: "processed" };
}

/** The operator is the audience: they are the one out of pocket. */
export function reversalBody(kind: "refund" | "dispute", r: ReversalResult): string {
  const head = kind === "dispute"
    ? "A charge has been disputed and the funds pulled back by the cardholder's bank."
    : "A charge has been refunded.";
  if (r.needs_review) {
    return `${head} This payment predates credit tracking, so no credits were reclaimed automatically — check the balance by hand.`;
  }
  if (r.credits_unrecovered > 0) {
    return `${head} ${r.credits_reversed} credit(s) reclaimed; ${r.credits_unrecovered} could not be — the client had already spent them.`;
  }
  if (r.credits_reversed > 0) {
    return `${head} ${r.credits_reversed} credit(s) reclaimed.`;
  }
  return `${head} No credits were involved.`;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function subscriptionPriceId(obj: Record<string, unknown>): string | null {
  const items = (obj.items as { data?: Array<Record<string, unknown>> })?.data ?? [];
  const first = items[0];
  const price = first?.price as { id?: string } | undefined;
  return price?.id ?? null;
}

/**
 * Which plan's credits does THIS invoice buy?
 *
 * Review H11 inverted the precedence. It used to short-circuit on
 * `client.plan_id` and consult the invoice only when that was null — so once
 * the cached id went stale (a price changed outside change-plan), every
 * subsequent renewal granted the old plan's credits while Stripe collected the
 * new price, and the cache was never consulted against reality again.
 *
 * The invoice line's price is what the client was actually charged for, so it
 * decides. The cached `plan_id` is the fallback for invoices that carry no
 * resolvable line price, and for a price this operator has no plan for — in
 * which case granting the last known plan is better than granting nothing,
 * and the subscription arm has already told the operator about it.
 */
async function resolvePlan(
  client: ClientRow,
  invoice: Record<string, unknown>,
  deps: WebhookDeps,
): Promise<PlanRow | null> {
  const lines = (invoice.lines as { data?: Array<Record<string, unknown>> })?.data ?? [];
  for (const line of lines) {
    const price = (line.price as { id?: string })?.id ??
      (line.pricing as { price_details?: { price?: string } })?.price_details?.price;
    if (price) {
      const plan = await deps.findPlanByPriceId(client.operator_id, price);
      if (plan) return plan;
    }
  }
  if (client.plan_id) {
    const plan = await deps.getPlan(client.plan_id);
    if (plan) return plan;
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
