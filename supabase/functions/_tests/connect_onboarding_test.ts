// connect-onboarding: the operator's Stripe Connect Standard account, on the
// PLATFORM account (review B5). Pinned on a deps recorder: the order (account
// created, id claimed, link minted — spec 04), the race loser adopting the
// winner's id, a failed claim minting NO link (the behavioural pin the
// fix(send-lookups) re-read fix could only name), no Stripe call carrying
// `stripeAccount` (the operator_billing_test rule — these are platform
// objects), and the `action` rule: `status` by default, `400 bad_action` for
// anything but the two values spec 04 names, before the handler's own lookup
// (`requireOperator` in index.ts has already read the row to authenticate).
import { assert, assertEquals, assertRejects } from "./asserts.ts";
import { HttpError } from "../_lib/http.ts";
import {
  type ConnectBody,
  type ConnectOnboardingDeps,
  type ConnectOperatorRow,
  type ConnectStart,
  type ConnectStatus,
  handleConnectOnboarding,
  type PlatformConnectStripe,
} from "../connect-onboarding/handler.ts";

const OP_ID = "00000000-0000-4000-a000-0000000000aa";
const BASE = "https://app.sanpo.test";

interface Recorded {
  call: string;
  args: unknown[];
}

function operatorRow(over: Partial<ConnectOperatorRow> = {}): ConnectOperatorRow {
  return {
    id: OP_ID,
    email: "op@sanpo.test",
    business_name: "Pine & Paws",
    stripe_account_id: null,
    stripe_charges_enabled: false,
    stripe_payouts_enabled: false,
    stripe_details_submitted: false,
    ...over,
  };
}

