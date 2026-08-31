// The push arm's decision logic (review M27), driven through injected deps.
//
// What these pin is not "a push was attempted" but the four states and which
// of them are TERMINAL — the H17 lesson. A sweep that cannot tell "no devices"
// from "the service was briefly down" either retries somebody forever who
// never turned push on, or abandons a real failure.
import { assert, assertEquals } from "./asserts.ts";
import {
  deliverPush,
  isGoneStatus,
  isPermanentPushFailure,
  type PushableRow,
  type PushDeps,
  type PushSubscription,
  pushPayload,
  pushRecordPatch,
} from "../send-notification/push.ts";
import type { Outcome } from "../send-notification/handler.ts";

const ROW: PushableRow = {
  id: "n1",
  operator_id: "op1",
  client_id: "cl1",
  type: "walk_complete",
  title: "Walk complete",
  body: "Luna had a great walk.",
  walk_id: "w1",
  push_attempts: 0,
  push_status: "pending",
};

function sub(id: string): PushSubscription {
  return { id, endpoint: `https://push.example/${id}`, p256dh: "p", auth: "a" };
}

interface Harness {
  deps: PushDeps;
  dropped: string[];
  failures: Array<{ id: string; error: string }>;
  recorded: Array<{ outcome: Outcome; attempts: number }>;
  sent: string[];
}

function harness(subs: PushSubscription[], reply: (s: PushSubscription) => { status: number; detail?: string } | Error): Harness {
  const h: Harness = { dropped: [], failures: [], recorded: [], sent: [], deps: null as unknown as PushDeps };
  h.deps = {
    getSubscriptions: () => Promise.resolve(subs),
    sendPush: (s) => {
      h.sent.push(s.id);
      const r = reply(s);
      if (r instanceof Error) return Promise.reject(r);
      return Promise.resolve(r);
    },
    dropSubscription: (id) => { h.dropped.push(id); return Promise.resolve(); },
    noteFailure: (id, error) => { h.failures.push({ id, error }); return Promise.resolve(); },
    recordPush: (_id, outcome, attempts) => { h.recorded.push({ outcome, attempts }); return Promise.resolve(); },
  };
  return h;
}

Deno.test("no registered devices is TERMINAL, not a failure to retry nightly", async () => {
  const h = harness([], () => ({ status: 201 }));
  const outcome = await deliverPush(ROW, h.deps);
  assertEquals(outcome, { kind: "skipped", reason: "no registered devices" });
  assertEquals(h.sent, []);
  assertEquals(h.recorded.length, 1);
});

Deno.test("one device accepting means the person was told, even if others fail", async () => {
  // The aggregate rule. Recording `failed` because device 2 of 3 was
  // unreachable would put a notification the person already received back into the
  // backlog, and they would get it again tomorrow.
  const h = harness([sub("a"), sub("b")], (s) => (s.id === "a" ? { status: 201 } : { status: 500, detail: "boom" }));
  const outcome = await deliverPush(ROW, h.deps);
  assertEquals(outcome.kind, "sent");
  assertEquals(h.failures.map((f) => f.id), ["b"], "the unhealthy device is still noted");
  assertEquals(h.dropped, [], "a 500 must never drop a registration");
});

Deno.test("410 Gone deletes the registration; 500 keeps it", async () => {
  // A 410 is the push service saying the browser forgot this subscription —
  // permanent, and the row holds an endpoint identifying a browser, so it goes
  // rather than becoming a tombstone. A 500 is a bad moment.
  const h = harness([sub("dead"), sub("flaky")], (s) => (s.id === "dead" ? { status: 410 } : { status: 503 }));
  const outcome = await deliverPush(ROW, h.deps);
  assertEquals(h.dropped, ["dead"]);
  assertEquals(h.failures.map((f) => f.id), ["flaky"]);
  assertEquals(outcome.kind, "failed");
  assert(outcome.kind === "failed" && !outcome.permanent, "a 503 is retryable");
});

Deno.test("every device gone resolves to skipped, not failed", async () => {
  // After dropping them the recipient has no devices, so a retry would find
  // nothing and record `skipped` anyway. Saying it now is the same true thing,
  // one night earlier, and keeps the backlog honest.
  const h = harness([sub("a"), sub("b")], () => ({ status: 410 }));
  const outcome = await deliverPush(ROW, h.deps);
  assertEquals(h.dropped, ["a", "b"]);
  assertEquals(outcome, { kind: "skipped", reason: "every registered device was gone" });
});

Deno.test("a thrown transport error is never read as 'this device is gone'", async () => {
  // A rejected fetch is not a verdict from the push service. Treating it as
  // one would delete a perfectly good registration because the network blinked
  // — the M7 counting rule, one layer up.
  const h = harness([sub("a")], () => new Error("connection reset"));
  const outcome = await deliverPush(ROW, h.deps);
  assertEquals(h.dropped, []);
  assertEquals(outcome.kind, "failed");
  assert(outcome.kind === "failed" && !outcome.permanent);
});

Deno.test("a row already sent is not pushed again", async () => {
  const h = harness([sub("a")], () => ({ status: 201 }));
  const outcome = await deliverPush({ ...ROW, push_status: "sent" }, h.deps);
  assertEquals(outcome, { kind: "skipped", reason: "already sent" });
  assertEquals(h.sent, [], "a sent row must not reach the push service at all");
  assertEquals(h.recorded, [], "and must not be re-recorded");
});

