// operator-billing: the operator's own $49/month subscription, on the
// PLATFORM account (review H31). The headline assertion is the inverse of
// overage_deps_test's: EVERY Stripe call must carry NO stripeAccount, and it
// is asserted over every recorded argument of every call so any call added
// later is covered without anyone remembering to extend a list.
import { assert, assertEquals, assertRejects } from "./asserts.ts";
import { HttpError } from "../_lib/http.ts";
import {
  handleOperatorBilling,
  type OperatorBillingDeps,
  type OperatorBillingRow,
  type PlatformStripe,
} from "../operator-billing/handler.ts";
import {
  OPERATOR_PRICE_LOOKUP_KEY,
  OPERATOR_PRICE_PENCE,
  operatorPriceParams,
  TRIAL_FLOOR_MARGIN_MS,
  TRIAL_MIN_REMAINING_MS,
  trialEndSeconds,
} from "../operator-billing/params.ts";

const OP_ID = "00000000-0000-4000-a000-0000000000aa";
const NOW = Date.parse("2026-08-30T12:00:00Z");

interface Recorded {
  call: string;
  args: unknown[];
}

function operatorRow(over: Partial<OperatorBillingRow> = {}): OperatorBillingRow {
  return {
    id: OP_ID,
    email: "op@sanpo.test",
    business_name: "Pine & Paws",
    trial_ends_at: new Date(NOW + 10 * 24 * 3600_000).toISOString(),
    platform_customer_id: null,
    platform_subscription_id: null,
    platform_subscription_status: "none",
    ...over,
  };
}

function makeStripeDouble(
  recorded: Recorded[],
  opts: {
    priceListed?: boolean;
    priceCreateFails?: boolean;
    liveSubscriptions?: Array<{ id: string; status: string }>;
    openSessions?: Array<{ id: string }>;
  } = {},
): PlatformStripe {
  const priceListed = opts.priceListed ?? true;
  let listCalls = 0;
  return {
    customers: {
      create(params) {
        recorded.push({ call: "customers.create", args: [params] });
        return Promise.resolve({ id: "cus_fresh" });
      },
    },
    subscriptions: {
      list(params) {
        recorded.push({ call: "subscriptions.list", args: [params] });
        return Promise.resolve({ data: opts.liveSubscriptions ?? [] });
      },
    },
    prices: {
      list(params) {
        recorded.push({ call: "prices.list", args: [params] });
        listCalls += 1;
        // When the create fails (race), the RE-list finds the winner's price.
        const found = priceListed || (opts.priceCreateFails && listCalls > 1);
        return Promise.resolve({ data: found ? [{ id: "price_49" }] : [] });
      },
      create(params, o) {
        recorded.push({ call: "prices.create", args: [params, o] });
        if (opts.priceCreateFails) {
          return Promise.reject(new Error("lookup_key already exists"));
        }
        return Promise.resolve({ id: "price_created" });
      },
    },
    checkout: {
      sessions: {
        create(params) {
          recorded.push({ call: "checkout.sessions.create", args: [params] });
          return Promise.resolve({ id: "cs_1", url: "https://checkout.stripe.com/x" });
        },
        list(params) {
          recorded.push({ call: "checkout.sessions.list", args: [params] });
          return Promise.resolve({ data: opts.openSessions ?? [] });
        },
        expire(id) {
          recorded.push({ call: "checkout.sessions.expire", args: [id] });
          return Promise.resolve({ id });
        },
      },
    },
    billingPortal: {
      sessions: {
        create(params) {
          recorded.push({ call: "billingPortal.sessions.create", args: [params] });
          return Promise.resolve({ url: "https://billing.stripe.com/x" });
        },
      },
    },
  };
}

function makeDeps(
  row: OperatorBillingRow | null,
  recorded: Recorded[],
  opts: {
    priceListed?: boolean;
    priceCreateFails?: boolean;
    claimWinner?: string;
    liveSubscriptions?: Array<{ id: string; status: string }>;
    openSessions?: Array<{ id: string }>;
  } = {},
): OperatorBillingDeps & { claims: string[] } {
  const claims: string[] = [];
  return {
    claims,
    getOperator: () => Promise.resolve(row),
    claimCustomerId(_operatorId, customerId) {
      claims.push(customerId);
      recorded.push({ call: "db.claimCustomerId", args: [customerId] });
      return Promise.resolve(opts.claimWinner ?? customerId);
    },
    stripe: makeStripeDouble(recorded, opts),
    base: "https://app.sanpo.test",
    now: () => NOW,
  };
}

