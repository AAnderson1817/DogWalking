// The push arm's WIRING: the part that actually reaches the network.
//
// Split out of index.ts so it could be driven at all (Codex review on PR
// #85). `push.ts` injects a pure `sendPush`, so every existing push test
// exercises the DECISIONS and none of them has ever touched the `fetch` — the
// same blind spot `fix(connect-routing)` recorded for `overage_deps.ts`,
// where the one Stripe call still pointed at the platform account survived a
// full suite because the suite mocked the layer above it.
//
// What is pinned here is what a mocked `sendPush` structurally cannot see:
// the request options (a redirect is a security control here), and the fact
// that the push service's response body never becomes a return value.
import { assert, assertEquals } from "./asserts.ts";
import { makePushDeps } from "../send-notification/push_deps.ts";
import type { VapidConfig } from "../_lib/webpush.ts";
import { bytesToB64url } from "../_lib/webpush.ts";
import type { PushSubscription } from "../send-notification/push.ts";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// The webpush_test vector, which is byte-pinned against `http_ece`.
const VAPID: VapidConfig = {
  publicKey:
    "BHYKBshY3BflxTbegR9xB7-iTU_uOdZK_ZFY7rqrPPJbxO3PNMLAjRaw3NuIHYRwFLhAKusNb8UweMqU884c5M4",
  privateKey: bytesToB64url(
    hexToBytes("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
  ),
  subject: "mailto:ops@sanpo.test",
};

const SUB: PushSubscription = {
  id: "sub-1",
  endpoint: "https://fcm.googleapis.com/fcm/send/DEVICE-BEARER-TOKEN",
  p256dh: "BDgBTGA8idqXEkJjIO5TqUx5Xdo7kLtbB5Guj120hrfbJeOqNo7eN7llZvZlkPieoqyDS81hVBuQc4y8gpRwbJY",
  auth: "ZmVkY2JhOTg3NjU0MzIxMA",
};

interface Call {
  url: string;
  init: RequestInit;
}

/** `makePushDeps` with the network replaced, and every request recorded. */
function deps(respond: () => Response, vapid: VapidConfig | null = VAPID) {
  const calls: Call[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(respond());
  }) as unknown as typeof fetch;
  const db = {} as never;
  const req = new Request("https://x.functions.supabase.co/send-notification", {
    method: "POST",
    headers: { "x-request-id": "req-abc-123" },
  });
  return { calls, push: makePushDeps(db, vapid, req, fetchImpl) };
}

/** Capture the JSON lines `logServerError` writes, without losing them. */
async function captureErrors<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = original;
  }
}

Deno.test("every push request refuses to follow a redirect", async () => {
  // The allowlist decides which host this function will contact. A followed
  // redirect hands that decision to the response instead, one hop later, at a
  // host nothing checked — so the SSRF the allowlist closes would reopen
  // through any push service (or anything impersonating one) that answers
  // 302. A push service does not redirect.
  //
  // Asserted over EVERY recorded call rather than "the call", which is the
  // fix(connect-routing) shape: a test naming one call site has to be
  // remembered and extended, and this one fails on its own for any request
  // added without the option.
  const d = deps(() => new Response("", { status: 201 }));
  await d.push.sendPush(SUB, '{"title":"hi"}');
  assert(d.calls.length > 0, "no request was made at all");
  for (const call of d.calls) {
    assertEquals(call.init.redirect, "manual", `a push request may follow a redirect: ${call.url}`);
  }
});

Deno.test("the request carries the VAPID header, the encoding, and a deadline", async () => {
  const d = deps(() => new Response("", { status: 201 }));
  await d.push.sendPush(SUB, '{"title":"hi"}');
  const [call] = d.calls;
  assertEquals(call.url, SUB.endpoint);
  assertEquals(call.init.method, "POST");
  const headers = call.init.headers as Record<string, string>;
  assert(headers.Authorization.startsWith("vapid t="), headers.Authorization);
  assertEquals(headers["Content-Encoding"], "aes128gcm");
  assertEquals(headers["Content-Type"], "application/octet-stream");
  assertEquals(headers.TTL, "14400");
  // Without a deadline an endpoint that accepts the connection and stalls
  // holds the whole invocation, and devices are sent to sequentially ahead of
  // the email arm.
  assert(call.init.signal instanceof AbortSignal, "no per-request deadline");
});

