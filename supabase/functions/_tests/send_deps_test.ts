// The email arm's LOOKUPS: a failed query must reject, never read as absence.
//
// Backlog item 2, found during money(send-once) and deferred because it was
// pre-existing and untouched by that diff. `getClient` and `getOperator` in
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
// database double, the `push_deps_test.ts` shape.
import { assert, assertEquals } from "./asserts.ts";
import { HttpError } from "../_lib/http.ts";
import { makeSendDeps } from "../send-notification/deps.ts";
import { deliverNotification, type NotificationRow } from "../send-notification/handler.ts";

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

/** The shape supabase-js resolves a failed PostgREST query with. */
const PG_ERROR = {
  code: "57014",
  message: "canceling statement due to statement timeout",
  details: null,
  hint: null,
};

interface Result {
  data: unknown;
  error: unknown;
}

interface Query {
  table: string;
  op: string;
  arg: unknown;
  filters: Array<[string, string, unknown]>;
}

/**
 * A scripted PostgREST double. Each `from(table)` yields a thenable builder
 * that records the operation and its filters, and resolves with the result
 * scripted for `<table>.<op>` (or `{ data: null, error: null }` when nothing
 * is scripted, which is what supabase-js returns for an empty `maybeSingle`).
 * `rpc(fn)` resolves the result scripted for `rpc:<fn>`.
 */
function scriptedDb(results: Record<string, Result>) {
  const queries: Query[] = [];
  const rpcs: Array<[string, Record<string, unknown>]> = [];
  const resultFor = (key: string): Result => results[key] ?? { data: null, error: null };
  function builder(table: string) {
    const q: Query = { table, op: "", arg: undefined, filters: [] };
    queries.push(q);
    const chain = {
      select(cols: string) {
        q.op = q.op || "select";
        q.arg = q.op === "select" ? cols : q.arg;
        return chain;
      },
      update(patch: Record<string, unknown>) {
        q.op = "update";
        q.arg = patch;
        return chain;
      },
      eq(col: string, val: unknown) {
        q.filters.push(["eq", col, val]);
        return chain;
      },
      is(col: string, val: unknown) {
        q.filters.push(["is", col, val]);
        return chain;
      },
      maybeSingle() {
        return chain;
      },
      then<T>(onFulfilled: (r: Result) => T) {
        return Promise.resolve(resultFor(`${table}.${q.op}`)).then(onFulfilled);
      },
    };
    return chain;
  }
  const db = {
    from: (table: string) => builder(table),
    rpc(fn: string, args: Record<string, unknown>) {
      rpcs.push([fn, args]);
      return Promise.resolve(resultFor(`rpc:${fn}`));
    },
  };
  return { db, queries, rpcs };
}

function depsOver(results: Record<string, Result>) {
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
      operatorId: null,
      fromEmail: "Sanpo <n@sanpo.test>",
      unsubscribeBase: "https://x.test/unsubscribe",
    },
    fetchImpl,
  );
  return { deps, queries, rpcs, fetches };
}

/** Runs `fn`, returns what it rejected with, and fails if it resolved. */
async function rejection(fn: () => Promise<unknown>): Promise<unknown> {
  const err = await fn().then(() => null, (e: unknown) => e);
  assert(err !== null, "expected a rejection, got a resolved value");
  return err;
}

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