function makeStripeDouble(recorded: Recorded[]): PlatformConnectStripe {
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

function makeDeps(
  row: ConnectOperatorRow | null,
  recorded: Recorded[],
  opts: { claimWinner?: string; claimFails?: HttpError; lookupFails?: HttpError } = {},
): ConnectOnboardingDeps & { lookups: string[] } {
  const lookups: string[] = [];
  return {
    lookups,
    getOperator(id) {
      lookups.push(id);
      if (opts.lookupFails) return Promise.reject(opts.lookupFails);
      return Promise.resolve(row);
    },
    claimAccountId(operatorId, accountId) {
      recorded.push({ call: "db.claimAccountId", args: [operatorId, accountId] });
      if (opts.claimFails) return Promise.reject(opts.claimFails);
      return Promise.resolve(opts.claimWinner ?? accountId);
    },
    stripe: makeStripeDouble(recorded),
    base: BASE,
  };
}

function assertNothingRoutedToAnAccount(recorded: Recorded[]): void {
  for (const { call, args } of recorded) {
    for (const arg of args) {
      if (arg && typeof arg === "object") {
        assert(
          !("stripeAccount" in (arg as Record<string, unknown>)),
          `${call} carried stripeAccount — a platform object routed to a connected account`,
        );
      }
    }
  }
}

async function refused(
  row: ConnectOperatorRow | null,
  body: ConnectBody | null,
  opts: { claimFails?: HttpError; lookupFails?: HttpError } = {},
): Promise<{ err: HttpError; recorded: Recorded[]; lookups: string[] }> {
  const recorded: Recorded[] = [];
  const deps = makeDeps(row, recorded, opts);
  const err = await assertRejects(() => handleConnectOnboarding(OP_ID, body, deps));
  assert(err instanceof HttpError, `expected HttpError, got ${err.constructor.name}: ${err.message}`);
  return { err, recorded, lookups: deps.lookups };
}

Deno.test("status reports the four mirror fields and touches nothing", async () => {
  const recorded: Recorded[] = [];
  // Connected but still under review — the real Stripe lifecycle (the
  // account exists before charges are enabled), and the fixture in which
  // `connected` and `charges_enabled` DIFFER, so a handler deriving one from
  // the other's column goes red here rather than passing on a co-varying pair.
  const row = operatorRow({
    stripe_account_id: "acct_have",
    stripe_charges_enabled: false,
    stripe_payouts_enabled: false,
    stripe_details_submitted: true,
  });
  const res = await handleConnectOnboarding(OP_ID, { action: "status" }, makeDeps(row, recorded));
  // The recorder first: "touches nothing" is the property, the shape is detail.
  assert(recorded.length === 0, `status touched: ${recorded.map((r) => r.call).join(", ")}`);
  assertEquals(res as ConnectStatus, {
    connected: true,
    charges_enabled: false,
    payouts_enabled: false,
    details_submitted: true,
  });
});

Deno.test("a null body means status, not start", async () => {
  // A body of the JSON literal `null` (or `{}`) means status. A body with no
  // JSON at all never reaches the handler: `readJson` refuses it as
  // `400 bad_json` first. Either way, nothing here may fall into the other
  // branch and mint an account.
  const recorded: Recorded[] = [];
  const res = await handleConnectOnboarding(OP_ID, null, makeDeps(operatorRow(), recorded));
  assert(recorded.length === 0, `a null body touched: ${recorded.map((r) => r.call).join(", ")}`);
  assertEquals(res as ConnectStatus, {
    connected: false,
    charges_enabled: false,
    payouts_enabled: false,
    details_submitted: false,
  });
});

Deno.test("a caller whose operator row is missing is refused 403 before any Stripe call", async () => {
  const { err, recorded } = await refused(null, { action: "start" });
  assertEquals(err.status, 403);
  assertEquals(err.code, "not_operator");
  assertEquals(recorded, []);
});

Deno.test("a failed operator lookup propagates as the 500 it is, not as an absence, and reaches no Stripe call", async () => {
  // The billing-portal sibling's rule, pinned here too: the deps contract
  // says a lookup throws on a database failure, and a handler that swallowed
  // it into `403 not_operator` would satisfy every other test in this file.
  const { err, recorded } = await refused(operatorRow(), { action: "start" }, {
    lookupFails: new HttpError(500, "db_error", "operator lookup failed", new Error("connection reset")),
  });
  assertEquals(err.status, 500);
  assertEquals(err.code, "db_error");
  // Un-wrapped: the sentence the wiring chose is the one the operator reads.
  assertEquals(err.message, "operator lookup failed");
  assertEquals(recorded, []);
});

Deno.test("start with an account already on the row mints a link for it and creates nothing", async () => {
  const recorded: Recorded[] = [];
  const res = await handleConnectOnboarding(
    OP_ID,
    { action: "start" },
    makeDeps(operatorRow({ stripe_account_id: "acct_have" }), recorded),
  );
  assertEquals(recorded.map((r) => r.call), ["accountLinks.create"]);
  const params = recorded[0].args[0] as { account: string };
  assertEquals(params.account, "acct_have");
  assertEquals((res as ConnectStart).account_id, "acct_have");
});

Deno.test("the account is created, then claimed, then linked — in that order", async () => {
  // Spec 04: the id is persisted BEFORE the AccountLink is minted. Losing the
  // link is recoverable; losing the id means the next start creates a SECOND
  // Stripe account.
  const recorded: Recorded[] = [];
  await handleConnectOnboarding(OP_ID, { action: "start" }, makeDeps(operatorRow(), recorded));
  const order = recorded.map((r) => r.call);
  const created = order.indexOf("accounts.create");
  const claimed = order.indexOf("db.claimAccountId");
  const linked = order.indexOf("accountLinks.create");
  assert(created !== -1 && claimed !== -1 && linked !== -1, `calls: ${order.join(", ")}`);
  assert(created < claimed && claimed < linked, `wrong order: ${order.join(", ")}`);
  // The claim is asked to persist the id Stripe just minted, for this operator.
  assertEquals(recorded[claimed].args, [OP_ID, "acct_fresh"]);
});

Deno.test("the loser of a concurrent start adopts the winner's account", async () => {
  // The conditional claim returned a different id — a concurrent start won —
  // and the link AND the response must carry THAT account, not the orphan.
  const recorded: Recorded[] = [];
  const res = await handleConnectOnboarding(
    OP_ID,
    { action: "start" },
    makeDeps(operatorRow(), recorded, { claimWinner: "acct_winner" }),
  );
  const link = recorded.find((r) => r.call === "accountLinks.create");
  assert(link, "no link was minted");
  assertEquals((link.args[0] as { account: string }).account, "acct_winner");
  assertEquals((res as ConnectStart).account_id, "acct_winner");
});

Deno.test("the account is Standard, with the operator's email, business name and id", async () => {
  // Standard, not Express or Custom: the operator is the merchant of record
  // (spec 04). A null email is OMITTED rather than sent as null.
  const recorded: Recorded[] = [];
  await handleConnectOnboarding(OP_ID, { action: "start" }, makeDeps(operatorRow(), recorded));
  const create = recorded.find((r) => r.call === "accounts.create");
  assert(create, "no account was created");
  const params = create.args[0] as Record<string, unknown>;
  assertEquals(params.type, "standard");
  assertEquals(params.email, "op@sanpo.test");
  assertEquals(params.business_profile, { name: "Pine & Paws" });
  assertEquals(params.metadata, { operator_id: OP_ID });

  recorded.length = 0;
  await handleConnectOnboarding(
    OP_ID,
    { action: "start" },
    makeDeps(operatorRow({ email: null, business_name: null }), recorded),
  );
  const bare = recorded.find((r) => r.call === "accounts.create")!.args[0] as Record<string, unknown>;
  assertEquals(bare.email, undefined);
  assertEquals(bare.business_profile, { name: undefined });
});

Deno.test("the link is an onboarding link whose refresh and return urls sit on APP_BASE_URL", async () => {
  const recorded: Recorded[] = [];
  const res = await handleConnectOnboarding(OP_ID, { action: "start" }, makeDeps(operatorRow(), recorded));
  const link = recorded.find((r) => r.call === "accountLinks.create");
  assert(link, "no link was minted");
  const params = link.args[0] as Record<string, unknown>;
  assertEquals(params.type, "account_onboarding");
  assertEquals(params.refresh_url, `${BASE}/billing?connect=refresh`);
  assertEquals(params.return_url, `${BASE}/billing?connect=return`);
  assertEquals((res as ConnectStart).url, "https://connect.stripe.com/setup/acct_fresh");
});

Deno.test("a failed claim, whichever half failed, propagates as its 500 and mints NO link", async () => {
  // The behavioural pin behind fix(send-lookups): "we do not know which
  // account is real" must not fall through to an onboarding link for the
  // account we just created — an operator finishing Stripe's forms on an
  // orphan.
  const { err, recorded } = await refused(operatorRow(), { action: "start" }, {
    claimFails: new HttpError(500, "db_error", "account re-read failed", new Error("connection reset")),
  });
  assertEquals(err.status, 500);
  assertEquals(err.code, "db_error");
  assertEquals(recorded.map((r) => r.call), ["accounts.create", "db.claimAccountId"]);
});

Deno.test("no Stripe call carries stripeAccount — these are platform objects", async () => {
  const recorded: Recorded[] = [];
  await handleConnectOnboarding(OP_ID, { action: "start" }, makeDeps(operatorRow(), recorded));
  assert(
    recorded.some((r) => r.call === "accounts.create") &&
      recorded.some((r) => r.call === "accountLinks.create"),
    `expected both Stripe calls; got ${recorded.map((r) => r.call).join(", ")}`,
  );
  assertNothingRoutedToAnAccount(recorded);
});

Deno.test("an unknown action is refused 400 bad_action before the handler's own lookup — it used to mint an account for an operator not yet connected", async () => {
  // The shipped code tested only `=== "status"`, so `{ action: "foo" }` fell
  // through to start, which created a Stripe Connect account for an operator
  // not yet connected (a single-use link for a connected one). Spec 04 names two
  // values and the frontend sends only those (api.ts connectStatus /
  // connectStart).
  const { err, recorded, lookups } = await refused(
    operatorRow(),
    { action: "foo" as unknown as "start" },
  );
  assertEquals(err.status, 400);
  assertEquals(err.code, "bad_action");
  assertEquals(recorded, []);
  assertEquals(lookups, []);
});
