// platform-webhook: PLATFORM-account events → operators.platform_* state
// (review H31). The endpoint is stripe-webhook's mirror image, and so are
// the failure modes pinned here: a Connect event reaching this endpoint is
// ignored before any effect, a dunning redelivery rings no second bell, and
// an unfinished checkout never downgrades a live subscription.
import { assert, assertEquals, assertRejects } from "./asserts.ts";
import {
  handlePlatformEvent,
  InFlightError,
  mapPlatformSubscriptionStatus,
  type PlatformEventLike,
  type PlatformWebhookDeps,
} from "../platform-webhook/handler.ts";

const OP_ID = "00000000-0000-4000-a000-0000000000aa";

interface Recorded {
  call: string;
  args: unknown[];
}

function makeDeps(opts: {
  claim?: "fresh" | "duplicate" | "in_flight";
  opBySub?: { id: string; platform_subscription_id: string | null } | null;
  opByCustomer?: { id: string; platform_subscription_id: string | null } | null;
  updateCount?: number;
} = {}): { deps: PlatformWebhookDeps; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  return {
    recorded,
    deps: {
      claimEvent(id, type, payload) {
        recorded.push({ call: "claimEvent", args: [id, type, payload] });
        return Promise.resolve(opts.claim ?? "fresh");
      },
      markProcessed(id) {
        recorded.push({ call: "markProcessed", args: [id] });
        return Promise.resolve();
      },
      findOperatorBySubscription(subId) {
        recorded.push({ call: "findOperatorBySubscription", args: [subId] });
        return Promise.resolve(opts.opBySub ?? null);
      },
      findOperatorByCustomer(customerId) {
        recorded.push({ call: "findOperatorByCustomer", args: [customerId] });
        return Promise.resolve(opts.opByCustomer ?? null);
      },
      updateOperator(id, fields, unlessStatus) {
        recorded.push({ call: "updateOperator", args: [id, fields, unlessStatus] });
        return Promise.resolve(opts.updateCount ?? 1);
      },
      insertNotification(row) {
        recorded.push({ call: "insertNotification", args: [row] });
        return Promise.resolve();
      },
    },
  };
}

function event(
  type: string,
  object: Record<string, unknown>,
  over: Partial<PlatformEventLike> = {},
): PlatformEventLike {
  return { id: "evt_1", type, data: { object }, ...over };
}

Deno.test("a Connect event (account set) is ignored before ANY effect — even the claim", async () => {
  const { deps, recorded } = makeDeps();
  const res = await handlePlatformEvent(
    event("customer.subscription.updated", { id: "sub_1", status: "active" }, {
      account: "acct_123",
    }),
    deps,
  );
  assertEquals(res.status, "ignored");
  assertEquals(recorded.length, 0, "a Connect event drove effects on the platform endpoint");
});

Deno.test("duplicate claim acks with no effects; in-flight throws so Stripe retries", async () => {
  const dup = makeDeps({ claim: "duplicate" });
  const res = await handlePlatformEvent(
    event("customer.subscription.updated", { id: "sub_1", status: "active" }),
    dup.deps,
  );
  assertEquals(res.status, "duplicate");
  assert(!dup.recorded.some((r) => r.call === "updateOperator"));

  const inflight = makeDeps({ claim: "in_flight" });
  const err = await assertRejects(() =>
    handlePlatformEvent(
      event("customer.subscription.updated", { id: "sub_1", status: "active" }),
      inflight.deps,
    )
  );
  assert(err instanceof InFlightError, `got ${String(err)}`);
});

Deno.test("checkout.session.completed (paid) binds the subscription and activates", async () => {
  const { deps, recorded } = makeDeps();
  const res = await handlePlatformEvent(
    event("checkout.session.completed", {
      mode: "subscription",
      subscription: "sub_new",
      payment_status: "paid",
      metadata: { operator_id: OP_ID },
    }),
    deps,
  );
  assertEquals(res.status, "processed");
  const upd = recorded.find((r) => r.call === "updateOperator");
  assertEquals(upd?.args[0], OP_ID);
  assertEquals(upd?.args[1], {
    platform_subscription_id: "sub_new",
    platform_subscription_status: "active",
  });
});

