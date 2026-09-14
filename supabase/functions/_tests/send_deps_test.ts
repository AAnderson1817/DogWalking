// The email arm's LOOKUPS: a failed query must reject, never read as absence.
//
// The send-lookups backlog item, found during money(send-once) and deferred
// because it was pre-existing and untouched by that diff. `getClient` and `getOperator` in
// `send-notification/deps.ts` destructured `{ data }` and dropped `error` —
// and supabase-js reports a failed query in the RESOLVED result, never by
// rejecting. So a transient failure (a paused database, a statement timeout,
// a JWT hiccup) resolved to `null`, `sendClaimed` read that as "no such
// client", and recorded the TERMINAL skip "client has no email address":
// a `payment_failed` email cancelled permanently by a blip. The operator arm
// was quieter — the mail went out as "Your walker" — but the same defect.
//
// `send_notification_test.ts` injects a hand-built `SendDeps`, so it drives
// the DECISIONS and structurally cannot see what the real wiring does with a
// query's error. This file drives the real `makeSendDeps` against a scripted
// database double (`scripted_db.ts`, shared with the billing-portal and
// connect-onboarding wiring tests).
import { assert, assertEquals } from "./asserts.ts";
import { HttpError } from "../_lib/http.ts";
import { makeSendDeps } from "../send-notification/deps.ts";
import { deliverNotification, type NotificationRow } from "../send-notification/handler.ts";
import { PG_ERROR, type Query, rejection, type Result, scriptedDb } from "./scripted_db.ts";

/** A claim token as the RPC returns one. */
const STAMP = "3f2a1c4e-8b7d-4a19-9c52-6e0d1b8a7f34";

const ROW: NotificationRow = {
  id: "n-1",
  operator_id: "op-1",
  client_id: "cl-1",
  type: "payment_failed",
  title: "Card declined",
  body: "Please update your payment method.",
  walk_id: null,
  email_attempts: 0,
};


