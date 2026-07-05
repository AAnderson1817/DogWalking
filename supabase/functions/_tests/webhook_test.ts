// stripe-webhook dispatch: idempotency guard + core event effects (mocked deps).
import { assert, assertEquals, assertFalse } from "./asserts.ts";
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

function makeMockDeps(opts: { duplicate?: boolean } = {}): { deps: WebhookDeps; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    id: "client-1",
    operator_id: "op-1",
    full_name: "Amelia Hart",
    plan_id: "plan-1",
    subscription_status: "active",
  };
  const plan = { id: "plan-1", credits_per_cycle: 5, stripe_price_id: "price_1" };
  const deps: WebhookDeps = {
    recordEvent(id, type, payload) {
      calls.push({ fn: "recordEvent", args: [id, type, payload] });
      return Promise.resolve(!opts.duplicate);
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