function assertNothingRoutedToAnAccount(recorded: Recorded[]): void {
  for (const { call, args } of recorded) {
    for (const arg of args) {
      if (arg && typeof arg === "object") {
        assert(
          !("stripeAccount" in (arg as Record<string, unknown>)),
          `${call} carried stripeAccount — platform money routed to a connected account`,
        );
      }
    }
  }
}

Deno.test("checkout: no Stripe call carries stripeAccount", async () => {
  const recorded: Recorded[] = [];
  const deps = makeDeps(operatorRow(), recorded, { priceListed: false });
  await handleOperatorBilling(OP_ID, { action: "checkout" }, deps);
  assert(recorded.length >= 3, "expected the full checkout call sequence");
  assertNothingRoutedToAnAccount(recorded);
});

Deno.test("portal: no Stripe call carries stripeAccount", async () => {
  const recorded: Recorded[] = [];
  const deps = makeDeps(operatorRow({ platform_customer_id: "cus_1" }), recorded);
  await handleOperatorBilling(OP_ID, { action: "portal" }, deps);
  assertNothingRoutedToAnAccount(recorded);
});

Deno.test("the customer is persisted BEFORE the session is minted, and the loser adopts the winner", async () => {
  const recorded: Recorded[] = [];
  const deps = makeDeps(operatorRow(), recorded, { claimWinner: "cus_winner" });
  await handleOperatorBilling(OP_ID, { action: "checkout" }, deps);

  const order = recorded.map((r) => r.call);
  const created = order.indexOf("customers.create");
  const claimed = order.indexOf("db.claimCustomerId");
  const session = order.indexOf("checkout.sessions.create");
  assert(created !== -1 && claimed !== -1 && session !== -1, `calls: ${order.join(", ")}`);
  assert(created < claimed && claimed < session, `wrong order: ${order.join(", ")}`);

  // The conditional claim returned a different id — a concurrent start won —
  // and the session must be minted for THAT customer.
  const params = recorded[session].args[0] as { customer: string };
  assertEquals(params.customer, "cus_winner");
});

Deno.test("an existing platform customer is reused, not recreated", async () => {
  const recorded: Recorded[] = [];
  const deps = makeDeps(operatorRow({ platform_customer_id: "cus_have" }), recorded);
  await handleOperatorBilling(OP_ID, { action: "checkout" }, deps);
  assert(
    !recorded.some((r) => r.call === "customers.create"),
    "created a second Stripe customer for an operator who has one",
  );
  const session = recorded.find((r) => r.call === "checkout.sessions.create");
  assertEquals((session?.args[0] as { customer: string }).customer, "cus_have");
});

Deno.test("remaining trial above Stripe's 48h floor is passed through; below it, omitted", async () => {
  // 10 days left: the days already promised survive subscribing early.
  const recorded: Recorded[] = [];
  const tenDays = new Date(NOW + 10 * 24 * 3600_000).toISOString();
  await handleOperatorBilling(OP_ID, { action: "checkout" }, makeDeps(
    operatorRow({ trial_ends_at: tenDays }),
    recorded,
  ));
  let params = recorded.find((r) => r.call === "checkout.sessions.create")!
    .args[0] as { subscription_data: { trial_end?: number } };
  assertEquals(params.subscription_data.trial_end, Math.floor(Date.parse(tenDays) / 1000));

  // 1 day left: Stripe refuses trial_end under 48h out, so the field must be
  // omitted — otherwise the subscribe button 500s for exactly the operators
  // most likely to press it.
  recorded.length = 0;
  await handleOperatorBilling(OP_ID, { action: "checkout" }, makeDeps(
    operatorRow({ trial_ends_at: new Date(NOW + 24 * 3600_000).toISOString() }),
    recorded,
  ));
  params = recorded.find((r) => r.call === "checkout.sessions.create")!
    .args[0] as { subscription_data: { trial_end?: number } };
  assert(!("trial_end" in params.subscription_data), "trial_end under the 48h floor was sent");

  // No trial recorded at all.
  recorded.length = 0;
  await handleOperatorBilling(OP_ID, { action: "checkout" }, makeDeps(
    operatorRow({ trial_ends_at: null }),
    recorded,
  ));
  params = recorded.find((r) => r.call === "checkout.sessions.create")!
    .args[0] as { subscription_data: { trial_end?: number } };
  assert(!("trial_end" in params.subscription_data));
});