Deno.test("a trial's first session is no_payment_required and still activates", async () => {
  const { deps, recorded } = makeDeps();
  await handlePlatformEvent(
    event("checkout.session.completed", {
      mode: "subscription",
      subscription: "sub_new",
      payment_status: "no_payment_required",
      metadata: { operator_id: OP_ID },
    }),
    deps,
  );
  const upd = recorded.find((r) => r.call === "updateOperator");
  assertEquals(
    (upd?.args[1] as Record<string, unknown>).platform_subscription_status,
    "active",
  );
});

Deno.test("an UNPAID completed session binds the id but grants no status — the H32 lesson", async () => {
  const { deps, recorded } = makeDeps();
  const res = await handlePlatformEvent(
    event("checkout.session.completed", {
      mode: "subscription",
      subscription: "sub_new",
      payment_status: "unpaid",
      metadata: { operator_id: OP_ID },
    }),
    deps,
  );
  assertEquals(res.status, "processed");
  const upd = recorded.find((r) => r.call === "updateOperator");
  assertEquals(upd?.args[1], { platform_subscription_id: "sub_new" });
});

Deno.test("completed sessions that are not ours are ignored", async () => {
  for (
    const object of [
      { mode: "payment", subscription: "sub_x", metadata: { operator_id: OP_ID } },
      { mode: "subscription", subscription: "sub_x", metadata: {} },
      { mode: "subscription", metadata: { operator_id: OP_ID } },
    ]
  ) {
    const { deps, recorded } = makeDeps();
    const res = await handlePlatformEvent(event("checkout.session.completed", object), deps);
    assertEquals(res.status, "ignored");
    assert(!recorded.some((r) => r.call === "updateOperator"));
  }
});

Deno.test("subscription status map: trialing is active, incomplete decides nothing", () => {
  assertEquals(mapPlatformSubscriptionStatus("trialing"), "active");
  assertEquals(mapPlatformSubscriptionStatus("active"), "active");
  assertEquals(mapPlatformSubscriptionStatus("past_due"), "past_due");
  assertEquals(mapPlatformSubscriptionStatus("unpaid"), "past_due");
  assertEquals(mapPlatformSubscriptionStatus("paused"), "paused");
  assertEquals(mapPlatformSubscriptionStatus("canceled"), "cancelled");
  assertEquals(mapPlatformSubscriptionStatus("incomplete_expired"), "cancelled");
  assertEquals(mapPlatformSubscriptionStatus("incomplete"), null);
  assertEquals(mapPlatformSubscriptionStatus("something_new"), null);
});

Deno.test("subscription.updated mirrors the mapped status onto the bound operator", async () => {
  const { deps, recorded } = makeDeps({
    opBySub: { id: OP_ID, platform_subscription_id: "sub_1" },
  });
  await handlePlatformEvent(
    event("customer.subscription.updated", { id: "sub_1", customer: "cus_1", status: "past_due" }),
    deps,
  );
  const upd = recorded.find((r) => r.call === "updateOperator");
  assertEquals(upd?.args[1], {
    platform_subscription_id: "sub_1",
    platform_subscription_status: "past_due",
  });
});

Deno.test("an incomplete subscription event never downgrades a live row", async () => {
  const { deps, recorded } = makeDeps({
    opBySub: { id: OP_ID, platform_subscription_id: "sub_1" },
  });
  const res = await handlePlatformEvent(
    event("customer.subscription.updated", { id: "sub_1", customer: "cus_1", status: "incomplete" }),
    deps,
  );
  assertEquals(res.status, "ignored");
  assert(!recorded.some((r) => r.call === "updateOperator"));
});

Deno.test("subscription.created can beat the checkout event: bound through the customer, but only while unbound", async () => {
  // Unbound operator: the customer lookup binds it.
  const race = makeDeps({
    opBySub: null,
    opByCustomer: { id: OP_ID, platform_subscription_id: null },
  });
  await handlePlatformEvent(
    event("customer.subscription.created", { id: "sub_new", customer: "cus_1", status: "trialing" }),
    race.deps,
  );
  const upd = race.recorded.find((r) => r.call === "updateOperator");
  assertEquals(upd?.args[1], {
    platform_subscription_id: "sub_new",
    platform_subscription_status: "active",
  });

  // Already bound to a DIFFERENT subscription: some other subscription's
  // event must not clobber the bound one.
  const bound = makeDeps({
    opBySub: null,
    opByCustomer: { id: OP_ID, platform_subscription_id: "sub_existing" },
  });
  const res = await handlePlatformEvent(
    event("customer.subscription.created", { id: "sub_other", customer: "cus_1", status: "active" }),
    bound.deps,
  );
  assertEquals(res.status, "ignored");
  assert(!bound.recorded.some((r) => r.call === "updateOperator"));
});

