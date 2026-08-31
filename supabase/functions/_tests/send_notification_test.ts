// Email delivery outcomes (review H17).
//
// The defect was that nothing recorded what happened: a Resend outage lost the
// email permanently and the row looked identical to a delivered one, while the
// in-app bell still showed it — so the system looked healthy from the inside
// with the outside channel dead. These types include payment_failed and
// walk_cancelled, so "we think it sends" is not good enough.
//
// This suite exists because the branching added to fix that had no coverage
// at all, which is the same shape as the original defect.
import { assert, assertEquals, assertFalse } from "./asserts.ts";
import {
  deliverNotification,
  drainBacklog,
  failureResponse,
  isPermanentSendFailure,
  type NotificationRow,
  type Outcome,
  recordPatch,
  type SendDeps,
} from "../send-notification/handler.ts";

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

interface Opts {
  email?: string | null;
  /** Review M29: this address has opted out. */
  suppressed?: boolean;
  /** The suppression list itself is unreadable. */
  suppressionError?: boolean;
  send?: () => Promise<{ ok: true } | { ok: false; status: number; detail: string }>;
  backlog?: string[];
  rows?: Record<string, NotificationRow | null>;
}

function makeDeps(opts: Opts = {}) {
  const recorded: Array<{ id: string; outcome: Outcome; previousAttempts: number }> = [];
  const sentTo: string[] = [];
  const sentHeaders: Array<Record<string, string>> = [];
  const suppressionAsked: Array<[string, string, string]> = [];
  const deps: SendDeps = {
    getNotification: (id) => Promise.resolve(opts.rows ? (opts.rows[id] ?? null) : ROW),
    backlogIds: () => Promise.resolve(opts.backlog ?? []),
    getClient: () =>
      Promise.resolve({
        full_name: "Ada",
        email: opts.email === undefined ? "ada@example.test" : opts.email,
        unsubscribe_token: "11111111-2222-4333-8444-555555555555",
      }),
    isSuppressed: (email, operatorId, type) => {
      suppressionAsked.push([email, operatorId, type]);
      if (opts.suppressionError) return Promise.reject(new Error("suppression lookup failed"));
      return Promise.resolve(opts.suppressed === true);
    },
    unsubscribeUrl: (token) => `https://fn.test/functions/v1/unsubscribe?t=${token}`,
    getOperator: () => Promise.resolve({ business_name: "Old Town Walks" }),
    sendEmail: (msg) => {
      sentTo.push(msg.to);
      sentHeaders.push(msg.headers);
      return opts.send ? opts.send() : Promise.resolve({ ok: true as const });
    },
    record: (id, outcome, previousAttempts) => {
      recorded.push({ id, outcome, previousAttempts });
      return Promise.resolve();
    },
    renderEmail: (b, t, _body, url) => `<p>${b}: ${t} <a href="${url}">Unsubscribe</a></p>`,
  };
  return { deps, recorded, sentTo, sentHeaders, suppressionAsked };
}

// ── every path records something ───────────────────────────────────────────

Deno.test("a delivered email is recorded as sent", async () => {
  const { deps, recorded, sentTo } = makeDeps();
  const outcome = await deliverNotification(ROW, deps);
  assertEquals(outcome.kind, "sent");
  assertEquals(sentTo, ["ada@example.test"]);
  assertEquals(recorded.length, 1);
  assertEquals(recorded[0].outcome.kind, "sent");
});

Deno.test("a provider rejection is recorded, not lost", async () => {
  // The whole defect. The DB webhook does not retry on a non-2xx, so if the row
  // is not stamped here the email is gone and nothing anywhere says so.
  const { deps, recorded } = makeDeps({
    send: () => Promise.resolve({ ok: false as const, status: 500, detail: "upstream boom" }),
  });
  const outcome = await deliverNotification(ROW, deps);
  assertEquals(outcome.kind, "failed");
  assertEquals(recorded.length, 1, "a failure must still be recorded");
  const rec = recorded[0].outcome as Extract<Outcome, { kind: "failed" }>;
  assert(rec.error.includes("500"), rec.error);
  assert(rec.error.includes("upstream boom"), "the provider's own words are the diagnosis");
});

Deno.test("an unreachable provider is recorded as retryable", async () => {
  // Before this it threw out of the handler and the webhook forgot the email
  // had ever been owed.
  const { deps, recorded } = makeDeps({
    send: () => Promise.reject(new Error("dns failure")),
  });
  const outcome = await deliverNotification(ROW, deps);
  assertEquals(outcome.kind, "failed");
  const rec = recorded[0].outcome as Extract<Outcome, { kind: "failed" }>;
  assertFalse(rec.permanent, "a network failure may succeed tomorrow");
  assert(rec.error.includes("dns failure"));
});

Deno.test("an operator-only notification is SKIPPED, never left pending", async () => {
  // Terminal on purpose: there is no client to email and nothing will change.
  // Leaving it un-stamped would retry it every night for the rest of time.
  const { deps, recorded, sentTo } = makeDeps();
  const outcome = await deliverNotification({ ...ROW, client_id: null }, deps);
  assertEquals(outcome.kind, "skipped");
  assertEquals(sentTo.length, 0);
  assertEquals(recorded[0].outcome.kind, "skipped");
});