Deno.test("trialEndSeconds: the floor carries a margin — exactly 48h is already too late", () => {
  // A trial_end minted at exactly Stripe's 48h floor is UNDER it by the
  // time the request lands (transit latency, clock skew), and Stripe then
  // rejects the whole session — the Subscribe button failing for exactly
  // the operators closest to needing it (adversarial review).
  const atFloor = new Date(NOW + TRIAL_MIN_REMAINING_MS).toISOString();
  assertEquals(trialEndSeconds(atFloor, NOW), null);
  const justUnderMargin = new Date(NOW + TRIAL_MIN_REMAINING_MS + TRIAL_FLOOR_MARGIN_MS - 1000)
    .toISOString();
  assertEquals(trialEndSeconds(justUnderMargin, NOW), null);
  const clear = new Date(NOW + TRIAL_MIN_REMAINING_MS + TRIAL_FLOOR_MARGIN_MS).toISOString();
  assertEquals(trialEndSeconds(clear, NOW), Math.floor(Date.parse(clear) / 1000));
  assertEquals(trialEndSeconds("not a date", NOW), null);
  assertEquals(trialEndSeconds(null, NOW), null);
});

Deno.test("a live subscription refuses a second checkout; a cancelled one may start over", async () => {
  for (const status of ["active", "past_due", "paused", "none"]) {
    const recorded: Recorded[] = [];
    const deps = makeDeps(
      operatorRow({ platform_subscription_id: "sub_1", platform_subscription_status: status }),
      recorded,
    );
    const err = await assertRejects(() =>
      handleOperatorBilling(OP_ID, { action: "checkout" }, deps)
    );
    assert(err instanceof HttpError && err.status === 409, `status ${status}: ${String(err)}`);
    assertEquals((err as HttpError).code, "already_subscribed");
    assertEquals(recorded.length, 0, `status ${status} reached Stripe`);
  }

  const recorded: Recorded[] = [];
  const deps = makeDeps(
    operatorRow({ platform_subscription_id: "sub_old", platform_subscription_status: "cancelled" }),
    recorded,
  );
  const res = await handleOperatorBilling(OP_ID, { action: "checkout" }, deps);
  assert(res.url, "a cancelled operator could not re-subscribe");
});

Deno.test("the price is resolved by lookup key: found → reused, missing → created, race → re-listed", async () => {
  // Found: no create.
  let recorded: Recorded[] = [];
  await handleOperatorBilling(OP_ID, { action: "checkout" }, makeDeps(operatorRow(), recorded));
  assert(!recorded.some((r) => r.call === "prices.create"), "created a price that already exists");

  // Missing: created with the lookup key and an idempotency key.
  recorded = [];
  await handleOperatorBilling(OP_ID, { action: "checkout" }, makeDeps(operatorRow(), recorded, {
    priceListed: false,
  }));
  const create = recorded.find((r) => r.call === "prices.create");
  assert(create, "price was never created");
  const [params, o] = create.args as [Record<string, unknown>, Record<string, unknown>];
  assertEquals(params.lookup_key, OPERATOR_PRICE_LOOKUP_KEY);
  assertEquals(params.unit_amount, OPERATOR_PRICE_PENCE);
  assert(typeof o?.idempotencyKey === "string" && o.idempotencyKey.length > 0);

  // Race: the create fails because a concurrent call won; re-list and adopt.
  recorded = [];
  const res = await handleOperatorBilling(
    OP_ID,
    { action: "checkout" },
    makeDeps(operatorRow(), recorded, { priceListed: false, priceCreateFails: true }),
  );
  assert(res.url, "the race loser did not recover the winner's price");
  const session = recorded.find((r) => r.call === "checkout.sessions.create");
  const line = (session?.args[0] as { line_items: Array<{ price: string }> }).line_items[0];
  assertEquals(line.price, "price_49");
});

Deno.test("the $49 figure and its lookup key agree", () => {
  const p = operatorPriceParams();
  assertEquals(p.unit_amount, 4900);
  assertEquals(p.recurring.interval, "month");
  assertEquals(p.currency, "usd");
  // The amount lives in the key so a price change mints a NEW key instead of
  // quietly repointing the old one.
  assert(OPERATOR_PRICE_LOOKUP_KEY.includes(String(OPERATOR_PRICE_PENCE)));
});

Deno.test("checkout session shape: metadata on session AND subscription, address collected and stuck", async () => {
  const recorded: Recorded[] = [];
  await handleOperatorBilling(OP_ID, { action: "checkout" }, makeDeps(operatorRow(), recorded));
  const params = recorded.find((r) => r.call === "checkout.sessions.create")!.args[0] as {
    mode: string;
    metadata: Record<string, string>;
    subscription_data: { metadata: Record<string, string> };
    billing_address_collection: string;
    customer_update: { address: string };
    payment_method_collection: string;
    success_url: string;
    cancel_url: string;
  };
  assertEquals(params.mode, "subscription");
  assertEquals(params.metadata.operator_id, OP_ID);
  assertEquals(params.subscription_data.metadata.operator_id, OP_ID);
  assertEquals(params.billing_address_collection, "required");
  assertEquals(params.customer_update.address, "auto");
  assertEquals(params.payment_method_collection, "always");
  assert(params.success_url.startsWith("https://app.sanpo.test/settings"));
  assert(params.cancel_url.startsWith("https://app.sanpo.test/settings"));
});

