// stripe-webhook dispatch: stateful claim ledger + core event effects
// (mocked deps). The claim redesign (0013) is pinned here: duplicates of an
// unfinished claim are NOT acked, failures leave the claim re-processable,
// and invoice effects are atomic behind applyInvoicePaid.
import { assert, assertEquals, assertFalse, assertRejects } from "./asserts.ts";
import {
  handleStripeEvent,
  InFlightError,
  mapSubscriptionStatus,
  type ClaimResult,
  type ReversalResult,
  type StripeEventLike,
  type WebhookDeps,
  reversalBody,
} from "../stripe-webhook/handler.ts";

interface Call {
  fn: string;
  args: unknown[];
}

function makeMockDeps(
  opts: {
    claim?: ClaimResult;
    subId?: string | null;
    failApply?: boolean;
    hasInvoicePayment?: boolean;
    noPayment?: boolean;
    paymentType?: string;
    knownChargeId?: string | null;
    reversal?: ReversalResult;
  } = {},
): { deps: WebhookDeps; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    id: "client-1",
    operator_id: "op-1",
    full_name: "Amelia Hart",
    plan_id: "plan-1",
    subscription_status: "active",
    stripe_subscription_id: opts.subId === undefined ? "sub_1" : opts.subId,
  };
  const plan = { id: "plan-1", credits_per_cycle: 5, stripe_price_id: "price_1" };
  const deps: WebhookDeps = {
    claimEvent(id, type, payload) {
      calls.push({ fn: "claimEvent", args: [id, type, payload] });
      return Promise.resolve(opts.claim ?? "fresh");
    },
    markProcessed(id) {
      calls.push({ fn: "markProcessed", args: [id] });
      return Promise.resolve();
    },
    findClientByCustomer(customerId) {
      calls.push({ fn: "findClientByCustomer", args: [customerId] });
      return Promise.resolve(customerId === "cus_1" ? client : null);
    },
    getPlan(planId) {
      calls.push({ fn: "getPlan", args: [planId] });
      return Promise.resolve(planId === "plan-1" ? plan : null);
    },
    findPlanByPriceId(operatorId, priceId) {
      calls.push({ fn: "findPlanByPriceId", args: [operatorId, priceId] });
      return Promise.resolve(priceId === "price_1" ? plan : null);
    },
    updateClient(id, fields) {
      calls.push({ fn: "updateClient", args: [id, fields] });
      return Promise.resolve();
    },
    findPendingPlanChangeIntent(args) {
      calls.push({ fn: "findPendingPlanChangeIntent", args: [args] });
      const metadataIntentId = args.metadataIntentId;
      return Promise.resolve(metadataIntentId ? { id: metadataIntentId, new_plan_id: "plan-1" } : null);
    },
    applyPlanChangeIntent(intentId, eventId) {
      calls.push({ fn: "applyPlanChangeIntent", args: [intentId, eventId] });
      return Promise.resolve(7);
    },
    applyInvoicePaid(args) {
      calls.push({ fn: "applyInvoicePaid", args: [args] });
      if (opts.failApply) return Promise.reject(new Error("apply failed"));
      return Promise.resolve(true);
    },
    hasPaymentForInvoice(invoiceId) {
      calls.push({ fn: "hasPaymentForInvoice", args: [invoiceId] });
      return Promise.resolve(opts.hasInvoicePayment ?? false);
    },
    insertPayment(row) {
      calls.push({ fn: "insertPayment", args: [row] });
      return Promise.resolve();
    },
    insertNotification(row) {
      calls.push({ fn: "insertNotification", args: [row] });
      return Promise.resolve();
    },
    findPaymentForReversal(ref) {
      calls.push({ fn: "findPaymentForReversal", args: [ref] });
      if (opts.noPayment) return Promise.resolve(null);
      return Promise.resolve({
        id: "pay-1",
        operator_id: "op-1",
        client_id: "client-1",
        type: opts.paymentType ?? "subscription",
        amount_pence: 9000,
        status: "succeeded",
        stripe_charge_id: opts.knownChargeId ?? null,
      });
    },
    reversePayment(args) {
      calls.push({ fn: "reversePayment", args: [args] });
      return Promise.resolve(
        opts.reversal ?? {
          outcome: "reversed" as const,
          credits_reversed: 5,
          credits_unrecovered: 0,
          needs_review: false,
        },
      );
    },
    noteChargeId(paymentId, chargeId) {
      calls.push({ fn: "noteChargeId", args: [paymentId, chargeId] });
      return Promise.resolve();
    },
  };
  return { deps, calls };
}