function depsOver(results: Record<string, Result>, opts: { operatorId?: string | null } = {}) {
  const fetches: string[] = [];
  const fetchImpl = ((url: string | URL | Request) => {
    fetches.push(String(url));
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as unknown as typeof fetch;
  const { db, queries, rpcs } = scriptedDb(results);
  const deps = makeSendDeps(
    {
      db: db as never,
      apiKey: "re_test_key",
      operatorId: opts.operatorId ?? null,
      fromEmail: "Sanpo <n@sanpo.test>",
      unsubscribeBase: "https://x.test/unsubscribe",
    },
    fetchImpl,
  );
  return { deps, queries, rpcs, fetches };
}


// ── getNotification / backlogIds ───────────────────────────────────────────
//
// The two lookups the first version of this file did not drive (adversarial
// review on PR #92): their throws, and the M1 tenant scope, were pinned by
// nothing through the real wiring.

Deno.test("getNotification: a failed query REJECTS with the cause and the notification id", async () => {
  const { deps } = depsOver({ "notifications.select": { data: null, error: PG_ERROR } });
  const err = await rejection(() => deps.getNotification("n-1"));
  assert(err instanceof HttpError, `expected HttpError, got ${String(err)}`);
  assertEquals(err.status, 500);
  assertEquals(err.code, "db_error");
  assertEquals(err.message, "notification lookup failed");
  assertEquals(err.cause, PG_ERROR);
  assertEquals(err.context, { notification_id: "n-1" });
});

Deno.test("getNotification: the service role reads every tenant; an operator reads only its own (M1)", async () => {
  // The scope goes into the QUERY, not into a check after it: a post-fetch
  // comparison has already read the row.
  const service = depsOver({ "notifications.select": { data: ROW, error: null } });
  assertEquals(await service.deps.getNotification("n-1"), ROW);
  assertEquals(service.queries.map((q) => [q.table, q.op, q.filters]), [
    ["notifications", "select", [["eq", "id", "n-1"]]],
  ]);
  const operator = depsOver({ "notifications.select": { data: null, error: null } }, { operatorId: "op-2" });
  assertEquals(await operator.deps.getNotification("n-1"), null, "another tenant's row is absence, not a leak");
  assertEquals(operator.queries.map((q) => [q.table, q.op, q.filters]), [
    ["notifications", "select", [["eq", "id", "n-1"], ["eq", "operator_id", "op-2"]]],
  ]);
});

Deno.test("backlogIds: a failed RPC REJECTS; a good one is the list of ids", async () => {
  const failed = depsOver({ "rpc:fn_notification_backlog": { data: null, error: PG_ERROR } });
  const err = await rejection(() => failed.deps.backlogIds());
  assert(err instanceof HttpError, `expected HttpError, got ${String(err)}`);
  assertEquals(err.message, "backlog lookup failed");
  assertEquals(err.cause, PG_ERROR);
  const ok = depsOver({ "rpc:fn_notification_backlog": { data: [{ id: "n-1" }, { id: "n-2" }], error: null } });
  assertEquals(await ok.deps.backlogIds(), ["n-1", "n-2"]);
  assertEquals(ok.rpcs, [["fn_notification_backlog", {}]]);
});

// ── getClient ──────────────────────────────────────────────────────────────

Deno.test("getClient: a failed query REJECTS with the cause and the client id", async () => {
  const { deps, queries } = depsOver({ "clients.select": { data: null, error: PG_ERROR } });
  const err = await rejection(() => deps.getClient("cl-1"));
  assert(err instanceof HttpError, `expected HttpError, got ${String(err)}`);
  assertEquals(err.status, 500);
  assertEquals(err.code, "db_error");
  assertEquals(err.message, "client lookup failed");
  // The real error rides in `cause` (H14): it is the only thing that answers
  // "why", and it never reaches the client. The context is what a person
  // searches the log by.
  assertEquals(err.cause, PG_ERROR);
  assertEquals(err.context, { client_id: "cl-1" });
  assertEquals(queries.map((q) => [q.table, q.op, q.filters]), [
    ["clients", "select", [["eq", "id", "cl-1"]]],
  ]);
});

Deno.test("getClient: no row is still ABSENCE, not an error", async () => {
  // The fix must not over-correct: `{ data: null, error: null }` is exactly
  // what supabase-js resolves for a `maybeSingle` that matched nothing, and
  // the caller decides what a missing client means.
  const { deps } = depsOver({ "clients.select": { data: null, error: null } });
  assertEquals(await deps.getClient("cl-missing"), null);
});

Deno.test("getClient: a row comes back as the row", async () => {
  const row = { full_name: "Ada", email: "ada@example.test", unsubscribe_token: "t-1" };
  const { deps } = depsOver({ "clients.select": { data: row, error: null } });
  assertEquals(await deps.getClient("cl-1"), row);
});

// ── getOperator ────────────────────────────────────────────────────────────

Deno.test("getOperator: a failed query REJECTS with the cause and the operator id", async () => {
  // The sibling, one function over. The defect was applied to both and the
  // fix has to be, or the email goes out as "Your walker" over a blip.
  const { deps, queries } = depsOver({ "operators.select": { data: null, error: PG_ERROR } });
  const err = await rejection(() => deps.getOperator("op-1"));
  assert(err instanceof HttpError, `expected HttpError, got ${String(err)}`);
  assertEquals(err.status, 500);
  assertEquals(err.code, "db_error");
  assertEquals(err.message, "operator lookup failed");
  assertEquals(err.cause, PG_ERROR);
  assertEquals(err.context, { operator_id: "op-1" });
  assertEquals(queries.map((q) => [q.table, q.op, q.filters]), [
    ["operators", "select", [["eq", "id", "op-1"]]],
  ]);
});

Deno.test("getOperator: no row is still ABSENCE, not an error", async () => {
  const { deps } = depsOver({ "operators.select": { data: null, error: null } });
  assertEquals(await deps.getOperator("op-missing"), null);
});

Deno.test("getOperator: a row comes back as the row", async () => {
  const { deps } = depsOver({ "operators.select": { data: { business_name: "Old Town Walks" }, error: null } });
  assertEquals(await deps.getOperator("op-1"), { business_name: "Old Town Walks" });
});

// ── end to end, through the real wiring ────────────────────────────────────
//
// What the unit cases above cannot show is the OUTCOME the defect produced:
// a terminal `skipped` written over a transient failure. These drive
// `deliverNotification` with the real `makeSendDeps`, so the only doubles are
// the database and the network.

function updatesTo(queries: Query[], table: string) {
  return queries.filter((q) => q.table === table && q.op === "update");
}

Deno.test("a client lookup failure REJECTS the delivery: no skip recorded, claim released, nothing sent", async () => {
  const { deps, queries, rpcs, fetches } = depsOver({
    "rpc:fn_claim_notification_send": { data: STAMP, error: null },
    "clients.select": { data: null, error: PG_ERROR },
    "operators.select": { data: { business_name: "Old Town Walks" }, error: null },
  });
  const err = await rejection(() => deliverNotification(ROW, deps));
  assert(err instanceof HttpError, `expected HttpError, got ${String(err)}`);
  assertEquals(err.message, "client lookup failed");

  assertEquals(rpcs, [["fn_claim_notification_send", { p_id: "n-1", p_channel: "email" }]]);
  const writes = updatesTo(queries, "notifications");
  // Before the fix this was ONE write: `email_status: "skipped"` with the
  // reason "client has no email address" — the row cancelled for good over a
  // statement timeout. Now the only write is the claim going back, fenced on
  // the stamp, so the backlog retries it.
  assertEquals(writes.map((w) => [w.arg, w.filters]), [
    [
      { email_claimed_at: null, email_claim_token: null },
      [["eq", "id", "n-1"], ["eq", "email_claim_token", STAMP]],
    ],
  ]);
  assertEquals(fetches, [], "reached the provider after the lookup failed");
});

Deno.test("an operator lookup failure REJECTS the delivery the same way", async () => {
  const { deps, queries, fetches } = depsOver({
    "rpc:fn_claim_notification_send": { data: STAMP, error: null },
    "clients.select": {
      data: { full_name: "Ada", email: "ada@example.test", unsubscribe_token: "t-1" },
      error: null,
    },
    "operators.select": { data: null, error: PG_ERROR },
  });
  const err = await rejection(() => deliverNotification(ROW, deps));
  assert(err instanceof HttpError, `expected HttpError, got ${String(err)}`);
  assertEquals(err.message, "operator lookup failed");
  const writes = updatesTo(queries, "notifications");
  assertEquals(writes.map((w) => w.arg), [{ email_claimed_at: null, email_claim_token: null }]);
  assertEquals(fetches, [], "reached the provider after the lookup failed");
});

Deno.test("a client that genuinely has no row is still the terminal skip", async () => {
  // Absence end to end. The fix distinguishes "the query failed" from "the
  // query found nothing"; the second is still terminal, because no number of
  // retries produces an address for a client who does not exist.
  const { deps, queries, fetches } = depsOver({
    "rpc:fn_claim_notification_send": { data: STAMP, error: null },
    "clients.select": { data: null, error: null },
    "operators.select": { data: { business_name: "Old Town Walks" }, error: null },
  });
  const outcome = await deliverNotification(ROW, deps);
  assertEquals(outcome, { kind: "skipped", reason: "client has no email address" });
  const writes = updatesTo(queries, "notifications");
  assertEquals(writes.length, 1);
  assertEquals((writes[0]!.arg as Record<string, unknown>).email_status, "skipped");
  assertEquals(writes[0]!.filters, [["eq", "id", "n-1"], ["eq", "email_claim_token", STAMP]]);
  assertEquals(fetches, []);
});
