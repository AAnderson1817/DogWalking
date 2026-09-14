// connect-onboarding's WIRING, driven: `makeConnectOnboardingDeps` against a
// scripted PostgREST double.
//
// `connect_onboarding_test.ts` injects a hand-built `ConnectOnboardingDeps`
// and so pins the DECISIONS; its `claimAccountId` double rejects with whatever
// the test hands it and performs no write and no read, so "a failed claim —
// write or re-read" was one rejection it could not tell apart. This file
// drives the real wiring: the `.select` string and its filter, the
// CONDITIONAL claim (the `is("stripe_account_id", null)` that makes two
// concurrent starts safe), the re-read whose answer wins, the write's throw,
// and the re-read's throw — PR #92's fix for this function, asserted until
// now by the discarded-errors gate and driven by nothing.
import { assert, assertEquals } from "./asserts.ts";
import { HttpError } from "../_lib/http.ts";
import { makeConnectOnboardingDeps } from "../connect-onboarding/deps.ts";
import { handleConnectOnboarding, type PlatformConnectStripe } from "../connect-onboarding/handler.ts";
import { PG_ERROR, rejection, type Result, scriptedDb } from "./scripted_db.ts";

const OP_ID = "00000000-0000-4000-a000-0000000000aa";
const BASE = "https://app.sanpo.test";
const OPERATOR_SELECT =
  "id, email, business_name, stripe_account_id, stripe_charges_enabled, stripe_payouts_enabled, stripe_details_submitted";

const OPERATOR_ROW = {
  id: OP_ID,
  email: "op@sanpo.test",
  business_name: "Pine & Paws",
  stripe_account_id: null,
  stripe_charges_enabled: false,
  stripe_payouts_enabled: false,
  stripe_details_submitted: false,
};

interface Recorded {
  call: string;
  args: unknown[];
}

function stripeDouble(recorded: Recorded[]): PlatformConnectStripe {
  return {
    accounts: {
      create(params, o) {
        recorded.push({ call: "accounts.create", args: [params, o] });
        return Promise.resolve({ id: "acct_fresh" });
      },
    },
    accountLinks: {
      create(params, o) {
        recorded.push({ call: "accountLinks.create", args: [params, o] });
        return Promise.resolve({ url: `https://connect.stripe.com/setup/${params.account}` });
      },
    },
  };
}

function depsOver(results: Record<string, Result | Result[]>) {
  const recorded: Recorded[] = [];
  const { db, queries } = scriptedDb(results);
  const deps = makeConnectOnboardingDeps({ db: db as never, stripe: stripeDouble(recorded), base: BASE });
  return { deps, queries, recorded };
}

function claims(queries: ReturnType<typeof scriptedDb>["queries"]) {
  return queries.map((q) => [q.table, q.op, q.filters]);
}

// ── getOperator ────────────────────────────────────────────────────────────

Deno.test("getOperator: asks operators for the shipped columns, filtered on the id, and returns the row", async () => {
  const { deps, queries } = depsOver({ "operators.select": { data: OPERATOR_ROW, error: null } });
  assertEquals(await deps.getOperator(OP_ID), OPERATOR_ROW);
  assertEquals(queries.map((q) => [q.table, q.op, q.arg, q.filters]), [
    ["operators", "select", OPERATOR_SELECT, [["eq", "id", OP_ID]]],
  ]);
});

Deno.test("getOperator: a failed query REJECTS with the cause and the operator id", async () => {
  const { deps } = depsOver({ "operators.select": { data: null, error: PG_ERROR } });
  const err = await rejection(() => deps.getOperator(OP_ID));
  assert(err instanceof HttpError, `expected HttpError, got ${String(err)}`);
  assertEquals(err.status, 500);
  assertEquals(err.code, "db_error");
  assertEquals(err.message, "operator lookup failed");
  assertEquals(err.cause, PG_ERROR);
  assertEquals(err.context, { operator_id: OP_ID });
});

Deno.test("getOperator: no row is still ABSENCE", async () => {
  const { deps } = depsOver({ "operators.select": { data: null, error: null } });
  assertEquals(await deps.getOperator(OP_ID), null);
});

// ── claimAccountId ─────────────────────────────────────────────────────────

Deno.test("claimAccountId: the claim is a CONDITIONAL update on the still-null column, then a re-read of that column", async () => {
  const before = Date.now();
  const { deps, queries } = depsOver({
    "operators.update": { data: null, error: null },
    "operators.select": { data: { stripe_account_id: "acct_fresh" }, error: null },
  });
  assertEquals(await deps.claimAccountId(OP_ID, "acct_fresh"), "acct_fresh");

  assertEquals(claims(queries), [
    ["operators", "update", [["eq", "id", OP_ID], ["is", "stripe_account_id", null]]],
    ["operators", "select", [["eq", "id", OP_ID]]],
  ]);
  const patch = queries[0]!.arg as Record<string, unknown>;
  assertEquals(patch.stripe_account_id, "acct_fresh");
  const stamped = Date.parse(String(patch.stripe_account_connected_at));
  assert(
    !Number.isNaN(stamped) && stamped >= before - 1000 && stamped <= Date.now() + 1000,
    `stripe_account_connected_at is not a current ISO timestamp: ${String(patch.stripe_account_connected_at)}`,
  );
  assertEquals(queries[1]!.arg, "stripe_account_id");
});

