// The push arm's decision logic (review M27), driven through injected deps.
//
// What these pin is not "a push was attempted" but the four states and which
// of them are TERMINAL — the H17 lesson. A sweep that cannot tell "no devices"
// from "the service was briefly down" either retries somebody forever who
// never turned push on, or abandons a real failure.
import { assert, assertEquals, assertRejects } from "./asserts.ts";
import {
  deliverPush,
  isGoneStatus,
  isPermanentPushFailure,
  type PushableRow,
  type PushAttempt,
  type PushDeps,
  type PushSubscription,
  pushPayload,
  pushRecordPatch,
} from "../send-notification/push.ts";
import { isSettled, type Outcome } from "../send-notification/handler.ts";

/** A claim token as the RPC returns one: a uuid, not a timestamp. */
const PUSH_STAMP = "9c1e5b73-2d40-4f8a-b6e1-77a3c9d2e510";

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

/**
 * A subscription on a REAL push service host.
 *
 * These fixtures used to say `https://push.example/<id>`, and every one of
 * them went red the moment `deliverPush` started refusing endpoints that are
 * not push services (Codex review on PR #85) — correctly: they were the
 * arbitrary hosts the finding is about.
 */
function sub(id: string): PushSubscription {
  return { id, endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, p256dh: "p", auth: "a" };
}

/** A subscription pointing anywhere else. Nothing may POST to one of these. */
function foreignSub(id: string, endpoint = "https://internal.svc.local/admin"): PushSubscription {
  return { id, endpoint, p256dh: "p", auth: "a" };
}

interface Harness {
  deps: PushDeps;
  /** Make every dead-row delete fail, as a database blip would. */
  dropFails?: boolean;
  dropped: string[];
  failures: Array<{ id: string; error: string }>;
  recorded: Array<{ outcome: Outcome; attempts: number }>;
  sent: string[];
  released: Array<[string, string, string]>;
}

