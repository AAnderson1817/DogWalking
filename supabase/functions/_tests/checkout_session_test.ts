import { assert, assertEquals, assertThrows } from "./asserts.ts";
import {
  assertTopupAllowed,
  MANDATE_MAX_CHARS,
  parseCheckoutRequest,
  setupSessionParams,
  subscriptionSessionParams,
  topupSessionParams,
  visitPriceMandate,
} from "../create-checkout/params.ts";
import { MAX_TOPUP_CREDITS, STRIPE_META } from "../_lib/stripe_metadata.ts";
import { HttpError } from "../_lib/http.ts";

/**
 * Review L8, extended by H32. This file used to regex create-checkout's
 * source, because index.ts had no seam — and a source regex could pin "the
 * text mentions billing_address_collection" for exactly one call. H32 gave
 * the function three session kinds, so the params moved into pure builders
 * (create-checkout/params.ts) and the same rules are now asserted on the
 * OBJECTS — for every kind, not whichever call the parser found first.
 *
 * The rule worth pinning is unchanged: collecting an address and keeping one
 * are two different options, and Stripe's default is to collect it for the
 * payment and NOT write it back to the Customer. A session with
 * `billing_address_collection` and no `customer_update.address` asks every
 * client for their address and throws it away.
 */

const COMMON = {
  customerId: "cus_1",
  clientId: "client-1",
  operatorId: "op-1",
  base: "https://app.example",
};

const SERVICES = [
  { name: "Private walk 30", visit_price_pence: 2500 },
  { name: "Private walk 60", visit_price_pence: 4000 },
];

function subscription(overage: number | null = 2200) {
  return subscriptionSessionParams({
    ...COMMON,
    planId: "plan-1",
    stripePriceId: "price_1",
    overageRatePence: overage,
  });
}

function mandateText(services = SERVICES): string {
  const m = visitPriceMandate(services);
  if (m.kind !== "ok") throw new Error(`expected a complete mandate, got ${m.kind}`);
  return m.text;
}

function topup(mandate: string | null = mandateText()) {
  return topupSessionParams({ ...COMMON, credits: 10, amountPence: 5000, mandate });
}

function setup() {
  return setupSessionParams({ ...COMMON, mandate: mandateText() });
}

Deno.test("EVERY session kind collects a billing address and persists it", () => {
  // The pair, per kind. One un-paired builder re-opens L8 for that kind only,
  // which is exactly what a single-call source regex could never see.
  for (
    const [kind, params] of [
      ["subscription", subscription()],
      ["topup", topup()],
      ["setup", setup()],
    ] as const
  ) {
    assertEquals(params.billing_address_collection, "required", `${kind} does not collect`);
    assertEquals(params.customer_update?.address, "auto", `${kind} collects and discards (L8)`);
  }
});

Deno.test("subscription params: shape, metadata on both objects, overage mandate", () => {
  const p = subscription();
  assertEquals(p.mode, "subscription");
  assertEquals(p.payment_method_collection, "always");
  assertEquals(p.line_items, [{ price: "price_1", quantity: 1 }]);
  // Metadata on the session (read by checkout.session.completed) AND the
  // subscription (read by anything inspecting the subscription later).
  const expected = { client_id: "client-1", operator_id: "op-1", plan_id: "plan-1" };
  assertEquals(p.metadata, expected);
  assertEquals(p.subscription_data, { metadata: expected });
  assert(p.custom_text?.submit.message.includes("$22.00"), "the mandate names the figure");
  assertEquals(p.success_url, "https://app.example/clients/client-1?checkout=success");
});

Deno.test("the overage mandate is omitted, not fudged, when the plan has no rate", () => {
  const p = subscription(null);
  assertEquals("custom_text" in p, false);
});

Deno.test("topup params: payment mode, ad-hoc price, credits marker, card saved", () => {
  const p = topup();
  assertEquals(p.mode, "payment");
  assertEquals(p.line_items[0].quantity, 1);
  assertEquals(p.line_items[0].price_data.unit_amount, 5000);
  assertEquals(p.line_items[0].price_data.currency, "usd");
  // The webhook reads the credit count back off the completed session; the
  // key comes from STRIPE_META because a halfway rename must be impossible,
  // not merely detectable (L23).
  assertEquals(p.metadata[STRIPE_META.topupCredits], "10");
  // One checkout makes a cash client fully chargeable: the paying card is
  // saved for off-session visit charges.
  assertEquals(p.payment_intent_data.setup_future_usage, "off_session");
  assert(p.custom_text?.submit.message.includes("$25.00"), "priced services are disclosed");
});

Deno.test("a topup with nothing priced states no per-visit promise AND saves no card", () => {
  // The setup branch refuses a card save with no stated terms; the top-up
  // must not be a bypass of its sibling's rule. Its first draft saved the
  // card anyway (adversarial review): the operator could later set a price,
  // the 0044 backfill would price the queued walks, and the card would be
  // charged off-session at a figure the client was never shown.
  const p = topup(null);
  assertEquals("custom_text" in p, false);
  assertEquals("setup_future_usage" in p.payment_intent_data, false);
});

