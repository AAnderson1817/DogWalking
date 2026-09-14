// billing-portal: `accountOf`, NOT `requireAccount` (spec 04). This path does
// not take money, so a client whose walker Stripe is still reviewing must
// still be able to update a card or cancel — refusing there strands them
// with a subscription they cannot stop. Until the seam that rule was carried
// by a comment beside the call; here it is asserted on a deps recorder, with
// every refusal pinned to land before the first Stripe call and every Stripe
// call pinned to the CONNECTED account (review B5).
import { assert, assertEquals, assertRejects } from "./asserts.ts";
import { HttpError } from "../_lib/http.ts";
import {
  type BillingPortalDeps,
  handleBillingPortal,
  type PortalClientRow,
} from "../billing-portal/handler.ts";

const USER = { id: "00000000-0000-4000-a000-0000000000cc" };
const BASE = "https://app.sanpo.test";

interface Recorded {
  call: string;
  args: unknown[];
}

function clientRow(over: Partial<PortalClientRow> = {}): PortalClientRow {
  return {
    id: "00000000-0000-4000-a000-0000000000c1",
    stripe_customer_id: "cus_client",
    operator: { stripe_account_id: "acct_connected", stripe_charges_enabled: true },
    ...over,
  };
}

function makeDeps(
  row: PortalClientRow | null,
  recorded: Recorded[],
  opts: { lookupFails?: HttpError; sessionFails?: Error } = {},
): BillingPortalDeps {
  return {
    getClientForUser(authUserId) {
      if (opts.lookupFails) return Promise.reject(opts.lookupFails);
      assertEquals(authUserId, USER.id, "looked up a different user than the caller");
      return Promise.resolve(row);
    },
    createPortalSession(params, o) {
      recorded.push({ call: "billingPortal.sessions.create", args: [params, o] });
      if (opts.sessionFails) return Promise.reject(opts.sessionFails);
      return Promise.resolve({ url: "https://billing.stripe.com/session" });
    },
    base: BASE,
  };
}

async function refused(
  row: PortalClientRow | null,
  opts: { lookupFails?: HttpError } = {},
): Promise<{ err: HttpError; recorded: Recorded[] }> {
  const recorded: Recorded[] = [];
  const err = await assertRejects(() => handleBillingPortal(USER, makeDeps(row, recorded, opts)));
  assert(err instanceof HttpError, `expected HttpError, got ${err.constructor.name}: ${err.message}`);
  return { err, recorded };
}

Deno.test("a caller who is not a client is refused 403 before any Stripe call", async () => {
  const { err, recorded } = await refused(null);
  assertEquals(err.status, 403);
  assertEquals(err.code, "not_client");
  assertEquals(recorded, []);
});

Deno.test("a client with no Stripe customer is refused 409 no_billing before any Stripe call", async () => {
  const { err, recorded } = await refused(clientRow({ stripe_customer_id: null }));
  assertEquals(err.status, 409);
  assertEquals(err.code, "no_billing");
  assertEquals(recorded, []);
});

Deno.test("a client whose walker has no connected account is refused 409 stripe_not_connected", async () => {
  const { err, recorded } = await refused(clientRow({
    operator: { stripe_account_id: null, stripe_charges_enabled: true },
  }));
  assertEquals(err.status, 409);
  assertEquals(err.code, "stripe_not_connected");
  assertEquals(recorded, []);
});

Deno.test("accountOf, not requireAccount: charges disabled on the walker still yields a session", async () => {
  // The headline. A client updating a card or cancelling must not be blocked
  // because Stripe has charges paused on their walker — that would strand
  // them with a subscription they cannot stop (spec 04).
  const recorded: Recorded[] = [];
  const row = clientRow({ operator: { stripe_account_id: "acct_connected", stripe_charges_enabled: false } });
  const res = await handleBillingPortal(USER, makeDeps(row, recorded));
  assertEquals(res, { url: "https://billing.stripe.com/session" });
  assertEquals(recorded.map((r) => r.call), ["billingPortal.sessions.create"]);
});

Deno.test("every billingPortal call carries the CONNECTED account", async () => {
  const recorded: Recorded[] = [];
  await handleBillingPortal(USER, makeDeps(clientRow(), recorded));
  assert(recorded.length > 0, "no Stripe call was recorded");
  // Asserted over every recorded call rather than the one that exists today
  // (the overage_deps rule), so a call added later is covered on its own.
  for (const r of recorded.filter((r) => r.call.startsWith("billingPortal."))) {
    const opts = r.args[r.args.length - 1] as Record<string, unknown>;
    assertEquals(
      opts?.stripeAccount,
      "acct_connected",
      `${r.call} did not carry the connected account: ${JSON.stringify(opts)}`,
    );
  }
});

Deno.test("the session is minted for the row's customer, returning to the portal billing screen", async () => {
  const recorded: Recorded[] = [];
  await handleBillingPortal(USER, makeDeps(clientRow({ stripe_customer_id: "cus_theirs" }), recorded));
  const params = recorded[0].args[0] as { customer: string; return_url: string };
  assertEquals(params.customer, "cus_theirs");
  assertEquals(params.return_url, `${BASE}/portal/billing`);
});

Deno.test("a failed client lookup propagates as the 500 it is, not as an absence, and reaches no Stripe call", async () => {
  const { err, recorded } = await refused(
    clientRow(),
    { lookupFails: new HttpError(500, "db_error", "client lookup failed", new Error("connection reset")) },
  );
  assertEquals(err.status, 500);
  assertEquals(err.code, "db_error");
  // Un-wrapped: the sentence the wiring chose is the one the client reads.
  assertEquals(err.message, "client lookup failed");
  assertEquals(recorded, []);
});

Deno.test("a Stripe failure propagates un-wrapped (handleRequest maps it to 500 internal)", async () => {
  // Pins current behaviour rather than a rule: the handler does not
  // translate SDK errors, so the shared wrapper's catch is what the client
  // sees. A wrapped-and-relabelled error here would be a change to record.
  const recorded: Recorded[] = [];
  const boom = new Error("stripe: customer is on another account");
  const err = await assertRejects(() =>
    handleBillingPortal(USER, makeDeps(clientRow(), recorded, { sessionFails: boom }))
  );
  assert(!(err instanceof HttpError), `expected the raw Error, got HttpError ${err.message}`);
  // Identity, not assertEquals: that helper compares JSON.stringify, and an
  // Error's own enumerable keys are `{}`, so ANY two Errors would "match".
  assert(err === boom, `expected the very Error the dep threw, got ${err.message}`);
  assertEquals(recorded.map((r) => r.call), ["billingPortal.sessions.create"]);
});