Deno.test("subscription.deleted cancels and tells the operator — once", async () => {
  const first = makeDeps({
    opBySub: { id: OP_ID, platform_subscription_id: "sub_1" },
    updateCount: 1,
  });
  await handlePlatformEvent(
    event("customer.subscription.deleted", { id: "sub_1", status: "canceled" }),
    first.deps,
  );
  const upd = first.recorded.find((r) => r.call === "updateOperator");
  assertEquals(upd?.args[1], { platform_subscription_status: "cancelled" });
  assertEquals(upd?.args[2], "cancelled");
  const note = first.recorded.find((r) => r.call === "insertNotification");
  assert(note, "no cancellation notification");
  const row = note.args[0] as Record<string, unknown>;
  assertEquals(row.client_id, null);
  assertEquals(row.type, "subscription_cancelled");

  // Redelivery: the row is already cancelled, the gated update changes
  // nothing, and the bell must not ring again.
  const again = makeDeps({
    opBySub: { id: OP_ID, platform_subscription_id: "sub_1" },
    updateCount: 0,
  });
  await handlePlatformEvent(
    event("customer.subscription.deleted", { id: "sub_1", status: "canceled" }),
    again.deps,
  );
  assert(
    !again.recorded.some((r) => r.call === "insertNotification"),
    "a redelivered cancellation rang the bell twice",
  );
});

Deno.test("invoice.payment_failed marks past_due and notifies the OPERATOR — transition-gated", async () => {
  const first = makeDeps({
    opBySub: { id: OP_ID, platform_subscription_id: "sub_1" },
    updateCount: 1,
  });
  await handlePlatformEvent(
    event("invoice.payment_failed", { id: "in_1", subscription: "sub_1" }),
    first.deps,
  );
  const upd = first.recorded.find((r) => r.call === "updateOperator");
  assertEquals(upd?.args[1], { platform_subscription_status: "past_due" });
  assertEquals(upd?.args[2], "past_due");
  const note = first.recorded.find((r) => r.call === "insertNotification");
  assert(note, "no payment-failed notification");
  const row = note.args[0] as Record<string, unknown>;
  assertEquals(row.operator_id, OP_ID);
  assertEquals(row.client_id, null);
  assertEquals(row.type, "payment_failed");

  // Stripe redelivers payment_failed on every dunning retry with a FRESH
  // event id (the H13 lesson) — already past_due means no second bell.
  const retry = makeDeps({
    opBySub: { id: OP_ID, platform_subscription_id: "sub_1" },
    updateCount: 0,
  });
  await handlePlatformEvent(
    event("invoice.payment_failed", { id: "in_2", subscription: "sub_1" }),
    retry.deps,
  );
  assert(
    !retry.recorded.some((r) => r.call === "insertNotification"),
    "a dunning retry rang the bell twice",
  );
});

Deno.test("events for nobody we know are ignored, and unknown types ack silently", async () => {
  const { deps } = makeDeps({ opBySub: null, opByCustomer: null });
  const res = await handlePlatformEvent(
    event("invoice.payment_failed", { id: "in_1", subscription: "sub_stranger" }),
    deps,
  );
  assertEquals(res.status, "ignored");

  const other = makeDeps();
  const res2 = await handlePlatformEvent(event("charge.succeeded", { id: "ch_1" }), other.deps);
  assertEquals(res2.status, "ignored");
});

Deno.test("index.ts reads its OWN secret, never the Connect endpoint's", async () => {
  // No seam exists for this: the secret is read inside Deno.serve, and a
  // wrong-secret wiring fails silently and completely (every signature
  // rejected, Stripe gives up after three days). The source is the contract.
  const src = await Deno.readTextFile(
    new URL("../platform-webhook/index.ts", import.meta.url),
  );
  assert(src.includes('Deno.env.get("STRIPE_PLATFORM_WEBHOOK_SECRET")'));
  assert(
    !src.includes('Deno.env.get("STRIPE_WEBHOOK_SECRET")'),
    "platform-webhook reads the Connect endpoint's secret",
  );
});