Deno.test("claimAccountId: the re-read's answer WINS — the loser of a race adopts the winner's id", async () => {
  const { deps } = depsOver({
    "operators.update": { data: null, error: null },
    "operators.select": { data: { stripe_account_id: "acct_winner" }, error: null },
  });
  assertEquals(await deps.claimAccountId(OP_ID, "acct_fresh"), "acct_winner");
});

Deno.test("claimAccountId: a re-read that finds no row falls back to the id just minted", async () => {
  // `?? accountId`: the row cannot vanish between the update and the read in
  // practice, but a null answer must not become a null account on the link.
  const { deps } = depsOver({
    "operators.update": { data: null, error: null },
    "operators.select": { data: null, error: null },
  });
  assertEquals(await deps.claimAccountId(OP_ID, "acct_fresh"), "acct_fresh");
});

Deno.test("claimAccountId: a failed WRITE rejects with the cause and performs no re-read", async () => {
  const { deps, queries } = depsOver({ "operators.update": { data: null, error: PG_ERROR } });
  const err = await rejection(() => deps.claimAccountId(OP_ID, "acct_fresh"));
  assert(err instanceof HttpError, `expected HttpError, got ${String(err)}`);
  assertEquals(err.status, 500);
  assertEquals(err.code, "db_error");
  assertEquals(err.message, "failed to persist the Stripe account");
  assertEquals(err.cause, PG_ERROR);
  assertEquals(err.context, { operator_id: OP_ID, stripe_account_id: "acct_fresh" });
  assertEquals(queries.map((q) => q.op), ["update"]);
});

Deno.test("claimAccountId: a failed RE-READ rejects with the cause — 'we do not know which account is real' is not 'nobody else claimed it'", async () => {
  // PR #92's fix for this function, driven through the real wiring for the
  // first time: the discarded version read `after` as undefined and fell
  // through to `?? accountId`, minting a link for an account the row might
  // not carry.
  const { deps } = depsOver({
    "operators.update": { data: null, error: null },
    "operators.select": { data: null, error: PG_ERROR },
  });
  const err = await rejection(() => deps.claimAccountId(OP_ID, "acct_fresh"));
  assert(err instanceof HttpError, `expected HttpError, got ${String(err)}`);
  assertEquals(err.status, 500);
  assertEquals(err.code, "db_error");
  assertEquals(err.message, "account re-read failed");
  assertEquals(err.cause, PG_ERROR);
  assertEquals(err.context, { operator_id: OP_ID, stripe_account_id: "acct_fresh" });
});

// ── end to end, through the real wiring ────────────────────────────────────

Deno.test("start through the real wiring: account created, claimed conditionally, re-read, then linked — nothing routed to an account", async () => {
  const { deps, queries, recorded } = depsOver({
    // The operator lookup, then the claim's re-read: same table, same op,
    // consumed in order.
    "operators.select": [
      { data: OPERATOR_ROW, error: null },
      { data: { stripe_account_id: "acct_fresh" }, error: null },
    ],
    "operators.update": { data: null, error: null },
  });
  const res = await handleConnectOnboarding(OP_ID, { action: "start" }, deps);
  assertEquals(res, { url: "https://connect.stripe.com/setup/acct_fresh", account_id: "acct_fresh" });
  assertEquals(recorded.map((r) => r.call), ["accounts.create", "accountLinks.create"]);
  assertEquals(claims(queries), [
    ["operators", "select", [["eq", "id", OP_ID]]],
    ["operators", "update", [["eq", "id", OP_ID], ["is", "stripe_account_id", null]]],
    ["operators", "select", [["eq", "id", OP_ID]]],
  ]);
  for (const { call, args } of recorded) {
    for (const arg of args) {
      assert(
        !(arg && typeof arg === "object" && "stripeAccount" in (arg as Record<string, unknown>)),
        `${call} carried stripeAccount — a platform object routed to a connected account`,
      );
    }
  }
});

Deno.test("a failed re-read through the real wiring mints NO link", async () => {
  const { deps, recorded } = depsOver({
    "operators.select": [
      { data: OPERATOR_ROW, error: null },
      { data: null, error: PG_ERROR },
    ],
    "operators.update": { data: null, error: null },
  });
  const err = await rejection(() => handleConnectOnboarding(OP_ID, { action: "start" }, deps));
  assert(err instanceof HttpError, `expected HttpError, got ${String(err)}`);
  assertEquals(err.message, "account re-read failed");
  assertEquals(recorded.map((r) => r.call), ["accounts.create"]);
});