function event(type: string, object: Record<string, unknown>): StripeEventLike {
  return { id: `evt_${type}`, type, data: { object } };
}

const PAID_CYCLE = {
  id: "in_1",
  customer: "cus_1",
  subscription: "sub_1",
  amount_paid: 9000,
  currency: "usd",
  billing_reason: "subscription_cycle",
  hosted_invoice_url: "https://stripe.test/inv",
};

Deno.test("duplicate (processed) event short-circuits with no side effects", async () => {
  const { deps, calls } = makeMockDeps({ claim: "duplicate" });
  const result = await handleStripeEvent(event("invoice.paid", PAID_CYCLE), deps);
  assertEquals(result.status, "duplicate");
  assertEquals(calls.length, 1); // claimEvent only
});

Deno.test("in-flight claim is NOT acknowledged — throws so Stripe retries", async () => {
  const { deps, calls } = makeMockDeps({ claim: "in_flight" });
  const err = await assertRejects(() =>
    handleStripeEvent(event("invoice.paid", PAID_CYCLE), deps)
  );
  assert(err instanceof InFlightError, "must be the 409-mapped InFlightError");
  assertEquals(calls.length, 1);
  assertFalse(calls.some((c) => c.fn === "applyInvoicePaid"));
});

Deno.test("invoice.paid (cycle) applies atomically and marks the claim processed", async () => {
  const { deps, calls } = makeMockDeps();
  const result = await handleStripeEvent(event("invoice.paid", PAID_CYCLE), deps);
  assertEquals(result.status, "processed");
  const apply = calls.find((c) => c.fn === "applyInvoicePaid")!;
  assertEquals(apply.args[0], {
    clientId: "client-1",
    credits: 5,
    invoiceId: "in_1",
    amountPence: 9000,
    currency: "usd",
    receiptUrl: "https://stripe.test/inv",
  });
  const order = calls.map((c) => c.fn);
  assert(order.indexOf("applyInvoicePaid") < order.indexOf("markProcessed"),
    "effects must precede markProcessed");
});

Deno.test("failed effect leaves the claim unprocessed (no markProcessed)", async () => {
  const { deps, calls } = makeMockDeps({ failApply: true });
  await assertRejects(() => handleStripeEvent(event("invoice.paid", PAID_CYCLE), deps));
  assertFalse(calls.some((c) => c.fn === "markProcessed"),
    "claim must stay 'processing' so the retry takes it over");
});

Deno.test("subscription_create (first invoice) grants a cycle", async () => {
  const { deps, calls } = makeMockDeps();
  const result = await handleStripeEvent(
    event("invoice.paid", { ...PAID_CYCLE, id: "in_first", billing_reason: "subscription_create" }),
    deps,
  );
  assertEquals(result.status, "processed");
  assert(calls.some((c) => c.fn === "applyInvoicePaid"));
});

Deno.test("proration invoice.paid records the payment but grants no cycle", async () => {
  const { deps, calls } = makeMockDeps();
  const result = await handleStripeEvent(
    event("invoice.paid", { ...PAID_CYCLE, id: "in_p", amount_paid: 300, billing_reason: "subscription_update" }),
    deps,
  );
  assertEquals(result.status, "processed");
  assertFalse(calls.some((c) => c.fn === "applyInvoicePaid"));
  const pay = calls.find((c) => c.fn === "insertPayment")!.args[0] as Record<string, unknown>;
  assertEquals(pay.stripe_invoice_id, "in_p");
  assertEquals(pay.amount_pence, 300);
  assertEquals(pay.currency, "USD");
});

