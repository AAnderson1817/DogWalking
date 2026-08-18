// Structured error logging (review H14), and the one rule that keeps it from
// becoming a secret leak.
//
// Every deliberate 5xx throw used to discard the underlying Postgres/Stripe
// error at the throw site, and serveFunction's catch returned the envelope with
// no logging at all. So "completing the walk failed yesterday" had no answer.
//
// The dangerous part of fixing that is what goes INTO the line. Invariant 2
// says plaintext secrets are never logged, and Postgres puts the offending
// values in a unique violation's `details` — so a naive "log the whole error"
// is how a door code reaches a log aggregator.
import { assert, assertEquals, assertFalse } from "./asserts.ts";
import {
  causeCode,
  functionName,
  logServerError,
  requestId,
  safeCause,
} from "../_lib/observe.ts";

/** Capture the single line logServerError emits. */
function captureLog(fn: () => void): string[] {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

// ── safeCause: what is allowed through ────────────────────────────────────

Deno.test("safeCause keeps the fields that diagnose a failure", () => {
  const pgError = { code: "23505", message: "duplicate key value violates unique constraint" };
  assertEquals(safeCause(pgError), {
    code: "23505",
    message: "duplicate key value violates unique constraint",
  });
});

Deno.test("safeCause DROPS details and hint — that is where Postgres puts values", () => {
  // A unique violation's details reads:
  //   Key (ciphertext)=(\x8f3a…) already exists.
  // Logging that field is how a secret reaches a log aggregator. No unique
  // constraint on a ciphertext column exists today, which is exactly why this
  // is asserted rather than remembered.
  const pgError = {
    code: "23505",
    message: "duplicate key value violates unique constraint \"uq_x\"",
    details: "Key (ciphertext)=(\\x8f3a9c THE DOOR CODE IS 1234) already exists.",
    hint: "maybe try a different ciphertext",
  };
  const out = safeCause(pgError)!;
  assertFalse("details" in out, "details must never be logged");
  assertFalse("hint" in out, "hint must never be logged");
  assertFalse(JSON.stringify(out).includes("1234"), "a value from details survived");
  assertFalse(JSON.stringify(out).includes("8f3a9c"), "ciphertext from details survived");
});

Deno.test("safeCause drops a response body — Stripe and fetch errors carry them", () => {
  // The canary is a made-up token, not a realistically-shaped API key: the
  // repository's own secret-leak grep forbids those literals anywhere under
  // app/src or supabase/functions, and it is right to. A distinctive string
  // proves the same property.
  const CANARY = "MUST-NOT-BE-LOGGED-9f2c";
  const err = {
    message: "request failed",
    body: `{"api_key":"${CANARY}"}`,
    data: { plaintext: CANARY },
    response: { headers: { authorization: `Bearer ${CANARY}` } },
  };
  const out = JSON.stringify(safeCause(err));
  assertFalse(out.includes(CANARY), "a value from body/data/response survived");
  assertEquals(safeCause(err), { message: "request failed" });
});

Deno.test("safeCause follows the chain — our label is not the finding", () => {
  // The webhook deps throw Error("client lookup failed", { cause: pgError }).
  // Stopping at the first level would record the label and drop the reason,
  // which is the H14 defect wearing our own error's clothes.
  const inner = { code: "42P01", message: 'relation "clients" does not exist' };
  const outer = new Error("client lookup failed", { cause: inner });
  const out = safeCause(outer) as { message: string; cause: Record<string, string> };
  assertEquals(out.message, "client lookup failed");
  assertEquals(out.cause.code, "42P01");
});

Deno.test("safeCause cannot be hung by a self-referential cause", () => {
  const loop: { message: string; cause?: unknown } = { message: "round" };
  loop.cause = loop;
  const out = safeCause(loop);
  // Depth-capped rather than cycle-detected: a cap cannot be defeated.
  assert(JSON.stringify(out).length < 500, "the chain was not bounded");
});

Deno.test("safeCause truncates, so one error cannot blow the line budget", () => {
  const out = safeCause({ message: "x".repeat(5000) }) as { message: string };
  assert(out.message.length < 400, `message was ${out.message.length} chars`);
  assert(out.message.endsWith("…"));
});

Deno.test("safeCause handles the shapes that are not objects at all", () => {
  assertEquals(safeCause(null), null);
  assertEquals(safeCause(undefined), null);
  assertEquals(safeCause("plain string"), { message: "plain string" });
  assertEquals(safeCause(42), { message: "42" });
});

Deno.test("causeCode gives up the message entirely", () => {
  // The stricter setting, for the two vault statements that carry ciphertext in
  // the statement itself: a syntax error there could quote the payload back.
  assertEquals(causeCode({ code: "22P02", message: "invalid input syntax \\x1234" }), "sqlstate 22P02");
  assertFalse(causeCode({ code: "22P02", message: "secret 1234" }).includes("1234"));
  assertEquals(causeCode({ message: "no code here" }), "(no code)");
});

// ── the log line ──────────────────────────────────────────────────────────

Deno.test("logServerError emits exactly ONE parseable JSON line", () => {
  // One line per failure is what makes the platform log searchable at all.
  const lines = captureLog(() =>
    logServerError({
      fn: "complete-walk",
      request_id: "req-1",
      status: 500,
      code: "billing_error",
      message: "credit debit failed",
      cause: { code: "P0001", message: "fn_debit_walk: insufficient credits" },
      context: { walk_id: "walk-9", client_id: "client-3" },
    })
  );
  assertEquals(lines.length, 1);
  const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
  assertEquals(parsed.level, "error");
  assertEquals(parsed.fn, "complete-walk");
  assertEquals(parsed.status, 500);
  assertEquals(parsed.code, "billing_error");
  assertEquals((parsed.context as Record<string, string>).walk_id, "walk-9");
  assertEquals((parsed.cause as Record<string, string>).code, "P0001");
});

Deno.test("the context is what answers 'the walk failed yesterday'", () => {
  // The motivating scenario. Without an id on the line there is nothing to
  // search by, and the line is only marginally better than no line.
  const lines = captureLog(() =>
    logServerError({
      fn: "complete-walk",
      request_id: "req-2",
      status: 500,
      code: "db_error",
      message: "walk update failed",
      context: { walk_id: "the-walk" },
    })
  );
  assert(lines[0].includes("the-walk"));
});

Deno.test("empty and null context entries are dropped, not logged as null", () => {
  const lines = captureLog(() =>
    logServerError({
      fn: "x",
      request_id: "r",
      status: 500,
      code: "c",
      message: "m",
      context: { walk_id: undefined, client_id: null },
    })
  );
  const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
  assertFalse("context" in parsed, "an all-empty context should not appear at all");
});

// ── request id ────────────────────────────────────────────────────────────

Deno.test("requestId mints one when the caller supplies none", () => {
  const id = requestId(new Request("https://x/complete-walk", { method: "POST" }));
  assert(id.length >= 8, id);
});

Deno.test("requestId honours the caller's id so a trace spans the hop", () => {
  const req = new Request("https://x/complete-walk", {
    method: "POST",
    headers: { "x-request-id": "client-abc-123" },
  });
  assertEquals(requestId(req), "client-abc-123");
});

Deno.test("a caller-supplied id is normalised, not trusted verbatim", () => {
  // The concern is a caller writing arbitrary entries into the log an operator
  // trusts. A literal newline turns out to be unreachable — `Headers` rejects
  // it at construction, so it cannot arrive over HTTP at all (verified: the
  // Request constructor throws "Invalid header value"). That makes this guard
  // defence in depth rather than the only line, which is worth knowing.
  //
  // What IS reachable is a value full of JSON-structural characters, and the
  // sanitiser reduces it to the id-shaped subset.
  const req = new Request("https://x/complete-walk", {
    method: "POST",
    headers: { "x-request-id": 'ok-1234"},{"level":"error","fn":"forged' },
  });
  const id = requestId(req);
  assertEquals(id, "ok-1234levelerrorfnforged");
  assertFalse(id.includes('"'));
  assertFalse(id.includes("{"));
});

Deno.test("an id that sanitises down to almost nothing is replaced", () => {
  // 'a"b}c{d' reduces to four characters, which is not an id — so the floor
  // rejects it and a fresh one is minted rather than carrying a stub forward.
  const id = requestId(new Request("https://x/y", {
    method: "POST",
    headers: { "x-request-id": 'a"b}c{d' },
  }));
  assertFalse(id === "abcd", "a 4-char remnant was accepted as an id");
  assert(id.length >= 8);
});

Deno.test("whatever the caller sent, the line is still ONE parseable object", () => {
  // The property that actually matters. Everything above is mechanism; this is
  // the guarantee — a caller cannot turn one log entry into two.
  const lines = captureLog(() =>
    logServerError({
      fn: "x",
      request_id: requestId(new Request("https://x/y", {
        method: "POST",
        headers: { "x-request-id": 'ok-1234"},{"level":"error' },
      })),
      status: 500,
      code: "c",
      message: "m",
    })
  );
  assertEquals(lines.length, 1);
  const parsed = JSON.parse(lines[0]) as Record<string, string>;
  assertFalse(parsed.request_id.includes('"'));
  assertFalse(parsed.request_id.includes("{"));
  assertEquals(parsed.fn, "x", "fn must not be overwritable by a forged fragment");
});

Deno.test("a too-short caller id is replaced rather than trusted", () => {
  const req = new Request("https://x/y", { method: "POST", headers: { "x-request-id": "a" } });
  assert(requestId(req).length >= 8);
});

Deno.test("a caller id is bounded", () => {
  const req = new Request("https://x/y", {
    method: "POST",
    headers: { "x-request-id": "z".repeat(5000) },
  });
  assert(requestId(req).length <= 64);
});

// ── function name ─────────────────────────────────────────────────────────

Deno.test("functionName reads both routing shapes", () => {
  // Supabase routes /functions/v1/<name>; the isolate sees /<name>.
  assertEquals(functionName("https://ref.supabase.co/functions/v1/complete-walk"), "complete-walk");
  assertEquals(functionName("http://localhost:54321/complete-walk"), "complete-walk");
});

Deno.test("functionName says unknown rather than guessing", () => {
  // A line naming the WRONG function is worse than one naming none, which is
  // why this is derived rather than passed in per call site.
  assertEquals(functionName("https://ref.supabase.co/functions/v1/"), "unknown");
  assertEquals(functionName("not a url"), "unknown");
  assertEquals(functionName("https://ref.supabase.co/"), "unknown");
});

// ── handleRequest: the wrapper every function's failures pass through ──────
// Extracted from inside Deno.serve so this is reachable at all. It was not
// before, which is how "no logging in the shared catch" survived unnoticed.

import { handleRequest, HttpError, jsonOk } from "../_lib/http.ts";

const post = (url = "https://ref.supabase.co/functions/v1/complete-walk") =>
  new Request(url, { method: "POST", body: "{}" });

Deno.test("a 5xx logs one line carrying the cause and the context", () => {
  // The H14 deliverable. Before this the catch returned the envelope and wrote
  // nothing, and the throw site had already discarded the Postgres error.
  let res: Response | undefined;
  const lines = captureLog(() => {
    handleRequest(post(), () => {
      throw new HttpError(500, "billing_error", "credit debit failed", {
        code: "P0001",
        message: "fn_debit_walk: no such walk",
      }, { walk_id: "walk-42" });
    }).then((r) => {
      res = r;
    });
  });
  assertEquals(lines.length, 1, "expected exactly one log line");
  const line = JSON.parse(lines[0]) as Record<string, unknown>;
  assertEquals(line.fn, "complete-walk");
  assertEquals(line.code, "billing_error");
  assertEquals((line.cause as Record<string, string>).code, "P0001");
  assertEquals((line.context as Record<string, string>).walk_id, "walk-42");
  assert(res === undefined || res.status === 500);
});

Deno.test("a 4xx logs NOTHING — it is the caller being told something true", () => {
  // Logging those would bury the failures that are ours under a pile that are
  // not, which is the same as not logging.
  const lines = captureLog(() => {
    handleRequest(post(), () => {
      throw new HttpError(403, "not_operator", "caller is not an operator");
    });
  });
  assertEquals(lines.length, 0);
});

Deno.test("an unexpected throw is logged as a 500 with the value as the cause", async () => {
  let lines: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  let res: Response;
  try {
    res = await handleRequest(post(), () => {
      throw new TypeError("cannot read properties of undefined");
    });
  } finally {
    console.error = original;
  }
  assertEquals(res.status, 500);
  assertEquals(lines.length, 1);
  const line = JSON.parse(lines[0]) as Record<string, unknown>;
  assertEquals(line.code, "internal");
  const cause = line.cause as Record<string, string>;
  assertEquals(cause.name, "TypeError");
  assert(cause.message.includes("cannot read properties"));
});

Deno.test("the envelope carries the request id, and never the cause", async () => {
  // The cause is for us. The client gets our sentence plus an id they can
  // quote — leaking a Postgres error to a pet owner's browser would be a
  // different defect in the same area.
  const res = await handleRequest(post(), () => {
    throw new HttpError(500, "db_error", "walk lookup failed", {
      message: 'relation "walks" does not exist',
    });
  });
  const body = await res.json() as { ok: boolean; error: Record<string, string> };
  assertEquals(body.ok, false);
  assertEquals(body.error.code, "db_error");
  assertEquals(body.error.message, "walk lookup failed");
  assert(body.error.request_id.length >= 8);
  assertFalse(JSON.stringify(body).includes("relation"), "the cause reached the client");
  assertEquals(res.headers.get("x-request-id"), body.error.request_id);
});

Deno.test("a success response carries the request id too", async () => {
  const res = await handleRequest(post(), () => Promise.resolve(jsonOk({ fine: true })));
  assertEquals(res.status, 200);
  assert((res.headers.get("x-request-id") ?? "").length >= 8);
});

Deno.test("the id the client sent is the id in both the line and the envelope", async () => {
  // What makes a trace span the hop: the operator's browser, the log line, and
  // the response a human is looking at all name the same request.
  const req = new Request("https://ref.supabase.co/functions/v1/charge-overage", {
    method: "POST",
    body: "{}",
    headers: { "x-request-id": "trace-abc-999" },
  });
  let lines: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  let res: Response;
  try {
    res = await handleRequest(req, () => {
      throw new HttpError(500, "db_error", "walk lookup failed", { code: "XX000" });
    });
  } finally {
    console.error = original;
  }
  const body = await res.json() as { error: Record<string, string> };
  assertEquals(body.error.request_id, "trace-abc-999");
  assertEquals((JSON.parse(lines[0]) as Record<string, string>).request_id, "trace-abc-999");
});
