// overage_deps: every Stripe call must be routed to the connected account.
//
// There was no coverage of this file at all — the overage suite injects pure
// OverageDeps mocks (vault_test.ts), so it exercises the decision logic and
// never the wiring. That is exactly the gap that let `customers.retrieve` ship
// unrouted while the `paymentMethods.list` four lines below it was routed.
//
// The assertion is deliberately "EVERY call carries a stripeAccount" rather
// than "this specific call does". A per-call test would have to be remembered
// and extended for each new Stripe call; this one fails automatically for any
// call anybody adds without routing it.
import { assert, assertEquals } from "./asserts.ts";
import { makeOverageDeps } from "../_lib/overage_deps.ts";

const ACCOUNT = { stripeAccount: "acct_connected" };

interface Recorded {
  call: string;
  options: unknown;
}

/**
 * A Stripe double that records the LAST argument of every call. The Stripe
 * SDK takes per-request options as the final parameter, so that argument is
 * where `stripeAccount` has to appear.
 */
function makeStripeDouble(recorded: Recorded[]) {
  const record = (call: string) => (...args: unknown[]) => {
    recorded.push({ call, options: args[args.length - 1] });
    if (call === "customers.retrieve") {
      return Promise.resolve({
        invoice_settings: { default_payment_method: "pm_default" },
      });
    }
    if (call === "paymentMethods.list") {
      return Promise.resolve({ data: [{ id: "pm_first" }] });
    }
    if (call === "paymentIntents.create") {
      return Promise.resolve({ id: "pi_1", status: "succeeded", latest_charge: null });
    }
    return Promise.resolve({ status: "succeeded", latest_charge: null });
  };
  return {
    customers: { retrieve: record("customers.retrieve") },
    paymentMethods: { list: record("paymentMethods.list") },
    paymentIntents: {
      create: record("paymentIntents.create"),
      retrieve: record("paymentIntents.retrieve"),
    },
  };
}

/** The db is untouched by the Stripe-facing methods; blow up if that changes. */
const db = new Proxy({}, {
  get() {
    throw new Error("the database must not be reached by a Stripe-only path");
  },
}) as never;

function subject(recorded: Recorded[]) {
  // deno-lint-ignore no-explicit-any
  return makeOverageDeps(db, makeStripeDouble(recorded) as any, () => ACCOUNT);
}

function accountOf(o: unknown): string | undefined {
  return (o as { stripeAccount?: string } | null)?.stripeAccount;
}

Deno.test("createOffSessionPaymentIntent routes EVERY Stripe call to the connected account", async () => {
  const recorded: Recorded[] = [];
  await subject(recorded).createOffSessionPaymentIntent({
    customerId: "cus_1",
    amountPence: 2200,
    walkId: "walk-1",
    clientId: "client-1",
    attemptKey: "key-1",
    pricing: "plan_rate",
  });

  assert(recorded.length > 0, "expected Stripe calls");
  const unrouted = recorded.filter((r) => accountOf(r.options) !== ACCOUNT.stripeAccount);
  assertEquals(
    unrouted.map((r) => r.call),
    [],
    "these Stripe calls reached the PLATFORM account: " + unrouted.map((r) => r.call).join(", "),
  );
});

Deno.test("the customer lookup specifically is on the connected account", async () => {
  // Named separately because this is the one that shipped wrong, and because
  // the consequence is not a visible error: the customer is created on the
  // connected account (create-checkout), so a platform lookup raises
  // resource_missing — which isCardError does not match, so it rethrows,
  // complete-walk 500s, and the pending claim it already inserted makes the
  // operator's retry return already_charged for a payment never taken.
  const recorded: Recorded[] = [];
  await subject(recorded).createOffSessionPaymentIntent({
    customerId: "cus_1",
    amountPence: 2200,
    walkId: "walk-1",
    clientId: "client-1",
    attemptKey: "key-1",
    pricing: "plan_rate",
  });
  const lookup = recorded.find((r) => r.call === "customers.retrieve");
  assert(lookup, "customers.retrieve was not called");
  assertEquals(accountOf(lookup.options), ACCOUNT.stripeAccount);
});

Deno.test("the card fallback is routed too", async () => {
  const recorded: Recorded[] = [];
  const stripe = makeStripeDouble(recorded);
  // No default payment method → falls through to paymentMethods.list.
  stripe.customers.retrieve = ((...args: unknown[]) => {
    recorded.push({ call: "customers.retrieve", options: args[args.length - 1] });
    return Promise.resolve({ invoice_settings: {} });
    // deno-lint-ignore no-explicit-any
  }) as any;
  // deno-lint-ignore no-explicit-any
  const deps = makeOverageDeps(db, stripe as any, () => ACCOUNT);
  await deps.createOffSessionPaymentIntent({
    customerId: "cus_1",
    amountPence: 2200,
    walkId: "walk-1",
    clientId: "client-1",
    attemptKey: "key-1",
    pricing: "plan_rate",
  });
  const list = recorded.find((r) => r.call === "paymentMethods.list");
  assert(list, "paymentMethods.list was not called");
  assertEquals(accountOf(list.options), ACCOUNT.stripeAccount);
});

Deno.test("retrievePaymentIntent is routed — reconciling a claim reads the connected account", async () => {
  const recorded: Recorded[] = [];
  await subject(recorded).retrievePaymentIntent("pi_1");
  const r = recorded.find((x) => x.call === "paymentIntents.retrieve");
  assert(r, "paymentIntents.retrieve was not called");
  assertEquals(accountOf(r.options), ACCOUNT.stripeAccount);
});

Deno.test("the idempotency key survives being merged with the account", async () => {
  // The key is per-ATTEMPT and Stripe scopes keys per account, so it has to
  // travel in the SAME options object as stripeAccount rather than replace it.
  const recorded: Recorded[] = [];
  await subject(recorded).createOffSessionPaymentIntent({
    customerId: "cus_1",
    amountPence: 2200,
    walkId: "walk-1",
    clientId: "client-1",
    attemptKey: "attempt-abc",
    pricing: "plan_rate",
  });
  const create = recorded.find((r) => r.call === "paymentIntents.create");
  const opts = create!.options as { idempotencyKey?: string; stripeAccount?: string };
  assertEquals(opts.idempotencyKey, "attempt-abc");
  assertEquals(opts.stripeAccount, ACCOUNT.stripeAccount);
});

Deno.test("the PI description follows the pricing kind", async () => {
  // "Overage" on a pay-per-visit client's statement would name a plan they
  // are not on; "per-visit" on a plan client's would deny the plan they are.
  for (
    const [pricing, expected] of [
      ["visit_price", "Sanpo walk (per-visit)"],
      ["plan_rate", "Sanpo walk (overage)"],
    ] as const
  ) {
    const recorded: Recorded[] = [];
    const stripe = makeStripeDouble(recorded);
    let description: string | undefined;
    const orig = stripe.paymentIntents.create;
    stripe.paymentIntents.create = ((...args: unknown[]) => {
      description = (args[0] as { description?: string }).description;
      return orig(...args);
      // deno-lint-ignore no-explicit-any
    }) as any;
    // deno-lint-ignore no-explicit-any
    const deps = makeOverageDeps(db, stripe as any, () => ACCOUNT);
    await deps.createOffSessionPaymentIntent({
      customerId: "cus_1",
      amountPence: 2500,
      walkId: "walk-1",
      clientId: "client-1",
      attemptKey: "key-1",
      pricing,
    });
    assertEquals(description, expected);
  }
});