Deno.test("proration payment recording is deduped on the invoice id", async () => {
  const { deps, calls } = makeMockDeps({ hasInvoicePayment: true });
  await handleStripeEvent(
    event("invoice.paid", { ...PAID_CYCLE, id: "in_p", billing_reason: "subscription_update" }),
    deps,
  );
  assertFalse(calls.some((c) => c.fn === "insertPayment"));
});

Deno.test("missing billing_reason no longer grants a cycle", async () => {
  const { deps, calls } = makeMockDeps();
  const obj = { ...PAID_CYCLE, id: "in_x" } as Record<string, unknown>;
  delete obj.billing_reason;
  const result = await handleStripeEvent(event("invoice.paid", obj), deps);
  assertEquals(result.status, "processed"); // recorded as a payment only
  assertFalse(calls.some((c) => c.fn === "applyInvoicePaid"));
});

Deno.test("non-subscription invoice.paid is ignored", async () => {
  const { deps, calls } = makeMockDeps();
  const result = await handleStripeEvent(
    event("invoice.paid", { id: "in_2", customer: "cus_1", amount_paid: 500 }),
    deps,
  );
  assertEquals(result.status, "ignored");
  assertFalse(calls.some((c) => c.fn === "applyInvoicePaid"));
});

Deno.test("checkout.session.completed binds subscription + plan from metadata", async () => {
  const { deps, calls } = makeMockDeps();
  const result = await handleStripeEvent(
    event("checkout.session.completed", {
      mode: "subscription",
      customer: "cus_1",
      subscription: "sub_9",
      metadata: { client_id: "client-1", operator_id: "op-1", plan_id: "plan-1" },
    }),
    deps,
  );
  assertEquals(result.status, "processed");
  const update = calls.find((c) => c.fn === "updateClient")!;
  assertEquals(update.args[0], "client-1");
  assertEquals(update.args[1], {
    stripe_subscription_id: "sub_9",
    subscription_status: "active",
    plan_id: "plan-1",
    stripe_customer_id: "cus_1",
  });
});

Deno.test("invoice.payment_failed marks past_due, stamps currency, notifies both personas", async () => {
  const { deps, calls } = makeMockDeps();
  await handleStripeEvent(
    event("invoice.payment_failed", { id: "in_3", customer: "cus_1", amount_due: 9000, currency: "usd" }),
    deps,
  );
  const update = calls.find((c) => c.fn === "updateClient")!;
  assertEquals(update.args[1], { subscription_status: "past_due" });
  const pay = calls.find((c) => c.fn === "insertPayment")!.args[0] as Record<string, unknown>;
  assertEquals(pay.currency, "USD");
  const notifs = calls.filter((c) => c.fn === "insertNotification");
  assertEquals(notifs.length, 2);
  const targets = notifs.map((n) => (n.args[0] as Record<string, unknown>).client_id);
  assert(targets.includes("client-1") && targets.includes(null));
});

Deno.test("unknown customer is ignored, never throws", async () => {
  const { deps } = makeMockDeps();
  const result = await handleStripeEvent(
    event("invoice.paid", { ...PAID_CYCLE, customer: "cus_unknown" }),
    deps,
  );
  assertEquals(result.status, "ignored");
});

Deno.test("subscription.updated for a stale (non-current) sub is ignored", async () => {
  const { deps, calls } = makeMockDeps({ subId: "sub_current" });
  const result = await handleStripeEvent(
    event("customer.subscription.updated", { id: "sub_old", customer: "cus_1", status: "past_due" }),
    deps,
  );
  assertEquals(result.status, "ignored");
  assertFalse(calls.some((c) => c.fn === "updateClient"));
});

Deno.test("subscription.updated for the current sub applies", async () => {
  const { deps, calls } = makeMockDeps({ subId: "sub_1" });
  const result = await handleStripeEvent(
    event("customer.subscription.updated", { id: "sub_1", customer: "cus_1", status: "past_due" }),
    deps,
  );
  assertEquals(result.status, "processed");
  const update = calls.find((c) => c.fn === "updateClient")!;
  assertEquals((update.args[1] as Record<string, unknown>).subscription_status, "past_due");
});