Deno.test("a non-client-facing type is skipped even with a client", async () => {
  const { deps, sentTo } = makeDeps();
  const outcome = await deliverNotification({ ...ROW, type: "subscription_cancelled" }, deps);
  assertEquals(outcome.kind, "skipped");
  assertEquals(sentTo.length, 0);
});

Deno.test("a client with no email address is skipped, with the reason on the row", async () => {
  const { deps, recorded, sentTo } = makeDeps({ email: null });
  const outcome = await deliverNotification(ROW, deps);
  assertEquals(outcome.kind, "skipped");
  assertEquals(sentTo.length, 0);
  const rec = recorded[0].outcome as Extract<Outcome, { kind: "skipped" }>;
  assert(rec.reason.includes("no email"), rec.reason);
});

// ── permanent vs transient ────────────────────────────────────────────────

Deno.test("a 4xx is permanent — our request is wrong and will be tomorrow too", () => {
  // Unverified sending domain, invalid recipient.
  assert(isPermanentSendFailure(422));
  assert(isPermanentSendFailure(403));
  assert(isPermanentSendFailure(400));
});

Deno.test("429 and 5xx are NOT permanent", () => {
  // Rate limited, or the provider is having a bad afternoon. Retrying is the
  // whole point of recording these.
  assertFalse(isPermanentSendFailure(429), "a rate limit clears");
  assertFalse(isPermanentSendFailure(500));
  assertFalse(isPermanentSendFailure(503));
});

// ── the column patch ──────────────────────────────────────────────────────

Deno.test("a skip does NOT increment the attempt count", () => {
  // A skip is a decision, not a try. Counting it would march terminal rows
  // toward the give-up ceiling in 0029 for no reason, and make the census of
  // "how many times did we actually try" a lie.
  const patch = recordPatch({ kind: "skipped", reason: "no email" }, 0);
  assertFalse("email_attempts" in patch, "a skip moved the attempt count");
  assertEquals(patch.email_status, "skipped");
});

Deno.test("a failure increments attempts — that is what bounds the retrying", () => {
  const patch = recordPatch({ kind: "failed", error: "resend 500", permanent: false }, 2);
  assertEquals(patch.email_attempts, 3);
  assertEquals(patch.email_status, "failed");
});

Deno.test("a send clears the previous error", () => {
  // A row that failed twice and then succeeded must not keep reading as broken.
  const patch = recordPatch({ kind: "sent" }, 2);
  assertEquals(patch.email_status, "sent");
  assertEquals(patch.email_attempts, 3);
  assertEquals(patch.email_last_error, null);
  assert(typeof patch.email_sent_at === "string");
});

Deno.test("a recorded error is bounded", () => {
  const patch = recordPatch({ kind: "failed", error: "x".repeat(4000), permanent: true }, 0);
  assert((patch.email_last_error as string).length <= 500);
});

// ── draining the backlog ──────────────────────────────────────────────────

Deno.test("a drain carries on past a failure", () => {
  // One bad recipient must not strand the rest of the backlog, which is what a
  // throw-on-first-error loop would do — and the backlog is exactly the set of
  // emails somebody is already owed.
  const rows: Record<string, NotificationRow> = {
    "a": { ...ROW, id: "a" },
    "b": { ...ROW, id: "b" },
    "c": { ...ROW, id: "c" },
  };
  let call = 0;
  const { deps, recorded } = makeDeps({
    backlog: ["a", "b", "c"],
    rows,
    send: () => {
      call += 1;
      return call === 2
        ? Promise.resolve({ ok: false as const, status: 500, detail: "boom" })
        : Promise.resolve({ ok: true as const });
    },
  });
  return drainBacklog(deps).then((res) => {
    assertEquals(res.drained, 3, "all three were attempted");
    assertEquals(res.sent, 2);
    assertEquals(res.failed, 1);
    assertEquals(recorded.length, 3, "every row recorded an outcome");
  });
});

Deno.test("a row deleted between the count and the send is skipped, not fatal", async () => {
  const { deps } = makeDeps({ backlog: ["gone"], rows: { gone: null } });
  const res = await drainBacklog(deps);
  assertEquals(res.drained, 1);
  assertEquals(res.sent, 0);
  assertEquals(res.failed, 0);
});

Deno.test("an empty backlog is a no-op", async () => {
  const { deps, sentTo } = makeDeps({ backlog: [] });
  assertEquals(await drainBacklog(deps), {
    drained: 0,
    sent: 0,
    failed: 0,
    pushSent: 0,
    pushFailed: 0,
  });
  assertEquals(sentTo.length, 0);
});

// ── what the caller of a single send sees ─────────────────────────────────

