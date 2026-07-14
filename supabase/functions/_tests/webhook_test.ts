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
  type StripeEventLike,
  type WebhookDeps,
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