Deno.test("subscription.updated applies a pending plan-change intent before updating client plan", async () => {
  const { deps, calls } = makeMockDeps({ subId: "sub_1" });
  const result = await handleStripeEvent(
    event("customer.subscription.updated", {
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      metadata: { pawtrail_plan_change_intent_id: "intent-1" },
      items: { data: [{ price: { id: "price_1" } }] },
    }),
    deps,
  );
  assertEquals(result.status, "processed");
  assert(calls.some((c) => c.fn === "applyPlanChangeIntent"));
  const update = calls.find((c) => c.fn === "updateClient")!;
  assertEquals((update.args[1] as Record<string, unknown>).plan_id, "plan-1");
});

Deno.test("subscription.updated with no metadata and no resolvable plan never looks up an intent", async () => {
  // An orphaned pending intent must not be applied off an unrelated
  // subscription event: without the exact metadata id or a sub+plan proof,
  // the handler skips intent matching entirely.
  const { deps, calls } = makeMockDeps({ subId: "sub_1" });
  const result = await handleStripeEvent(
    event("customer.subscription.updated", {
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      items: { data: [{ price: { id: "price_unknown" } }] },
    }),
    deps,
  );
  assertEquals(result.status, "processed");
  assertFalse(calls.some((c) => c.fn === "findPendingPlanChangeIntent"));
  assertFalse(calls.some((c) => c.fn === "applyPlanChangeIntent"));
});

Deno.test("subscription.updated without metadata falls back to an exact sub+plan intent match", async () => {
  const { deps, calls } = makeMockDeps({ subId: "sub_1" });
  const result = await handleStripeEvent(
    event("customer.subscription.updated", {
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      items: { data: [{ price: { id: "price_1" } }] },
    }),
    deps,
  );
  assertEquals(result.status, "processed");
  const lookup = calls.find((c) => c.fn === "findPendingPlanChangeIntent");
  assert(lookup, "fallback lookup must run when sub and plan both resolve");
  const args = lookup!.args[0] as Record<string, unknown>;
  assertEquals(args.metadataIntentId, null);
  assertEquals(args.subscriptionId, "sub_1");
  assertEquals(args.planId, "plan-1");
});

Deno.test("unbound client: a LIVE subscription.updated binds, a dead one is ignored", async () => {
  const live = makeMockDeps({ subId: null });
  const r1 = await handleStripeEvent(
    event("customer.subscription.updated", { id: "sub_new", customer: "cus_1", status: "active" }),
    live.deps,
  );
  assertEquals(r1.status, "processed");

  const dead = makeMockDeps({ subId: null });
  const r2 = await handleStripeEvent(
    event("customer.subscription.updated", { id: "sub_stale", customer: "cus_1", status: "canceled" }),
    dead.deps,
  );
  assertEquals(r2.status, "ignored");
  assertFalse(dead.calls.some((c) => c.fn === "updateClient"));
});

Deno.test("subscription.deleted: stale sub and unbound client are both ignored", async () => {
  const stale = makeMockDeps({ subId: "sub_current" });
  const r1 = await handleStripeEvent(
    event("customer.subscription.deleted", { id: "sub_old", customer: "cus_1" }),
    stale.deps,
  );
  assertEquals(r1.status, "ignored");

  const unbound = makeMockDeps({ subId: null });
  const r2 = await handleStripeEvent(
    event("customer.subscription.deleted", { id: "sub_any", customer: "cus_1" }),
    unbound.deps,
  );
  assertEquals(r2.status, "ignored");
  assertFalse(unbound.calls.some((c) => c.fn === "updateClient"));
});

Deno.test("subscription.deleted for the current sub cancels", async () => {
  const { deps, calls } = makeMockDeps({ subId: "sub_1" });
  const result = await handleStripeEvent(
    event("customer.subscription.deleted", { id: "sub_1", customer: "cus_1" }),
    deps,
  );
  assertEquals(result.status, "processed");
  const update = calls.find((c) => c.fn === "updateClient")!;
  assertEquals(update.args[1], { subscription_status: "cancelled" });
});