Deno.test("a topup under a mandate saves the card for off-session visits", () => {
  const p = topup();
  assertEquals(p.payment_intent_data.setup_future_usage, "off_session");
});

Deno.test("a subscribed client cannot buy a top-up — renewals sweep the balance", () => {
  // fn_apply_rollover expires the whole balance under policy 'none' (the
  // schema default) at every renewal, so a paid top-up for a plan client is
  // money for credits the machinery is scheduled to destroy days later.
  for (const status of ["active", "paused", "past_due"]) {
    assertThrows(
      () => assertTopupAllowed({ stripe_subscription_id: "sub_1", subscription_status: status }),
      HttpError,
      undefined,
      `allowed a top-up for a ${status} subscription`,
    );
  }
  // No live cycle → nothing sweeps the balance → allowed.
  assertTopupAllowed({ stripe_subscription_id: null, subscription_status: "none" });
  assertTopupAllowed({ stripe_subscription_id: "sub_old", subscription_status: "cancelled" });
});

Deno.test("setup params: setup mode, and the mandate is not optional", () => {
  const p = setup();
  assertEquals(p.mode, "setup");
  const message = p.custom_text.submit.message;
  assert(message.includes("Private walk 30 $25.00"), "each priced service, with its figure");
  assert(message.includes("Private walk 60 $40.00"));
});

Deno.test("visitPriceMandate names EVERY priced service — or says it cannot", () => {
  assertEquals(visitPriceMandate([]), { kind: "none" });
  // Every service, every figure. The first draft capped the list at six and
  // said "and N more" — but an omitted service still charges off-session
  // through its snapshot, so the client would have authorised a card without
  // seeing a figure that can hit it (Codex finding on #76).
  const many = Array.from({ length: 9 }, (_, i) => ({
    name: `Service ${i}`,
    visit_price_pence: 1000 + i,
  }));
  const m = visitPriceMandate(many);
  assert(m.kind === "ok");
  for (const svc of many) {
    assert(m.text.includes(svc.name), `${svc.name} missing from the mandate`);
    assert(m.text.includes((svc.visit_price_pence / 100).toFixed(2)), `${svc.name}'s figure missing`);
  }
  assert(m.text.length <= MANDATE_MAX_CHARS);
  // Too many to disclose completely → tooLong, never a truncated disclosure.
  const tooMany = Array.from({ length: 40 }, (_, i) => ({
    name: `A very descriptive service name number ${i}`,
    visit_price_pence: 1000 + i,
  }));
  assertEquals(visitPriceMandate(tooMany), { kind: "tooLong" });
});

Deno.test("parseCheckoutRequest: exactly one kind, and money fields are validated", () => {
  assertEquals(parseCheckoutRequest({ client_id: "c", plan_id: "p" }).kind, "subscription");
  assertEquals(
    parseCheckoutRequest({ client_id: "c", topup: { credits: 3, amount_pence: 900 } }).kind,
    "topup",
  );
  assertEquals(parseCheckoutRequest({ client_id: "c", setup: true }).kind, "setup");

  const bad: unknown[] = [
    {}, // no client
    { client_id: "c" }, // no kind
    { client_id: "c", plan_id: "p", setup: true }, // two kinds
    { client_id: "c", plan_id: "p", topup: { credits: 1, amount_pence: 1 } },
    { client_id: "c", topup: { credits: 0, amount_pence: 900 } },
    { client_id: "c", topup: { credits: 2.5, amount_pence: 900 } },
    { client_id: "c", topup: { credits: "3", amount_pence: 900 } },
    { client_id: "c", topup: { credits: 3, amount_pence: 0 } },
    { client_id: "c", topup: { credits: 3, amount_pence: -100 } },
    // Past the bound, fn_apply_topup's int parameter cannot encode the value:
    // Checkout would collect the money and every grant retry would fail.
    { client_id: "c", topup: { credits: MAX_TOPUP_CREDITS + 1, amount_pence: 900 } },
    { client_id: "c", topup: { credits: 2 ** 31, amount_pence: 900 } },
  ];
  for (const body of bad) {
    assertThrows(
      () => parseCheckoutRequest(body),
      HttpError,
      undefined,
      `accepted: ${JSON.stringify(body)}`,
    );
  }
});

// ── The wiring half: the builders must be what actually reaches Stripe ─────
// Object tests on builders nobody calls would pass forever. index.ts must
// have exactly ONE sessions.create, fed by the builders, with the account as
// its options — a second literal call would be a session these tests never
// see, which is the failure mode the old source-regex suite had.
const SRC = await Deno.readTextFile(
  new URL("../create-checkout/index.ts", import.meta.url),
);

Deno.test("index.ts sends exactly one session, built by the builders, on the account", () => {
  const calls = SRC.match(/checkout\.sessions\.create\(/g) ?? [];
  assertEquals(calls.length, 1, "every session kind must flow through the one call");
  assert(
    /checkout\.sessions\.create\(params,\s*account\)/.test(SRC),
    "the call must send the built params and carry the connected account",
  );
  for (const builder of ["subscriptionSessionParams", "topupSessionParams", "setupSessionParams"]) {
    assert(SRC.includes(builder + "("), `${builder} is never called from index.ts`);
  }
});
