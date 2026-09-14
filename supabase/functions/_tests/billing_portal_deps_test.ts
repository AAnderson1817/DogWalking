// billing-portal's WIRING, driven: `makeBillingPortalDeps` against a scripted
// PostgREST double and a recording Stripe double.
//
// `billing_portal_test.ts` injects a hand-built `BillingPortalDeps` and so
// pins the DECISIONS; what it structurally cannot see is what the real wiring
// does — the `.select` string and its filter on the caller, the many-to-one
// embed handed through as one object, a failed lookup becoming a throw rather
// than an absence, the Stripe client resolved AFTER the refusals, and the
// per-request options forwarded to the real `create` call. Drop `opts` from
// that call and every portal session lands on the platform account, where the
// customer does not exist (review B5) — with the handler suite green.
import { assert, assertEquals } from "./asserts.ts";
import { HttpError } from "../_lib/http.ts";
import { makeBillingPortalDeps, type PortalStripe } from "../billing-portal/deps.ts";
import { handleBillingPortal } from "../billing-portal/handler.ts";
import { PG_ERROR, rejection, type Result, scriptedDb } from "./scripted_db.ts";

const USER = { id: "00000000-0000-4000-a000-0000000000cc" };
const BASE = "https://app.sanpo.test";
/** The columns the wiring asks for, as shipped — the embed names the FK so
 * PostgREST resolves the one operator, and CLIENT_COLUMNS' withheld set is
 * not touched. */
const CLIENT_SELECT =
  "id, stripe_customer_id, operator:operators!clients_operator_id_fkey(stripe_account_id, stripe_charges_enabled)";

/** A clients row as PostgREST returns it: the embed is ONE object. */
const CLIENT_ROW = {
  id: "00000000-0000-4000-a000-0000000000c1",
  stripe_customer_id: "cus_client",
  operator: { stripe_account_id: "acct_connected", stripe_charges_enabled: true },
};

interface Recorded {
  call: string;
  args: unknown[];
}

function depsOver(results: Record<string, Result | Result[]>, opts: { stripeUnavailable?: boolean } = {}) {
  const recorded: Recorded[] = [];
  let resolved = 0;
  const stripe = (): PortalStripe => {
    resolved += 1;
    if (opts.stripeUnavailable) throw new Error("STRIPE_SECRET_KEY is not configured");
    return {
      billingPortal: {
        sessions: {
          create(params, o) {
            recorded.push({ call: "billingPortal.sessions.create", args: [params, o] });
            return Promise.resolve({ url: "https://billing.stripe.com/session" });
          },
        },
      },
    };
  };
  const { db, queries } = scriptedDb(results);
  const deps = makeBillingPortalDeps({ db: db as never, stripe, base: BASE });
  return { deps, queries, recorded, stripeResolved: () => resolved };
}

// ── getClientForUser ───────────────────────────────────────────────────────

Deno.test("getClientForUser: asks clients for the shipped columns, filtered on the CALLER, and hands the embed through as one object", async () => {
  const { deps, queries } = depsOver({ "clients.select": { data: CLIENT_ROW, error: null } });
  const row = await deps.getClientForUser(USER.id);
  assertEquals(queries.map((q) => [q.table, q.op, q.arg, q.filters]), [
    ["clients", "select", CLIENT_SELECT, [["eq", "auth_user_id", USER.id]]],
  ]);
  assertEquals(row, CLIENT_ROW);
});

Deno.test("getClientForUser: a failed query REJECTS with the cause and the caller, never reads as absence", async () => {
  const { deps } = depsOver({ "clients.select": { data: null, error: PG_ERROR } });
  const err = await rejection(() => deps.getClientForUser(USER.id));
  assert(err instanceof HttpError, `expected HttpError, got ${String(err)}`);
  assertEquals(err.status, 500);
  assertEquals(err.code, "db_error");
  assertEquals(err.message, "client lookup failed");
  assertEquals(err.cause, PG_ERROR);
  assertEquals(err.context, { auth_user_id: USER.id });
});

Deno.test("getClientForUser: no row is still ABSENCE — the handler's 403, not a 500", async () => {
  const { deps } = depsOver({ "clients.select": { data: null, error: null } });
  assertEquals(await deps.getClientForUser(USER.id), null);
});

// ── createPortalSession ────────────────────────────────────────────────────

Deno.test("createPortalSession: forwards BOTH the params and the per-request options to the real call", async () => {
  // The options are what put the session on the connected account. A wiring
  // that forwards `params` alone creates every session on the platform
  // account and the handler suite cannot tell.
  const { deps, recorded } = depsOver({});
  const params = { customer: "cus_client", return_url: `${BASE}/portal/billing` };
  const session = await deps.createPortalSession(params, { stripeAccount: "acct_connected" });
  assertEquals(session, { url: "https://billing.stripe.com/session" });
  assertEquals(recorded, [
    { call: "billingPortal.sessions.create", args: [params, { stripeAccount: "acct_connected" }] },
  ]);
});

Deno.test("the Stripe client is resolved AFTER the refusals: a caller who is not a client is 403, not a missing-key 500", async () => {
  // The shipped ordering, kept: with no STRIPE_SECRET_KEY the deps still
  // construct, the lookup still runs, and the refusal is the refusal. Only a
  // request that gets as far as minting a session asks for the client.
  const { deps, stripeResolved } = depsOver({ "clients.select": { data: null, error: null } }, {
    stripeUnavailable: true,
  });
  const err = await rejection(() => handleBillingPortal(USER, deps));
  assert(err instanceof HttpError, `expected HttpError, got ${String(err)}`);
  assertEquals(err.code, "not_client");
  assertEquals(stripeResolved(), 0, "the Stripe client was resolved before the refusal");
});

// ── end to end, through the real wiring ────────────────────────────────────

Deno.test("a client through the real wiring gets a session on the WALKER's account for the row's customer", async () => {
  const { deps, recorded, stripeResolved } = depsOver({ "clients.select": { data: CLIENT_ROW, error: null } });
  const res = await handleBillingPortal(USER, deps);
  assertEquals(res, { url: "https://billing.stripe.com/session" });
  assertEquals(stripeResolved(), 1);
  assertEquals(recorded, [{
    call: "billingPortal.sessions.create",
    args: [
      { customer: "cus_client", return_url: `${BASE}/portal/billing` },
      { stripeAccount: "acct_connected" },
    ],
  }]);
});

Deno.test("a failed lookup through the real wiring is the 500, reaching no Stripe call", async () => {
  const { deps, recorded, stripeResolved } = depsOver({ "clients.select": { data: null, error: PG_ERROR } });
  const err = await rejection(() => handleBillingPortal(USER, deps));
  assert(err instanceof HttpError, `expected HttpError, got ${String(err)}`);
  assertEquals(err.message, "client lookup failed");
  assertEquals(recorded, []);
  assertEquals(stripeResolved(), 0);
});