Deno.test("subscription status mapping", () => {
  assertEquals(mapSubscriptionStatus({ status: "active" }), "active");
  assertEquals(mapSubscriptionStatus({ status: "trialing" }), "active");
  assertEquals(mapSubscriptionStatus({ status: "past_due" }), "past_due");
  assertEquals(mapSubscriptionStatus({ status: "unpaid" }), "past_due");
  assertEquals(mapSubscriptionStatus({ status: "canceled" }), "cancelled");
  assertEquals(
    mapSubscriptionStatus({ status: "active", pause_collection: { behavior: "void" } }),
    "paused",
  );
});

// ── Reversals (review B4) ──────────────────────────────────────────────────
// None of these events had an arm. A refund left the payments row reading
// 'succeeded' with the cycle grant still in the ledger; a dispute pulled the
// funds and the operator was never told.

Deno.test("charge.refunded reverses the payment and tells the operator", async () => {
  const { deps, calls } = makeMockDeps();
  const res = await handleStripeEvent(
    event("charge.refunded", {
      id: "ch_1",
      payment_intent: "pi_1",
      invoice: "in_1",
      amount: 9000,
      amount_refunded: 9000,
    }),
    deps,
  );
  assertEquals(res.status, "processed");
  const rev = calls.find((c) => c.fn === "reversePayment");
  assert(rev, "expected a reversal");
  assertEquals((rev.args[0] as { kind: string }).kind, "refund");
  const note = calls.find((c) => c.fn === "insertNotification");
  assert(note, "the operator must be told");
  assertEquals((note.args[0] as { type: string }).type, "payment_refunded");
});

Deno.test("charge.refunded passes Stripe's CUMULATIVE amount, not a delta", async () => {
  // amount_refunded is the running total. Passing a per-event delta would
  // double-claw on Stripe's redelivery, which it does for three days.
  const { deps, calls } = makeMockDeps();
  await handleStripeEvent(
    event("charge.refunded", {
      id: "ch_2",
      payment_intent: "pi_2",
      amount: 9000,
      amount_refunded: 4500,
    }),
    deps,
  );
  const rev = calls.find((c) => c.fn === "reversePayment");
  assertEquals((rev!.args[0] as { amountPence: number }).amountPence, 4500);
});

Deno.test("a dispute is recorded as a dispute, not a refund", async () => {
  const { deps, calls } = makeMockDeps();
  const res = await handleStripeEvent(
    event("charge.dispute.created", {
      charge: "ch_3",
      payment_intent: "pi_3",
      amount: 2500,
      reason: "fraudulent",
    }),
    deps,
  );
  assertEquals(res.status, "processed");
  const rev = calls.find((c) => c.fn === "reversePayment");
  assertEquals((rev!.args[0] as { kind: string }).kind, "dispute");
  const note = calls.find((c) => c.fn === "insertNotification");
  assertEquals((note!.args[0] as { type: string }).type, "payment_disputed");
});

Deno.test("funds_withdrawn reverses too — the money is actually gone by then", async () => {
  const { deps, calls } = makeMockDeps();
  await handleStripeEvent(
    event("charge.dispute.funds_withdrawn", { charge: "ch_4", amount: 2500 }),
    deps,
  );
  assert(calls.some((c) => c.fn === "reversePayment"));
});

Deno.test("a charge we do not recognise is ignored, not invented", async () => {
  // Customers have charges created outside Sanpo.
  const { deps, calls } = makeMockDeps({ noPayment: true });
  const res = await handleStripeEvent(
    event("charge.refunded", { id: "ch_x", amount_refunded: 100 }),
    deps,
  );
  assertEquals(res.status, "ignored");
  assertFalse(calls.some((c) => c.fn === "reversePayment"));
  assertFalse(calls.some((c) => c.fn === "insertNotification"));
});