Deno.test("the push service's response body never becomes a return value", async () => {
  // `notifications.push_last_error` is selectable by `authenticated`, so
  // anything handed back here is client-readable. Returning the body made it
  // an exfiltration channel for whatever the endpoint answered — H14's rule
  // inverted: ours is the only part a client sees.
  const secret = "SSRF-ORACLE-CANARY internal service said no";
  const d = deps(() => new Response(secret, { status: 502 }));
  const { result } = await captureErrors(() => d.push.sendPush(SUB, '{"title":"hi"}'));
  assertEquals(result, { status: 502 });
  assert(
    !JSON.stringify(result).includes("SSRF-ORACLE-CANARY"),
    `the response body reached the caller: ${JSON.stringify(result)}`,
  );
});

Deno.test("the body is kept, on the server, on one log line", async () => {
  // The other direction. Dropping the diagnostic entirely would trade an
  // oracle for the H14 defect — a failure with nothing to look at — so it has
  // to be somewhere, and the log is the place a client cannot read.
  const d = deps(() => new Response("UnauthorizedRegistration", { status: 401 }));
  const { lines } = await captureErrors(() => d.push.sendPush(SUB, '{"title":"hi"}'));
  assertEquals(lines.length, 1, `expected exactly one log line: ${JSON.stringify(lines)}`);
  const entry = JSON.parse(lines[0]);
  assertEquals(entry.code, "push_rejected");
  assertEquals(entry.status, 401);
  assertEquals(entry.request_id, "req-abc-123");
  assertEquals(entry.context.subscription_id, "sub-1");
  assertEquals(entry.cause.message, "UnauthorizedRegistration");
});

Deno.test("the log names the host and never the endpoint's path", async () => {
  // The path segment IS the device's bearer credential: anyone holding it can
  // push to that browser. Writing it into a log aggregator hands out exactly
  // what the vault-style caution in 0049 withholds from `authenticated`.
  const d = deps(() => new Response("nope", { status: 500 }));
  const { lines } = await captureErrors(() => d.push.sendPush(SUB, '{"title":"hi"}'));
  assertEquals(JSON.parse(lines[0]).context.endpoint_host, "fcm.googleapis.com");
  assert(
    !lines[0].includes("DEVICE-BEARER-TOKEN"),
    `the endpoint's token was logged: ${lines[0]}`,
  );
});

Deno.test("a 2xx logs nothing", async () => {
  // A log line per delivered notification is how a log stops being read.
  const d = deps(() => new Response("", { status: 201 }));
  const { lines } = await captureErrors(() => d.push.sendPush(SUB, '{"title":"hi"}'));
  assertEquals(lines, []);
});

// ── Pre-flight failures: ours, classified, and logged ────────────────────
//
// Codex review on PR #85, twelfth round. Everything before the `fetch` used to
// THROW, and `deliverPush`'s catch flattened it to `status: 0` — recorded as
// "the request to the push service did not complete", which is false because
// no request was made — while this file's logging ran only AFTER the fetch, so
// the fault was written down nowhere at all. A deployment whose VAPID keys
// were removed while devices existed reported an ordinary transient failure
// forever. Same shape as the email arm's missing-key error one round earlier.

Deno.test("no VAPID configuration: classified, logged, and never fetched", async () => {
  const d = deps(() => new Response("", { status: 201 }), null);
  const { result, lines } = await captureErrors(() => d.push.sendPush(SUB, '{"title":"hi"}'));
  assertEquals(result, { status: 0, blocked: "not_configured" });
  assertEquals(d.calls, [], "attempted a request with no keys to sign it");
  assertEquals(lines.length, 1, `expected one log line: ${JSON.stringify(lines)}`);
  const entry = JSON.parse(lines[0]);
  assertEquals(entry.code, "push_not_configured");
  assertEquals(entry.context.subscription_id, "sub-1");
});

Deno.test("an unencryptable payload is its own class, not a transport failure", async () => {
  // Key material that will not import. Retryable at the row — a later
  // notification or a re-registered device fixes it — but it is not the
  // network, and recording it as the network is what hid it.
  const broken = { ...SUB, p256dh: "not-a-key" };
  const d = deps(() => new Response("", { status: 201 }));
  const { result, lines } = await captureErrors(() => d.push.sendPush(broken, '{"title":"hi"}'));
  assertEquals(result, { status: 0, blocked: "payload" });
  assertEquals(d.calls, [], "attempted a request with a body it could not build");
  assertEquals(JSON.parse(lines[0]).code, "push_payload");
});

Deno.test("the endpoint's path never reaches a pre-flight log line either", async () => {
  // The path segment is the device's bearer credential. The post-fetch line
  // already withholds it; these must too.
  const d = deps(() => new Response("", { status: 201 }), null);
  const { lines } = await captureErrors(() => d.push.sendPush(SUB, '{"title":"hi"}'));
  assertEquals(JSON.parse(lines[0]).context.endpoint_host, "fcm.googleapis.com");
  assert(!lines[0].includes("DEVICE-BEARER-TOKEN"), lines[0]);
});