Deno.test("a FAILED row stays retryable — attempts alone are not terminal", async () => {
  const h = harness([sub("a")], () => ({ status: 201 }));
  const outcome = await deliverPush({ ...ROW, push_status: "failed", push_attempts: 3 }, h.deps);
  assertEquals(outcome.kind, "sent");
  assertEquals(h.recorded[0].attempts, 3);
});

Deno.test("the payload carries a deep link and nothing sensitive", async () => {
  // It lands on a LOCK SCREEN. 0038 already removed a credit balance from a
  // notification body for the same reason.
  const client = JSON.parse(pushPayload(ROW));
  assertEquals(client.url, "/portal/walks/w1");
  assertEquals(client.title, "Walk complete");
  // Tagged by ROW, not by type: two distinct walk_complete events must not
  // collapse into one tray entry, or the second silently replaces the first
  // and nobody learns the first existed.
  assertEquals(client.tag, ROW.id);
  const other = JSON.parse(pushPayload({ ...ROW, id: "n2" }));
  assert(other.tag !== client.tag, "two distinct notifications share a tag");
  const operator = JSON.parse(pushPayload({ ...ROW, client_id: null }));
  assertEquals(operator.url, "/calendar", "an operator has no portal route");
  const noWalk = JSON.parse(pushPayload({ ...ROW, walk_id: null }));
  assertEquals(noWalk.url, "/portal");
});

Deno.test("the record patch mirrors the email arm's rules", () => {
  assertEquals(pushRecordPatch({ kind: "skipped", reason: "no registered devices" }, 2), {
    push_status: "skipped",
    push_last_error: "no registered devices",
  });
  const failed = pushRecordPatch({ kind: "failed", error: "503", permanent: false }, 2);
  assertEquals(failed.push_attempts, 3, "a real attempt counts");
  const sent = pushRecordPatch({ kind: "sent" }, 2);
  assertEquals(sent.push_attempts, 3);
  assertEquals(sent.push_last_error, null);
});

Deno.test("status classification", () => {
  assertEquals([404, 410].map(isGoneStatus), [true, true]);
  assertEquals([413, 429, 500, 503].map(isGoneStatus), [false, false, false, false]);
  assertEquals(isPermanentPushFailure(413), true, "our payload is too big — retrying cannot help");
  assertEquals(isPermanentPushFailure(429), false, "rate limited is a bad moment");
  assertEquals(isPermanentPushFailure(503), false);
});

// ── Codex review on PR #85 ───────────────────────────────────────────────

Deno.test("the drain delivers BOTH channels, and each stays send-once", async () => {
  // The backlog now selects a row owed EITHER channel, so a row picked up
  // because its push failed must not re-email — and vice versa. The drain does
  // not know which one put the row there, and does not need to.
  const { drainBacklog } = await import("../send-notification/handler.ts");
  const row = {
    id: "n1",
    operator_id: "op1",
    client_id: "cl1",
    type: "walk_complete",
    title: "t",
    body: "b",
    walk_id: null,
    email_attempts: 1,
    email_status: "sent", // already emailed; only the push is owed
    push_attempts: 1,
    push_status: "failed",
  };
  const pushed: string[] = [];
  const emailed: string[] = [];
  const deps = {
    getNotification: () => Promise.resolve(row),
    backlogIds: () => Promise.resolve(["n1"]),
    getClient: () => Promise.resolve({ full_name: "x", email: "a@b.test", unsubscribe_token: "t" }),
    isSuppressed: () => Promise.resolve(false),
    getOperator: () => Promise.resolve({ business_name: "B" }),
    sendEmail: () => {
      emailed.push("n1");
      return Promise.resolve({ ok: true } as const);
    },
    record: () => Promise.resolve(),
    renderEmail: () => "<html></html>",
    unsubscribeUrl: () => "https://x",
  };
  const result = await drainBacklog(deps as never, (r) => {
    pushed.push(r.id);
    return Promise.resolve({ kind: "sent" as const });
  });
  assertEquals(pushed, ["n1"], "the drain did not retry the failed push");
  assertEquals(emailed, [], "a row owed only a push was emailed again");
  assertEquals(result.pushSent, 1);
});

Deno.test("a push failure in the drain never strands the rest of the backlog", async () => {
  // One bad row must not throw the sweep. Same rule the email arm already has.
  const { drainBacklog } = await import("../send-notification/handler.ts");
  const rows: Record<string, unknown> = {
    a: { id: "a", operator_id: "o", client_id: null, type: "t", title: "x", body: null, walk_id: null, email_attempts: 0, push_attempts: 0 },
    b: { id: "b", operator_id: "o", client_id: null, type: "t", title: "x", body: null, walk_id: null, email_attempts: 0, push_attempts: 0 },
  };
  const seen: string[] = [];
  const deps = {
    getNotification: (id: string) => Promise.resolve(rows[id]),
    backlogIds: () => Promise.resolve(["a", "b"]),
    record: () => Promise.resolve(),
  };
  const result = await drainBacklog(deps as never, (r) => {
    seen.push(r.id);
    if (r.id === "a") return Promise.reject(new Error("db blip"));
    return Promise.resolve({ kind: "sent" as const });
  });
  assertEquals(seen, ["a", "b"], "the sweep stopped at the first push failure");
  assertEquals(result.pushFailed, 1);
  assertEquals(result.pushSent, 1);
});