Deno.test("a replayed reversal notifies once, not twice", async () => {
  // fn_reverse_payment reports 'noop' for a cumulative total it already
  // applied. The event is still acked — but a second bell would be a lie.
  const { deps, calls } = makeMockDeps({
    reversal: {
      outcome: "noop",
      credits_reversed: 0,
      credits_unrecovered: 0,
      needs_review: false,
    },
  });
  const res = await handleStripeEvent(
    event("charge.refunded", { id: "ch_5", payment_intent: "pi_5", amount_refunded: 9000 }),
    deps,
  );
  assertEquals(res.status, "processed");
  assertFalse(
    calls.some((c) => c.fn === "insertNotification"),
    "a no-op reversal must not raise a second notification",
  );
});

Deno.test("a zero-amount reversal is ignored", async () => {
  const { deps, calls } = makeMockDeps();
  const res = await handleStripeEvent(
    event("charge.refunded", { id: "ch_6", payment_intent: "pi_6", amount_refunded: 0 }),
    deps,
  );
  assertEquals(res.status, "ignored");
  assertFalse(calls.some((c) => c.fn === "reversePayment"));
});

Deno.test("the charge id is recorded once, so a later dispute is findable", async () => {
  const { deps, calls } = makeMockDeps({ knownChargeId: null });
  await handleStripeEvent(
    event("charge.refunded", { id: "ch_7", payment_intent: "pi_7", amount_refunded: 100 }),
    deps,
  );
  const noted = calls.find((c) => c.fn === "noteChargeId");
  assertEquals(noted!.args, ["pay-1", "ch_7"]);

  const second = makeMockDeps({ knownChargeId: "ch_7" });
  await handleStripeEvent(
    event("charge.refunded", { id: "ch_7", payment_intent: "pi_7", amount_refunded: 100 }),
    second.deps,
  );
  assertFalse(second.calls.some((c) => c.fn === "noteChargeId"));
});

Deno.test("credit_note.created prefers the invoice's cumulative credited total", async () => {
  const { deps, calls } = makeMockDeps();
  await handleStripeEvent(
    event("credit_note.created", {
      amount: 1000,
      invoice: { id: "in_9", post_payment_credit_notes_amount: 3000 },
    }),
    deps,
  );
  const rev = calls.find((c) => c.fn === "reversePayment");
  assertEquals((rev!.args[0] as { amountPence: number }).amountPence, 3000);
});

Deno.test("credit_note.created falls back to the note amount when the invoice is a bare id", async () => {
  const { deps, calls } = makeMockDeps();
  await handleStripeEvent(
    event("credit_note.created", { amount: 1000, invoice: "in_10" }),
    deps,
  );
  const rev = calls.find((c) => c.fn === "reversePayment");
  assertEquals((rev!.args[0] as { amountPence: number }).amountPence, 1000);
});

Deno.test("invoice.voided reverses what was paid", async () => {
  const { deps, calls } = makeMockDeps();
  await handleStripeEvent(
    event("invoice.voided", { id: "in_11", amount_paid: 9000 }),
    deps,
  );
  const rev = calls.find((c) => c.fn === "reversePayment");
  assertEquals((rev!.args[0] as { amountPence: number }).amountPence, 9000);
});

Deno.test("the operator is told what could NOT be reclaimed", async () => {
  // The shortfall is real money the operator will not get back. Reporting
  // only the reclaimed figure would read like a clean recovery.
  const body = reversalBody("refund", {
    outcome: "reversed",
    credits_reversed: 1,
    credits_unrecovered: 4,
    needs_review: false,
  });
  assert(body.includes("1 credit(s) reclaimed"), body);
  assert(body.includes("4 could not be"), body);
});

Deno.test("an untraceable reversal says so rather than implying success", async () => {
  const body = reversalBody("refund", {
    outcome: "reversed",
    credits_reversed: 0,
    credits_unrecovered: 0,
    needs_review: true,
  });
  assert(body.includes("check the balance by hand"), body);
});

Deno.test("an overage reversal reports no credits, not zero reclaimed", async () => {
  const body = reversalBody("dispute", {
    outcome: "reversed",
    credits_reversed: 0,
    credits_unrecovered: 0,
    needs_review: false,
  });
  assert(body.includes("No credits were involved"), body);
  assert(body.includes("disputed"), body);
});