function harness(subs: PushSubscription[], reply: (s: PushSubscription) => PushAttempt | Error): Harness {
  const h: Harness = {
    dropped: [], failures: [], recorded: [], sent: [], released: [],
    deps: null as unknown as PushDeps,
  };
  h.deps = {
    releaseSend: (id, channel, stamp) => {
      h.released.push([id, channel, stamp]);
      return Promise.resolve();
    },
    // Defaults to WINNING the claim, so every existing case still
    // exercises the delivery path it was written for. The refusal is its
    // own test below — a default of `false` would make the whole file
    // pass by never sending anything.
    claimSend: () => Promise.resolve(PUSH_STAMP),
    getSubscriptions: () => Promise.resolve(subs),
    sendPush: (s) => {
      h.sent.push(s.id);
      const r = reply(s);
      if (r instanceof Error) return Promise.reject(r);
      return Promise.resolve(r);
    },
    dropSubscription: (id) => {
      h.dropped.push(id);
      return Promise.resolve(!h.dropFails);
    },
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
  const h = harness([sub("a"), sub("b")], (s) => (s.id === "a" ? { status: 201 } : { status: 500 }));
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

Deno.test("a SKIPPED push is terminal, and the drain must not resurrect it", async () => {
  // Codex review on PR #85, ninth round. `skipped` means "there was nothing to
  // deliver to and nothing about that will change" — but the guard tested only
  // `sent`, and the widened backlog selects a row when EITHER channel is owed.
  // So a notification whose push was skipped for want of a device and whose
  // EMAIL failed came back through the nightly drain, and if the recipient had
  // registered a device since, it pushed. "Your walk is complete" about a walk
  // two days ago, on a lock screen — the harm H17's backfill decision named,
  // arriving by a different route.
  const h = harness([sub("a")], () => ({ status: 201 }));
  const outcome = await deliverPush({ ...ROW, push_status: "skipped" }, h.deps);
  assertEquals(outcome, { kind: "skipped", reason: "already skipped" });
  assertEquals(h.sent, [], "a settled notification reached the push service");
  assertEquals(h.recorded, [], "and was re-recorded, overwriting its outcome");
});

Deno.test("only pending and failed are retryable — the backlog's own set", async () => {
  // The rule is the complement of `fn_notification_backlog`'s push predicate,
  // stated once so the two cannot drift the way the payment-status sets did.
  assertEquals([undefined, null, "pending", "failed"].map(isSettled), [false, false, false, false]);
  assertEquals(["sent", "skipped"].map(isSettled), [true, true]);
});

Deno.test("an endpoint that is not a push service is never contacted", async () => {
  // The SSRF (Codex review on PR #85). Registration accepted any https url
  // and this loop POSTed to it from the edge runtime, so any authenticated
  // caller could aim a server-side request wherever they liked and read the
  // outcome back off `notifications.push_last_error`.
  //
  // The assertion is on `h.sent` — that no REQUEST was made — rather than on
  // the outcome. A version that fetches and then classifies the answer is the
  // bug, however tidy its recorded result looks.
  const h = harness([foreignSub("evil")], () => ({ status: 200 }));
  const outcome = await deliverPush(ROW, h.deps);
  assertEquals(h.sent, [], "POSTed to an endpoint that is not a push service");
  assertEquals(h.dropped, ["evil"], "an endpoint nothing will ever send to must not be kept");
  assertEquals(outcome.kind, "skipped");
  assert(
    outcome.kind === "skipped" && outcome.reason.includes("not a push service"),
    `the skip must say why: ${JSON.stringify(outcome)}`,
  );
});

Deno.test("a refused endpoint does not stop the recipient's other devices", async () => {
  // Registering one fabricated endpoint must not cost somebody the push to
  // the phone in their hand — which is what treating the refusal as a hard
  // failure of the whole notification would do.
  const h = harness([foreignSub("evil"), sub("phone")], () => ({ status: 201 }));
  const outcome = await deliverPush(ROW, h.deps);
  assertEquals(h.sent, ["phone"]);
  assertEquals(h.dropped, ["evil"]);
  assertEquals(outcome.kind, "sent");
});

Deno.test("userinfo does not smuggle an allowlisted host past the check", async () => {
  // `https://fcm.googleapis.com@internal.svc.local/` reads to a skimming
  // human as a Google endpoint and resolves to a host of `internal.svc.local`.
  const h = harness(
    [foreignSub("smuggled", "https://fcm.googleapis.com@internal.svc.local/x")],
    () => ({ status: 200 }),
  );
  await deliverPush(ROW, h.deps);
  assertEquals(h.sent, [], "userinfo defeated the host check");
});

Deno.test("what a failure RECORDS is ours, never the push service's words", async () => {
  // `notifications.push_last_error` is selectable by `authenticated`, and
  // `push_subscriptions.last_error` carries the same string. H14's rule is
  // that the client sees our message and the underlying system's words stay
  // on the server; the body used to travel all the way into both columns,
  // which with an attacker-chosen endpoint made it an exfiltration channel.
  const h = harness([sub("a")], () => ({ status: 500 }));
  const outcome = await deliverPush(ROW, h.deps);
  assertEquals(h.failures, [{ id: "a", error: "the push service answered 500" }]);
  assert(outcome.kind === "failed" && outcome.error === "the push service answered 500", "the recorded outcome must say the same");
});

Deno.test("a transport error records a classification, not the exception text", async () => {
  // A rejected fetch carries the URL and the underlying network condition in
  // its message. The endpoint's path segment is the device's bearer
  // credential, so that string is exactly the one not to persist.
  const h = harness([sub("a")], () => new Error("error sending request for url (https://fcm.googleapis.com/fcm/send/SECRET-TOKEN)"));
  const outcome = await deliverPush(ROW, h.deps);
  assertEquals(h.failures, [{ id: "a", error: "the request to the push service did not complete" }]);
  assert(
    outcome.kind === "failed" && !outcome.error.includes("SECRET-TOKEN"),
    "the endpoint's token reached a recorded column",
  );
});

Deno.test("a redirect is a failure, never a delivery", async () => {
  // Measured rather than assumed: with `redirect: "manual"` Deno hands back
  // the real 3xx (status 302, type "basic", ok false) and does NOT make the
  // second request — it neither throws nor returns an opaque status 0. So the
  // 3xx arrives here as an ordinary non-2xx and must not be read as success.
  //
  // Left RETRYABLE deliberately: a push service that redirects is either
  // misconfigured or is not the push service, and neither is something this
  // code can tell apart from a failover. The backlog's attempt ceiling is
  // what ends it, rather than a rule invented for a case nobody has seen.
  const h = harness([sub("a")], () => ({ status: 302 }));
  const outcome = await deliverPush(ROW, h.deps);
  assertEquals(outcome.kind, "failed");
  assert(outcome.kind === "failed" && !outcome.permanent, "a 3xx is not classed permanent");
  assertEquals(h.dropped, [], "a redirect must not delete a registration");
});

Deno.test("a failed dead-row delete does not abandon the rest of the fanout", async () => {
  // Codex review on PR #85, tenth round. `dropSubscription` used to THROW on a
  // database error, which rejected `deliverPush` mid-loop: the recipient's
  // remaining healthy devices were never tried, no outcome was recorded at
  // all, and a device that had already accepted the push received it again
  // when the still-pending row came back through the drain. A blip on one dead
  // row is not a reason to drop a live notification.
  const h = harness(
    [sub("dead"), sub("phone")],
    (x) => (x.id === "dead" ? { status: 410 } : { status: 201 }),
  );
  h.dropFails = true;
  const outcome = await deliverPush(ROW, h.deps);
  assertEquals(h.sent, ["dead", "phone"], "the fanout stopped at the failed delete");
  assertEquals(outcome.kind, "sent", "a device accepted it, so the person WAS told");
  assertEquals(h.recorded.length, 1, "no aggregate outcome was recorded");
});

Deno.test("a dead row that survives its delete keeps the push retryable", async () => {
  // The other half, and it is round five's finding restated: counting the
  // device as `gone` when the row is still there lets the aggregate resolve to
  // the TERMINAL `skipped` over an endpoint every future notification will
  // POST to again.
  const h = harness([sub("dead")], () => ({ status: 410 }));
  h.dropFails = true;
  const outcome = await deliverPush(ROW, h.deps);
  assertEquals(outcome.kind, "failed", `expected retryable, got ${JSON.stringify(outcome)}`);
  assert(outcome.kind === "failed" && !outcome.permanent, "and not permanent");

  // With the delete succeeding it IS terminal, so the rule is not just
  // "always retry".
  const ok = harness([sub("dead")], () => ({ status: 410 }));
  const settled = await deliverPush(ROW, ok.deps);
  assertEquals(settled.kind, "skipped");
});

Deno.test("a blocked attempt says what blocked it, and stays retryable", async () => {
  // "the request to the push service did not complete" is false when no
  // request was made, and it is the sentence that hid a missing VAPID key
  // behind an ordinary network blip.
  const h = harness([sub("a")], () => ({ status: 0, blocked: "not_configured" as const }));
  const outcome = await deliverPush(ROW, h.deps);
  assertEquals(h.failures, [
    { id: "a", error: "push delivery is not configured for this deployment" },
  ]);
  assert(outcome.kind === "failed" && !outcome.permanent, "a restored key must be able to fix it");

  const enc = harness([sub("a")], () => ({ status: 0, blocked: "payload" as const }));
  await deliverPush(ROW, enc.deps);
  assertEquals(enc.failures, [
    { id: "a", error: "this notification could not be encrypted for that device" },
  ]);

  // And a genuine transport failure keeps the sentence that IS true of it.
  const net = harness([sub("a")], () => ({ status: 0, blocked: "transport" as const }));
  await deliverPush(ROW, net.deps);
  assertEquals(net.failures, [
    { id: "a", error: "the request to the push service did not complete" },
  ]);
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
    // 0051: recording an outcome releases the claim, token and all. Asserted
    // exhaustively in "push: recording an outcome RELEASES the claim" below.
    push_claimed_at: null,
    push_claim_token: null,
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
    claimSend: () => Promise.resolve(PUSH_STAMP),
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
    claimSend: () => Promise.resolve(PUSH_STAMP),
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

Deno.test("the payload is clamped so one record can always frame it", async () => {
  // `title` and `body` are unconstrained text and operator notifications embed
  // a client's name, so nothing upstream bounds them. Over the declared record
  // size the framing contradicts its own header: the service rejects it, or
  // the browser cannot decrypt. A truncated sentence on a lock screen beats a
  // notification that does not arrive.
  const { encryptPushPayload } = await import("../_lib/webpush.ts");
  const huge = { ...ROW, title: "T".repeat(5000), body: "B".repeat(20000) };
  const payload = pushPayload(huge);
  assert(payload.length < 1000, `payload is ${payload.length} bytes`);
  const parsed = JSON.parse(payload);
  assert(parsed.title.endsWith("…"), "a clamped title should say it was clamped");
  assert(parsed.body.endsWith("…"));
  // And it genuinely encrypts, which is the property the clamp exists for.
  const body = await encryptPushPayload(payload, {
    p256dh: "BDgBTGA8idqXEkJjIO5TqUx5Xdo7kLtbB5Guj120hrfbJeOqNo7eN7llZvZlkPieoqyDS81hVBuQc4y8gpRwbJY",
    auth: "ZmVkY2JhOTg3NjU0MzIxMA",
  });
  assert(body.length > 86);
});

Deno.test("push: losing the claim race POSTs nothing and records nothing", async () => {
  // The SIBLING call site. The email arm's test proves the email arm; a rule
  // applied to one and not the other is the shape this repository keeps
  // recording, so the push arm gets its own.
  //
  // A duplicate push is less damaging than a duplicate email — the worker tags
  // by notification id, so two deliveries collapse into one lock-screen entry
  // — but the fanout still POSTs every device again, and the loser must not
  // write an outcome over the winner's.
  const h = harness([sub("a"), sub("b")], () => ({ status: 201 }));
  h.deps.claimSend = () => Promise.resolve(null);

  const outcome = await deliverPush(ROW, h.deps);

  assertEquals(outcome.kind, "skipped");
  assertEquals(h.sent.length, 0, "the loser POSTed to devices anyway");
  assertEquals(h.recorded.length, 0, "the loser wrote an outcome over the winner's");
});

Deno.test("push: winning the claim still delivers", async () => {
  // Without this, a claim wired to refuse everything would pass the test above
  // while push never worked again.
  const h = harness([sub("a")], () => ({ status: 201 }));
  h.deps.claimSend = () => Promise.resolve(PUSH_STAMP);

  const outcome = await deliverPush(ROW, h.deps);

  assertEquals(outcome.kind, "sent");
  assertEquals(h.sent.length, 1);
});

Deno.test("push: recording an outcome RELEASES the claim, on every kind", () => {
  // The sibling of the email rule, tested rather than assumed — a rule applied
  // to one arm and not the other is the shape this repository keeps recording.
  for (const outcome of [
    { kind: "sent" } as const,
    { kind: "skipped", reason: "no registered devices" } as const,
    { kind: "failed", error: "503", permanent: false } as const,
  ]) {
    const patch = pushRecordPatch(outcome, 1);
    assertEquals(patch.push_claimed_at, null, `${outcome.kind} kept the push claim`);
    assertEquals(patch.push_claim_token, null, `${outcome.kind} kept the push token`);
  }
});

Deno.test("push: the claim names the PUSH channel, and is taken before any skip", async () => {
  // Nothing pinned the argument, so the whole suite stayed green with
  // `deliverPush` claiming "email": every test above wires claimSend to a
  // constant and never looks at what it was asked for. That mistake would
  // wire the two arms to one claim — a row already being emailed would refuse
  // push and vice versa, and each arm's send-once guard would be answering
  // about the other channel's sender.
  const asked: Array<[string, string]> = [];
  const h = harness([], () => ({ status: 201 })); // no devices: a terminal skip
  h.deps.claimSend = (id, channel) => {
    asked.push([id, channel]);
    return Promise.resolve(null);
  };

  const outcome = await deliverPush(ROW, h.deps);

  assertEquals(asked.length, 1, "the terminal path skipped the claim entirely");
  assertEquals(asked[0]?.[0], ROW.id);
  assertEquals(asked[0]?.[1], "push");
  assertEquals(outcome.kind, "skipped");
  assertEquals(h.recorded.length, 0, "recorded a terminal outcome without holding the claim");
});

Deno.test("push: a pre-send throw releases the push claim", async () => {
  // The sibling Codex named on PR #86, and the reason to look at it every time
  // rather than only at the site the reviewer points to: `getSubscriptions`
  // throws AFTER the claim, so the row keeps it and the drain's re-read hides
  // it for the lease — the email arm's defect, one function over.
  const h = harness([], () => ({ status: 201 }));
  h.deps.getSubscriptions = () => Promise.reject(new Error("statement timeout"));

  const err = await assertRejects(
    () => deliverPush(ROW, h.deps),
    "a failed subscription lookup must still throw",
  );
  assert(/statement timeout/.test(err.message), `unexpected error: ${err.message}`);

  assertEquals(h.recorded.length, 0, "a throw must not settle the row");
  assertEquals(h.released, [[ROW.id, "push", PUSH_STAMP]], "the claim outlived the sender");
});

Deno.test("push: a recorded outcome does NOT double-release", async () => {
  const h = harness([sub("a")], () => ({ status: 201 }));

  const outcome = await deliverPush(ROW, h.deps);

  assertEquals(outcome.kind, "sent");
  assertEquals(h.released.length, 0, "released a claim the outcome had already cleared");
});

Deno.test("push: a failing release does not mask the original error", async () => {
  const h = harness([], () => ({ status: 201 }));
  h.deps.getSubscriptions = () => Promise.reject(new Error("statement timeout"));
  h.deps.releaseSend = () => Promise.reject(new Error("db unreachable"));

  const err = await assertRejects(() => deliverPush(ROW, h.deps), "must still throw");
  assert(
    !err.message.includes("db unreachable"),
    "the release's own failure replaced the lookup error",
  );
});
