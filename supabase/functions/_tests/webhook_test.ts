// stripe-webhook dispatch: idempotency guard + core event effects (mocked deps).
import { assert, assertEquals, assertFalse, assertRejects } from "./asserts.ts";
import {
  handleStripeEvent,
  mapSubscriptionStatus,
  type StripeEventLike,
  type WebhookDeps,
} from "../stripe-webhook/handler.ts";

interface Call {
  fn: string;
  args: unknown[];
}

function makeMockDeps(
  opts: { duplicate?: boolean; subId?: string | null; failGrant?: boolean } = {},
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
    recordEvent(id, type, payload) {
      calls.push({ fn: "recordEvent", args: [id, type, payload] });
      return Promise.resolve(!opts.duplicate);
    },
    unrecordEvent(id) {
      calls.push({ fn: "unrecordEvent", args: [id] });
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
    applyRollover(clientId) {
      calls.push({ fn: "applyRollover", args: [clientId] });
      return Promise.resolve();
    },
    grantCredits(clientId, amount, note) {
      calls.push({ fn: "grantCredits", args: [clientId, amount, note] });
      if (opts.failGrant) return Promise.reject(new Error("grant failed"));
      return Promise.resolve();
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

Deno.test("duplicate event short-circuits with no side effects", async () => {
  const { deps, calls } = makeMockDeps({ duplicate: true });
  const result = await handleStripeEvent(
    event("invoice.paid", { customer: "cus_1", subscription: "sub_1", amount_paid: 9000 }),
    deps,
  );
  assertEquals(result.status, "duplicate");
  assertEquals(calls.length, 1); // recordEvent only
  assertEquals(calls[0].fn, "recordEvent");
});

Deno.test("invoice.paid applies rollover BEFORE the cycle grant, then records payment", async () => {
  const { deps, calls } = makeMockDeps();
  const result = await handleStripeEvent(
    event("invoice.paid", {
      id: "in_1",
      customer: "cus_1",
      subscription: "sub_1",
      amount_paid: 9000,
      hosted_invoice_url: "https://stripe.test/inv",
    }),
    deps,
  );
  assertEquals(result.status, "processed");
  const order = calls.map((c) => c.fn);
  const iRollover = order.indexOf("applyRollover");
  const iGrant = order.indexOf("grantCredits");
  assert(iRollover !== -1 && iGrant !== -1 && iRollover < iGrant, "rollover must precede grant");
  const grant = calls.find((c) => c.fn === "grantCredits")!;
  assertEquals(grant.args, ["client-1", 5, "cycle grant in_1"]);
  const payment = calls.find((c) => c.fn === "insertPayment")!.args[0] as Record<string, unknown>;
  assertEquals(payment.type, "subscription");
  assertEquals(payment.status, "succeeded");
  assertEquals(payment.amount_pence, 9000);
});

Deno.test("non-subscription invoice.paid is ignored", async () => {
  const { deps, calls } = makeMockDeps();
  const result = await handleStripeEvent(
    event("invoice.paid", { id: "in_2", customer: "cus_1", amount_paid: 500 }),
    deps,
  );
  assertEquals(result.status, "ignored");
  assertFalse(calls.some((c) => c.fn === "grantCredits"));
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

Deno.test("invoice.payment_failed marks past_due and notifies both personas", async () => {
  const { deps, calls } = makeMockDeps();
  await handleStripeEvent(
    event("invoice.payment_failed", { id: "in_3", customer: "cus_1", amount_due: 9000 }),
    deps,
  );
  const update = calls.find((c) => c.fn === "updateClient")!;
  assertEquals(update.args[1], { subscription_status: "past_due" });
  const notifs = calls.filter((c) => c.fn === "insertNotification");
  assertEquals(notifs.length, 2);
  const targets = notifs.map((n) => (n.args[0] as Record<string, unknown>).client_id);
  assert(targets.includes("client-1") && targets.includes(null));
});

Deno.test("unknown customer is ignored, never throws", async () => {
  const { deps } = makeMockDeps();
  const result = await handleStripeEvent(
    event("invoice.paid", { id: "in_4", customer: "cus_unknown", subscription: "sub_1" }),
    deps,
  );
  assertEquals(result.status, "ignored");
});

Deno.test("failed effect releases the idempotency claim so Stripe can retry", async () => {
  const { deps, calls } = makeMockDeps({ failGrant: true });
  await assertRejects(() =>
    handleStripeEvent(
      event("invoice.paid", { id: "in_x", customer: "cus_1", subscription: "sub_1", amount_paid: 9000 }),
      deps,
    )
  );
  assert(calls.some((c) => c.fn === "unrecordEvent"), "must release the claim on failure");
});

Deno.test("proration invoice.paid does not grant a cycle", async () => {
  const { deps, calls } = makeMockDeps();
  const result = await handleStripeEvent(
    event("invoice.paid", {
      id: "in_p",
      customer: "cus_1",
      subscription: "sub_1",
      amount_paid: 300,
      billing_reason: "subscription_update",
    }),
    deps,
  );
  assertEquals(result.status, "ignored");
  assertFalse(calls.some((c) => c.fn === "grantCredits"));
});

Deno.test("renewal invoice.paid (subscription_cycle) grants", async () => {
  const { deps, calls } = makeMockDeps();
  const result = await handleStripeEvent(
    event("invoice.paid", {
      id: "in_r",
      customer: "cus_1",
      subscription: "sub_1",
      amount_paid: 9000,
      billing_reason: "subscription_cycle",
    }),
    deps,
  );
  assertEquals(result.status, "processed");
  assert(calls.some((c) => c.fn === "grantCredits"));
});

Deno.test("subscription.deleted for a stale (non-current) sub is ignored", async () => {
  const { deps, calls } = makeMockDeps({ subId: "sub_current" });
  const result = await handleStripeEvent(
    event("customer.subscription.deleted", { id: "sub_old", customer: "cus_1" }),
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