Deno.test("portal without billing is a 409; with billing it returns the portal url", async () => {
  const err = await assertRejects(() =>
    handleOperatorBilling(OP_ID, { action: "portal" }, makeDeps(operatorRow(), []))
  );
  assert(err instanceof HttpError && err.status === 409);
  assertEquals((err as HttpError).code, "no_billing");

  const recorded: Recorded[] = [];
  const res = await handleOperatorBilling(
    OP_ID,
    { action: "portal" },
    makeDeps(operatorRow({ platform_customer_id: "cus_1" }), recorded),
  );
  assertEquals(res.url, "https://billing.stripe.com/x");
  const call = recorded.find((r) => r.call === "billingPortal.sessions.create");
  assertEquals((call?.args[0] as { customer: string }).customer, "cus_1");
});

Deno.test("unknown action and missing operator are refused", async () => {
  const err = await assertRejects(() =>
    handleOperatorBilling(OP_ID, { action: "steal" as never }, makeDeps(operatorRow(), []))
  );
  assert(err instanceof HttpError && err.status === 400);

  const gone = await assertRejects(() =>
    handleOperatorBilling(OP_ID, { action: "checkout" }, makeDeps(null, []))
  );
  assert(gone instanceof HttpError && gone.status === 403);
});

// ── Stripe is the truth at mint time (adversarial review: pay-twice) ──────

Deno.test("a live subscription at STRIPE refuses checkout even when the DB row says none", async () => {
  // The binding webhook can be behind or (owner-actions §1a) failing, and
  // during that window Subscribe is still on screen after a successful
  // payment. Asking Stripe directly is what stops the second $49/month.
  const recorded: Recorded[] = [];
  const deps = makeDeps(
    operatorRow({ platform_customer_id: "cus_have" }),
    recorded,
    { liveSubscriptions: [{ id: "sub_paid", status: "active" }] },
  );
  const err = await assertRejects(() =>
    handleOperatorBilling(OP_ID, { action: "checkout" }, deps)
  );
  assert(err instanceof HttpError && err.status === 409, `got ${String(err)}`);
  assertEquals((err as HttpError).code, "already_subscribed");
  assert(
    !recorded.some((r) => r.call === "checkout.sessions.create"),
    "a session was minted for an already-subscribed customer",
  );
});

Deno.test("only truly dead Stripe subscriptions let a checkout proceed", async () => {
  const recorded: Recorded[] = [];
  const deps = makeDeps(
    operatorRow({ platform_customer_id: "cus_have" }),
    recorded,
    {
      liveSubscriptions: [
        { id: "sub_old", status: "canceled" },
        { id: "sub_never", status: "incomplete_expired" },
      ],
    },
  );
  const res = await handleOperatorBilling(OP_ID, { action: "checkout" }, deps);
  assert(res.url, "cancelled history blocked an honest re-subscribe");
});

Deno.test("stale OPEN sessions are expired before a new one is minted — one completable checkout at a time", async () => {
  // Sessions stay completable for 24h: back-out-and-click-again must not
  // leave two sessions that can BOTH complete into two subscriptions.
  const recorded: Recorded[] = [];
  const deps = makeDeps(
    operatorRow({ platform_customer_id: "cus_have" }),
    recorded,
    { openSessions: [{ id: "cs_stale1" }, { id: "cs_stale2" }] },
  );
  await handleOperatorBilling(OP_ID, { action: "checkout" }, deps);
  const order = recorded.map((r) => r.call);
  const expires = recorded.filter((r) => r.call === "checkout.sessions.expire").map((r) => r.args[0]);
  assertEquals(expires, ["cs_stale1", "cs_stale2"]);
  assert(
    order.lastIndexOf("checkout.sessions.expire") < order.indexOf("checkout.sessions.create"),
    "the new session was minted before the stale ones were expired",
  );
});

Deno.test("a FRESH customer skips the Stripe-truth checks — it can hold nothing yet", async () => {
  const recorded: Recorded[] = [];
  const deps = makeDeps(operatorRow(), recorded); // no platform_customer_id
  await handleOperatorBilling(OP_ID, { action: "checkout" }, deps);
  assert(!recorded.some((r) => r.call === "subscriptions.list"));
  assert(!recorded.some((r) => r.call === "checkout.sessions.list"));
});