Deno.test("a single-notification failure surfaces as a 502 naming the row", async () => {
  // The 502 is what tells the webhook, and an operator retrying by hand, that
  // something is wrong. The row already carries the detail.
  const { deps } = makeDeps({
    send: () => Promise.resolve({ ok: false as const, status: 422, detail: "domain not verified" }),
  });
  const outcome = await deliverNotification(ROW, deps);
  const err = failureResponse(ROW, outcome);
  assertEquals(err.status, 502);
  assertEquals(err.code, "email_failed");
  assertEquals(err.context?.notification_id, "n-1");
  assertEquals(err.context?.permanent, true);
  // The client-facing message stays ours; the provider's words are the cause.
  assertEquals(err.message, "email provider rejected the message");
  assert(String(err.cause).includes("domain not verified"));
});

// ── send-once, and the tenant scope (review M1) ────────────────────────────

Deno.test("a notification already recorded as sent is not sent again", async () => {
  const { deps, sentTo, recorded } = makeDeps();
  const outcome = await deliverNotification(
    { ...ROW, email_status: "sent" },
    deps,
  );
  assertEquals(outcome.kind, "skipped");
  // The endpoint accepts a notification_id directly, so without this an
  // operator could POST the same id in a loop and mail-bomb their client.
  assertEquals(sentTo.length, 0);
  // And it writes nothing: re-recording would move email_sent_at forward and
  // make a delivered notification look like it had just been delivered again.
  assertEquals(recorded.length, 0);
});

Deno.test("a FAILED attempt stays retryable — send-once is not attempt-once", async () => {
  const { deps, sentTo } = makeDeps();
  // The distinction the guard has to preserve: 0029's whole backlog exists so
  // a failure is retried. Only a recorded `sent` is terminal.
  const outcome = await deliverNotification(
    { ...ROW, email_status: "failed", email_attempts: 2 },
    deps,
  );
  assertEquals(outcome.kind, "sent");
  assertEquals(sentTo, ["ada@example.test"]);
});

Deno.test("a pending notification sends normally", async () => {
  const { deps, sentTo } = makeDeps();
  const outcome = await deliverNotification({ ...ROW, email_status: "pending" }, deps);
  assertEquals(outcome.kind, "sent");
  assertEquals(sentTo.length, 1);
});

// ── review M29: consent, and a way out ─────────────────────────────────────
//
// `clients.email` is typed by the operator into the Roster form and reconciled
// with nothing, so one typo sends a stranger a recurring feed of when a named
// person's house is empty — with no unsubscribe link, no List-Unsubscribe
// header, and no consent record anywhere.

Deno.test("an unsubscribed address is not emailed", async () => {
  const { deps, recorded, sentTo } = makeDeps({ suppressed: true });
  const outcome = await deliverNotification(ROW, deps);
  assertEquals(outcome.kind, "skipped");
  assertEquals(sentTo.length, 0);
  assertEquals(recorded[0].outcome.kind, "skipped");
});

Deno.test("an unsubscribe is TERMINAL, not a retryable failure", async () => {
  // The distinction 0029 turns on. Recorded as `failed`, the nightly drain
  // would try this every night against somebody who explicitly asked us to
  // stop — worse than the defect being fixed.
  const { deps, recorded } = makeDeps({ suppressed: true });
  await deliverNotification(ROW, deps);
  const outcome = recorded[0].outcome;
  assert(outcome.kind === "skipped");
  assert(outcome.reason.includes("unsubscribed"));
});

Deno.test("suppression is asked about the ADDRESS, with the operator and type", async () => {
  // Keyed on the address rather than the client: the wrong recipient of a
  // mistyped address has no client row of their own, so suppressing "this
  // client" would let the same person start receiving again the moment the
  // operator corrects and re-enters it.
  const { deps, suppressionAsked } = makeDeps();
  await deliverNotification(ROW, deps);
  assertEquals(suppressionAsked.length, 1);
  assertEquals(suppressionAsked[0][0], "ada@example.test");
  assertEquals(suppressionAsked[0][1], "op-1");
  assertEquals(suppressionAsked[0][2], "payment_failed");
});

Deno.test("an unreadable suppression list fails CLOSED", async () => {
  // We do not know whether this person asked us to stop, and sending anyway is
  // the one outcome that cannot be taken back. The row records it and the
  // nightly drain retries — which is exactly what a retryable failure is for.
  const { deps, recorded, sentTo } = makeDeps({ suppressionError: true });
  const outcome = await deliverNotification(ROW, deps);
  assertEquals(sentTo.length, 0);
  assertEquals(outcome.kind, "failed");
  assert(recorded[0].outcome.kind === "failed");
  assertFalse(recorded[0].outcome.permanent);
});

Deno.test("every email carries the one-click unsubscribe pair", async () => {
  // Both headers, not just the URL: `List-Unsubscribe-Post` is what makes a
  // mail client show its own one-click control rather than making the
  // recipient hunt for the link in the body. Every operator sends from ONE
  // shared identity, so the sending reputation is the platform's, aggregated.
  const { deps, sentHeaders } = makeDeps();
  await deliverNotification(ROW, deps);
  assertEquals(sentHeaders.length, 1);
  assertEquals(
    sentHeaders[0]["List-Unsubscribe"],
    "<https://fn.test/functions/v1/unsubscribe?t=11111111-2222-4333-8444-555555555555>",
  );
  assertEquals(sentHeaders[0]["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
});
