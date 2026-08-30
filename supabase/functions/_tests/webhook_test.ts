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
    hasFailedInvoicePayment?: boolean;
    noPayment?: boolean;
    knownAccount?: string;
    clientNotOwned?: boolean;
    paymentType?: string;
    knownChargeId?: string | null;
    reversal?: ReversalResult;
    /** Cached plan on the client row; defaults to the plan on price_1. */
    clientPlanId?: string | null;
    /** What fn_apply_topup reports: false = this intent was already applied. */
    topupApplied?: boolean;
  } = {},
): { deps: WebhookDeps; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    id: "client-1",
    operator_id: "op-1",
    full_name: "Amelia Hart",
    plan_id: opts.clientPlanId === undefined ? "plan-1" : opts.clientPlanId,
    subscription_status: "active",
    stripe_subscription_id: opts.subId === undefined ? "sub_1" : opts.subId,
  };
  const plan = { id: "plan-1", credits_per_cycle: 5, stripe_price_id: "price_1" };
  // A SECOND plan on a second price, so "the Stripe price moved" is a state
  // these tests can express at all (review H11). Different credits, because
  // the whole defect is granting the wrong number of them.
  const plan2 = { id: "plan-2", credits_per_cycle: 12, stripe_price_id: "price_2" };
  const byId: Record<string, typeof plan> = { "plan-1": plan, "plan-2": plan2 };
  const byPrice: Record<string, typeof plan> = { price_1: plan, price_2: plan2 };
  const deps: WebhookDeps = {
    claimEvent(id, type, payload) {
      calls.push({ fn: "claimEvent", args: [id, type, payload] });
      return Promise.resolve(opts.claim ?? "fresh");
    },
    markProcessed(id) {
      calls.push({ fn: "markProcessed", args: [id] });
      return Promise.resolve();
    },
    findClientByCustomer(customerId, operatorId) {
      calls.push({ fn: "findClientByCustomer", args: [customerId, operatorId] });
      return Promise.resolve(customerId === "cus_1" ? client : null);
    },
    resolveOperatorByAccount(accountId) {
      calls.push({ fn: "resolveOperatorByAccount", args: [accountId] });
      return Promise.resolve(accountId === (opts.knownAccount ?? "acct_1") ? "op-1" : null);
    },
    updateConnectState(accountId, fields) {
      calls.push({ fn: "updateConnectState", args: [accountId, fields] });
      return Promise.resolve();
    },
    getPlan(planId) {
      calls.push({ fn: "getPlan", args: [planId] });
      return Promise.resolve(byId[planId] ?? null);
    },
    findPlanByPriceId(operatorId, priceId) {
      calls.push({ fn: "findPlanByPriceId", args: [operatorId, priceId] });
      return Promise.resolve(byPrice[priceId] ?? null);
    },
    updateClient(id, fields, operatorId) {
      calls.push({ fn: "updateClient", args: [id, fields, operatorId] });
      return Promise.resolve(opts.clientNotOwned ? 0 : 1);
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
    hasFailedPaymentForInvoice(invoiceId) {
      calls.push({ fn: "hasFailedPaymentForInvoice", args: [invoiceId] });
      return Promise.resolve(opts.hasFailedInvoicePayment ?? false);
    },
    applyTopup(args) {
      calls.push({ fn: "applyTopup", args: [args] });
      return Promise.resolve(opts.topupApplied ?? true);
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

// `null` means "omit the field entirely" — a platform-account event. It has
// to be null rather than undefined: a JS default parameter fires on an
// explicit `undefined`, so `event(t, o, undefined)` would silently get
// "acct_1" and the no-account test would assert nothing.
function event(
  type: string,
  object: Record<string, unknown>,
  account: string | null = "acct_1",
): StripeEventLike {
  return { id: `evt_${type}`, type, data: { object }, ...(account ? { account } : {}) };
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
    // PAID_CYCLE carries billing_reason 'subscription_cycle', so this is a
    // renewal and rollover runs. A first invoice would be false — see
    // "a first invoice is NOT a renewal".
    isRenewal: true,
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

// ── payment-mode completions: top-ups (0044, review H32) ──────────────────

/** A completed, PAID payment-mode top-up session as Stripe delivers it. */
const TOPUP_SESSION = {
  mode: "payment",
  payment_status: "paid",
  customer: "cus_1",
  payment_intent: "pi_topup_1",
  amount_total: 5000,
  metadata: { client_id: "client-1", operator_id: "op-1", sanpo_topup_credits: "10" },
};

Deno.test("a completed top-up applies atomically and tells both personas once", async () => {
  const { deps, calls } = makeMockDeps();
  const result = await handleStripeEvent(
    event("checkout.session.completed", TOPUP_SESSION),
    deps,
  );
  assertEquals(result.status, "processed");
  const apply = calls.find((c) => c.fn === "applyTopup")!;
  assertEquals(apply.args[0], {
    clientId: "client-1",
    credits: 10,
    paymentIntentId: "pi_topup_1",
    amountPence: 5000,
  });
  // The client is resolved through the session's CUSTOMER scoped to the
  // event's operator — never through the metadata, which any operator can
  // forge in their own dashboard.
  const lookup = calls.find((c) => c.fn === "findClientByCustomer")!;
  assertEquals(lookup.args, ["cus_1", "op-1"]);
  const notifs = calls.filter((c) => c.fn === "insertNotification")
    .map((c) => c.args[0] as Record<string, unknown>);
  assertEquals(notifs.length, 2);
  const targets = notifs.map((n) => n.client_id);
  assert(targets.includes("client-1") && targets.includes(null));
  for (const n of notifs) {
    assertEquals(n.type, "payment_taken");
    assert(String(n.title).includes("10"), "the credit count is the message");
  }
  assert(
    notifs.some((n) => String(n.body).includes("$50.00")),
    "the amount is part of the disclosure (H12)",
  );
});

Deno.test("a redelivered top-up applies nothing and re-announces nothing", async () => {
  // fn_apply_topup returns false when the intent was already applied —
  // including after a refund. Stripe redelivers for three days, and a bell
  // row per redelivery would announce one payment several times.
  const { deps, calls } = makeMockDeps({ topupApplied: false });
  const result = await handleStripeEvent(
    event("checkout.session.completed", TOPUP_SESSION),
    deps,
  );
  assertEquals(result.status, "processed");
  assert(calls.some((c) => c.fn === "applyTopup"));
  assertFalse(calls.some((c) => c.fn === "insertNotification"));
});

Deno.test("a crafted top-up naming another tenant's customer grants nothing", async () => {
  // Session metadata AND the customer id are attacker-controlled on a
  // Connect endpoint; the scoped customer lookup is the control.
  const { deps, calls } = makeMockDeps();
  const result = await handleStripeEvent(
    event("checkout.session.completed", { ...TOPUP_SESSION, customer: "cus_foreign" }),
    deps,
  );
  assertEquals(result.status, "ignored");
  assertFalse(calls.some((c) => c.fn === "applyTopup"));
  assertFalse(calls.some((c) => c.fn === "insertNotification"));
});

Deno.test("malformed or missing credit counts never reach the RPC", async () => {
  // "2147483648" is int4-overflow: past the bound the RPC cannot encode
  // p_credits, so applying would 500 forever with the money already taken.
  for (const credits of ["0", "-3", "2.5", "ten", "", "2147483648", "10001"]) {
    const { deps, calls } = makeMockDeps();
    const meta = { ...TOPUP_SESSION.metadata, sanpo_topup_credits: credits };
    const result = await handleStripeEvent(
      event("checkout.session.completed", { ...TOPUP_SESSION, metadata: meta }),
      deps,
    );
    assertEquals(result.status, "ignored", `credits=${JSON.stringify(credits)}`);
    assertFalse(calls.some((c) => c.fn === "applyTopup"));
  }
  // No marker at all: an ordinary payment-mode session that is not ours.
  const { deps, calls } = makeMockDeps();
  const result = await handleStripeEvent(
    event("checkout.session.completed", {
      ...TOPUP_SESSION,
      metadata: { client_id: "client-1" },
    }),
    deps,
  );
  assertEquals(result.status, "ignored");
  assertFalse(calls.some((c) => c.fn === "applyTopup"));
});

Deno.test("an UNPAID completion grants nothing — the async event decides", async () => {
  // checkout.session.completed fires with payment_status 'unpaid' for
  // delayed-notification methods (ACH — one operator dashboard toggle away).
  // Granting there is spendable credits for money never received, with no
  // reversal path when the debit later bounces.
  const { deps, calls } = makeMockDeps();
  const result = await handleStripeEvent(
    event("checkout.session.completed", { ...TOPUP_SESSION, payment_status: "unpaid" }),
    deps,
  );
  assertEquals(result.status, "processed");
  assertFalse(calls.some((c) => c.fn === "applyTopup"));
  assertFalse(calls.some((c) => c.fn === "insertNotification"));
});

Deno.test("async_payment_succeeded applies the deferred top-up", async () => {
  const { deps, calls } = makeMockDeps();
  const result = await handleStripeEvent(
    event("checkout.session.async_payment_succeeded", {
      ...TOPUP_SESSION,
      payment_status: "paid",
    }),
    deps,
  );
  assertEquals(result.status, "processed");
  const apply = calls.find((c) => c.fn === "applyTopup")!;
  assertEquals(apply.args[0], {
    clientId: "client-1",
    credits: 10,
    paymentIntentId: "pi_topup_1",
    amountPence: 5000,
  });
});

Deno.test("async_payment_failed grants nothing and tells both personas", async () => {
  // Nothing was granted at completion (the arm defers on unpaid), so this is
  // disclosure, not reversal — but it must not be silent: the client may
  // believe they paid, and the operator may be counting on the credits.
  const { deps, calls } = makeMockDeps();
  const result = await handleStripeEvent(
    event("checkout.session.async_payment_failed", TOPUP_SESSION),
    deps,
  );
  assertEquals(result.status, "processed");
  assertFalse(calls.some((c) => c.fn === "applyTopup"));
  const notifs = calls.filter((c) => c.fn === "insertNotification")
    .map((c) => c.args[0] as Record<string, unknown>);
  assertEquals(notifs.length, 2);
  for (const n of notifs) assertEquals(n.type, "payment_failed");
  const targets = notifs.map((n) => n.client_id);
  assert(targets.includes("client-1") && targets.includes(null));
});

Deno.test("a session with no positive amount never reaches the RPC", async () => {
  // Outside the contract of anything create-checkout mints; recording it
  // would write an unrefundable $0 'succeeded' row (fn_reverse_payment
  // refuses any reversal exceeding amount_pence, so a later refund would
  // 500 on every redelivery for three days).
  for (const amount_total of [undefined, 0, -100, 2.5]) {
    const { deps, calls } = makeMockDeps();
    const obj: Record<string, unknown> = { ...TOPUP_SESSION, amount_total };
    if (amount_total === undefined) delete obj.amount_total;
    const result = await handleStripeEvent(event("checkout.session.completed", obj), deps);
    assertEquals(result.status, "ignored", `amount_total=${amount_total}`);
    assertFalse(calls.some((c) => c.fn === "applyTopup"));
  }
});

Deno.test("a completed card-save (setup mode) tells the operator only", async () => {
  const { deps, calls } = makeMockDeps();
  const result = await handleStripeEvent(
    event("checkout.session.completed", { mode: "setup", customer: "cus_1" }),
    deps,
  );
  assertEquals(result.status, "processed");
  const notifs = calls.filter((c) => c.fn === "insertNotification")
    .map((c) => c.args[0] as Record<string, unknown>);
  assertEquals(notifs.length, 1);
  assertEquals(notifs[0].client_id, null);
  assertEquals(notifs[0].type, "card_saved");
});

Deno.test("a card-save for an unknown customer is ignored", async () => {
  const { deps, calls } = makeMockDeps();
  const result = await handleStripeEvent(
    event("checkout.session.completed", { mode: "setup", customer: "cus_foreign" }),
    deps,
  );
  assertEquals(result.status, "ignored");
  assertFalse(calls.some((c) => c.fn === "insertNotification"));
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
      metadata: { sanpo_plan_change_intent_id: "intent-1" },
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
  assertEquals(update.args[1], {
    subscription_status: "cancelled",
    stripe_subscription_id: null,
    current_period_end: null,
  });
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

  // The invoice id must survive the expanded-object form. Asserting only the
  // amount passed against a version that read the object itself as a string,
  // got null, and would have dropped the reversal entirely in production —
  // the mock finds a payment whatever reference it is handed.
  const look = calls.find((c) => c.fn === "findPaymentForReversal");
  assertEquals((look!.args[0] as { invoiceId?: string | null }).invoiceId, "in_9");
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

// ── Connect tenancy boundary (review B5) ───────────────────────────────────
// A Connect endpoint receives events for EVERY account connected to the
// platform. event.account is therefore an authorization input, not a routing
// hint, and these are the tests that say so.

Deno.test("an event from an account we do not know is ignored", async () => {
  const { deps, calls } = makeMockDeps();
  const res = await handleStripeEvent(
    event("invoice.paid", { ...PAID_CYCLE }, "acct_someone_else"),
    deps,
  );
  assertEquals(res.status, "ignored");
  assertFalse(calls.some((c) => c.fn === "applyInvoicePaid"), "no effects for a foreign account");
});

Deno.test("an event with NO account is ignored", async () => {
  // A platform-account event. Sanpo takes no money on the platform account —
  // operators are the merchant of record — so there is nothing legitimate to
  // do with one, and acting would mean guessing whose it was.
  const { deps, calls } = makeMockDeps();
  const res = await handleStripeEvent(
    event("invoice.paid", { ...PAID_CYCLE }, null),
    deps,
  );
  assertEquals(res.status, "ignored");
  assertFalse(calls.some((c) => c.fn === "applyInvoicePaid"));
});

Deno.test("the client lookup is scoped to the operator the account resolved to", async () => {
  const { deps, calls } = makeMockDeps();
  await handleStripeEvent(event("invoice.paid", { ...PAID_CYCLE }), deps);
  const look = calls.find((c) => c.fn === "findClientByCustomer");
  assertEquals(look!.args, ["cus_1", "op-1"]);
});

Deno.test("checkout metadata naming another operator's client changes nothing", async () => {
  // Session metadata is attacker-controlled here: any connected operator can
  // craft a Checkout Session in their own Stripe dashboard carrying someone
  // else's client_id. The id alone is not an authorization, so the update is
  // scoped and a zero-row result is ignored rather than treated as success.
  const { deps, calls } = makeMockDeps({ clientNotOwned: true });
  const res = await handleStripeEvent(
    event("checkout.session.completed", {
      mode: "subscription",
      customer: "cus_victim",
      subscription: "sub_evil",
      metadata: { client_id: "client-belonging-to-someone-else" },
    }),
    deps,
  );
  assertEquals(res.status, "ignored");
  const upd = calls.find((c) => c.fn === "updateClient");
  assertEquals(upd!.args[2], "op-1", "the operator must come from event.account");
});

Deno.test("a reversal is scoped to the operator too", async () => {
  const { deps, calls } = makeMockDeps();
  await handleStripeEvent(
    event("charge.refunded", { id: "ch_t", payment_intent: "pi_t", amount_refunded: 100 }),
    deps,
  );
  const look = calls.find((c) => c.fn === "findPaymentForReversal");
  assertEquals((look!.args[0] as { operatorId: string }).operatorId, "op-1");
});

Deno.test("account.updated mirrors Stripe's view of the connected account", async () => {
  const { deps, calls } = makeMockDeps();
  const res = await handleStripeEvent(
    event("account.updated", {
      id: "acct_1",
      charges_enabled: true,
      payouts_enabled: false,
      details_submitted: true,
    }),
    deps,
  );
  assertEquals(res.status, "processed");
  const upd = calls.find((c) => c.fn === "updateConnectState");
  assertEquals(upd!.args[0], "acct_1");
  assertEquals(upd!.args[1], {
    stripe_charges_enabled: true,
    stripe_payouts_enabled: false,
    stripe_details_submitted: true,
  });
});

Deno.test("charges_enabled going false is mirrored, not just the happy path", async () => {
  // Stripe disables charges when a requirement comes due. If only the
  // enabling direction were mirrored, the operator would keep taking payments
  // Stripe was already rejecting.
  const { deps, calls } = makeMockDeps();
  await handleStripeEvent(
    event("account.updated", {
      id: "acct_1",
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: true,
    }),
    deps,
  );
  const upd = calls.find((c) => c.fn === "updateConnectState");
  assertEquals(
    (upd!.args[1] as { stripe_charges_enabled: boolean }).stripe_charges_enabled,
    false,
  );
});

// ── Subscription correctness (review H9/H10 + revalidation finds) ──────────

Deno.test("invoice.paid for a DIFFERENT subscription than the client's is ignored", async () => {
  // A customer can carry more than one live subscription, and their invoices
  // have different ids — so uq_payments_subscription_invoice does not catch
  // it and the client is charged twice and granted two cycles. Both sibling
  // subscription arms scoped this; invoice.paid did not.
  const { deps, calls } = makeMockDeps({ subId: "sub_1" });
  const res = await handleStripeEvent(
    event("invoice.paid", { ...PAID_CYCLE, subscription: "sub_ROGUE" }),
    deps,
  );
  assertEquals(res.status, "ignored");
  assertFalse(
    calls.some((c) => c.fn === "applyInvoicePaid"),
    "a second subscription must not grant a cycle",
  );
});

Deno.test("invoice.paid for an UNBOUND client is still applied", async () => {
  // checkout.session.completed and invoice.paid race. Refusing here would drop
  // the first cycle of every new subscription.
  const { deps, calls } = makeMockDeps({ subId: null });
  const res = await handleStripeEvent(event("invoice.paid", { ...PAID_CYCLE }), deps);
  assertEquals(res.status, "processed");
  assert(calls.some((c) => c.fn === "applyInvoicePaid"));
});

Deno.test("a first invoice is NOT a renewal — rollover must not run", async () => {
  // On rollover 'none', fn_apply_rollover expires the whole balance. Running
  // it on subscription_create destroys credit granted before billing started.
  const { deps, calls } = makeMockDeps();
  await handleStripeEvent(
    event("invoice.paid", { ...PAID_CYCLE, billing_reason: "subscription_create" }),
    deps,
  );
  const applied = calls.find((c) => c.fn === "applyInvoicePaid");
  assertEquals((applied!.args[0] as { isRenewal: boolean }).isRenewal, false);
});

Deno.test("a renewal IS a renewal — rollover runs", async () => {
  const { deps, calls } = makeMockDeps();
  await handleStripeEvent(
    event("invoice.paid", { ...PAID_CYCLE, billing_reason: "subscription_cycle" }),
    deps,
  );
  const applied = calls.find((c) => c.fn === "applyInvoicePaid");
  assertEquals((applied!.args[0] as { isRenewal: boolean }).isRenewal, true);
});

Deno.test("cancelling clears the subscription binding, not just the status", async () => {
  // Leaving stripe_subscription_id set means change-plan still takes the
  // Stripe path on a dead subscription — after committing a pending intent.
  // current_period_end goes too, or Money prints a renewal date for a
  // subscription that will never renew.
  const { deps, calls } = makeMockDeps({ subId: "sub_1" });
  await handleStripeEvent(
    event("customer.subscription.deleted", { id: "sub_1", customer: "cus_1" }),
    deps,
  );
  const upd = calls.find((c) => c.fn === "updateClient");
  assertEquals(upd!.args[1], {
    subscription_status: "cancelled",
    stripe_subscription_id: null,
    current_period_end: null,
  });
});

Deno.test("cancelling tells the operator — walks stop, and they must know why", async () => {
  const { deps, calls } = makeMockDeps({ subId: "sub_1" });
  await handleStripeEvent(
    event("customer.subscription.deleted", { id: "sub_1", customer: "cus_1" }),
    deps,
  );
  const note = calls.find((c) => c.fn === "insertNotification");
  assert(note, "no notification raised");
  const row = note.args[0] as { type: string; client_id: string | null };
  assertEquals(row.type, "subscription_cancelled");
  assertEquals(row.client_id, null, "this is the operator's problem, not the client's");
});

// ── Payment-row hygiene (review M3, L5) ────────────────────────────────────

Deno.test("a redelivered invoice.payment_failed does not add a second failed row", async () => {
  // Stripe retries a failed invoice on its own dunning schedule and redelivers
  // the event with a FRESH event id, so the stripe_events claim ledger cannot
  // dedupe it. Without this guard the Money screen accrues one "Needs
  // attention" row per retry for a single unpaid invoice.
  const { deps, calls } = makeMockDeps({ hasFailedInvoicePayment: true });
  const res = await handleStripeEvent(
    event("invoice.payment_failed", {
      id: "in_dunning",
      customer: "cus_1",
      amount_due: 9000,
      currency: "usd",
    }),
    deps,
  );
  assertEquals(res.status, "processed");
  assertFalse(
    calls.some((c) => c.fn === "insertPayment"),
    "a second failed row for one invoice is noise, not information",
  );
});

Deno.test("the FIRST invoice.payment_failed still records and notifies", async () => {
  const { deps, calls } = makeMockDeps({ hasFailedInvoicePayment: false });
  await handleStripeEvent(
    event("invoice.payment_failed", {
      id: "in_first_fail",
      customer: "cus_1",
      amount_due: 9000,
      currency: "usd",
    }),
    deps,
  );
  assert(calls.some((c) => c.fn === "insertPayment"), "the debt must be recorded");
  // A card decline is the client's to fix, so both personas hear about it.
  const notes = calls.filter((c) => c.fn === "insertNotification");
  assertEquals(notes.length, 2);
});

Deno.test("past_due is still set even when the failed row is deduped", async () => {
  // The dedupe must not swallow the state change: Stripe's later retries are
  // exactly when the account is most past due.
  const { deps, calls } = makeMockDeps({ hasFailedInvoicePayment: true });
  await handleStripeEvent(
    event("invoice.payment_failed", { id: "in_d", customer: "cus_1", amount_due: 9000 }),
    deps,
  );
  const upd = calls.find((c) => c.fn === "updateClient");
  assertEquals((upd!.args[1] as { subscription_status: string }).subscription_status, "past_due");
});

// ── H11: an out-of-band price change must not diverge plan from price ──────
//
// `plan_id` used to be written ONLY inside `if (intent)`, so a price changed
// in the Stripe dashboard — which per B5/B6 is the only place a subscription's
// price exists to be edited — left the cached plan pointing at the old one.
// `resolvePlan` then short-circuited on that cache, so every renewal granted
// the OLD plan's credits while Stripe collected the NEW price, forever.

/** A subscription sitting on `price`, bound to the client's current sub. */
function subOnPrice(price: string, metadata?: Record<string, unknown>) {
  return {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    items: { data: [{ price: { id: price } }] },
    ...(metadata ? { metadata } : {}),
  };
}

function fields(calls: Call[]): Record<string, unknown> {
  return calls.find((c) => c.fn === "updateClient")!.args[1] as Record<string, unknown>;
}

function notifications(calls: Call[], type: string): Record<string, unknown>[] {
  return calls
    .filter((c) => c.fn === "insertNotification")
    .map((c) => c.args[0] as Record<string, unknown>)
    .filter((n) => n.type === type);
}

Deno.test("H11: a price change made outside Sanpo moves plan_id to match Stripe", async () => {
  const { deps, calls } = makeMockDeps({ subId: "sub_1" });
  const result = await handleStripeEvent(
    event("customer.subscription.updated", subOnPrice("price_2")),
    deps,
  );
  assertEquals(result.status, "processed");
  // Stripe is the source of truth for what is being billed.
  assertEquals(fields(calls).plan_id, "plan-2");
  const notes = notifications(calls, "plan_changed_externally");
  assertEquals(notes.length, 1);
  // The operator hears about it; the client does not — they did not do this
  // and there is nothing for them to act on.
  assertEquals(notes[0].client_id, null);
});

Deno.test("H11: an in-app plan change still wins, and is not reported as external", async () => {
  const { deps, calls } = makeMockDeps({ subId: "sub_1" });
  await handleStripeEvent(
    event(
      "customer.subscription.updated",
      subOnPrice("price_2", { sanpo_plan_change_intent_id: "intent-9" }),
    ),
    deps,
  );
  // The mock's intent resolves to plan-1; the intent branch must take
  // precedence over the price-derived plan, because an in-app change carries
  // the operator's stated intention and its bookkeeping.
  assertEquals(fields(calls).plan_id, "plan-1");
  assert(calls.some((c) => c.fn === "applyPlanChangeIntent"));
  assertEquals(notifications(calls, "plan_changed_externally").length, 0);
});

/**
 * `customer.subscription.updated` fires for many reasons — a status change, a
 * period roll, a metadata edit. Notifying on every one would make the alert
 * worthless within a week.
 */
Deno.test("H11: no notification and no plan write when the price did not change", async () => {
  const { deps, calls } = makeMockDeps({ subId: "sub_1" });
  await handleStripeEvent(
    event("customer.subscription.updated", subOnPrice("price_1")),
    deps,
  );
  assertEquals(notifications(calls, "plan_changed_externally").length, 0);
  assertFalse("plan_id" in fields(calls));
});

/**
 * A price Sanpo has no plan for cannot be reconciled — there is no local plan
 * to point at. Nulling `plan_id` would strand the client with no credits at
 * all, so the row is left alone and the operator is told.
 */
Deno.test("H11: an unknown price notifies but never clobbers plan_id", async () => {
  const { deps, calls } = makeMockDeps({ subId: "sub_1" });
  await handleStripeEvent(
    event("customer.subscription.updated", subOnPrice("price_99")),
    deps,
  );
  assertFalse("plan_id" in fields(calls));
  const notes = notifications(calls, "plan_changed_externally");
  assertEquals(notes.length, 1);
  assert(String(notes[0].title).includes("price Sanpo does not know"));
});

/**
 * The half that costs money. `resolvePlan` now prefers the price actually
 * invoiced over the cached id, so a renewal grants what was paid for.
 */
Deno.test("H11: a renewal grants the credits of the price actually invoiced", async () => {
  const { deps, calls } = makeMockDeps();
  await handleStripeEvent(
    event("invoice.paid", {
      ...PAID_CYCLE,
      lines: { data: [{ price: { id: "price_2" } }] },
    }),
    deps,
  );
  const apply = calls.find((c) => c.fn === "applyInvoicePaid")!;
  // plan-2 is 12 credits; the stale cache says plan-1, which is 5.
  assertEquals((apply.args[0] as Record<string, unknown>).credits, 12);
  // and the cache is reconciled at the moment the money moved
  const update = calls.find((c) => c.fn === "updateClient")!;
  assertEquals((update.args[1] as Record<string, unknown>).plan_id, "plan-2");
  assertEquals(notifications(calls, "plan_changed_externally").length, 1);
});

/**
 * The fallback must survive. An invoice with no resolvable line price still
 * has to grant something, and the cached plan is the best available answer.
 */
Deno.test("H11: an invoice with no line price still grants the cached plan", async () => {
  const { deps, calls } = makeMockDeps();
  await handleStripeEvent(event("invoice.paid", PAID_CYCLE), deps);
  const apply = calls.find((c) => c.fn === "applyInvoicePaid")!;
  assertEquals((apply.args[0] as Record<string, unknown>).credits, 5);
  assertEquals(notifications(calls, "plan_changed_externally").length, 0);
});

/** A client with no cached plan at all is still resolvable from the invoice. */
Deno.test("H11: a first invoice with no cached plan resolves from the line price", async () => {
  const { deps, calls } = makeMockDeps({ clientPlanId: null });
  await handleStripeEvent(
    event("invoice.paid", {
      ...PAID_CYCLE,
      billing_reason: "subscription_create",
      lines: { data: [{ price: { id: "price_1" } }] },
    }),
    deps,
  );
  const apply = calls.find((c) => c.fn === "applyInvoicePaid")!;
  assertEquals((apply.args[0] as Record<string, unknown>).credits, 5);
});
