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
import { assert, assertEquals, assertFalse, assertRejects } from "./asserts.ts";
import { HttpError } from "../_lib/http.ts";
import {
  claimNotificationSend,
  deliverNotification,
  drainBacklog,
  failureResponse,
  isPermanentSendFailure,
  type NotificationRow,
  type Outcome,
  recordPatch,
  type SendDeps,
} from "../send-notification/handler.ts";

/** A claim token as the RPC returns one: a uuid, not a timestamp. */
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

interface Opts {
  email?: string | null;
  /** Review M29: this address has opted out. */
  suppressed?: boolean;
  /** The suppression list itself is unreadable. */
  suppressionError?: boolean;
  send?: () => Promise<{ ok: true } | { ok: false; status: number; detail: string }>;
  /** Model a deployment with no RESEND_API_KEY (H17). */
  emailUnconfigured?: boolean;
  backlog?: string[];
  rows?: Record<string, NotificationRow | null>;
  /** Model losing the 0051 claim race — another sender got there first. */
  claimSend?: (id: string, channel: "email" | "push") => Promise<string | null>;
  /** Make `getClient` throw, to reach a pre-send throw that is not a config error. */
  clientLookupThrows?: boolean;
}

function makeDeps(opts: Opts = {}) {
  const recorded: Array<{ id: string; outcome: Outcome; previousAttempts: number }> = [];
  const recordedStamps: string[] = [];
  const sentTo: string[] = [];
  const sentHeaders: Array<Record<string, string>> = [];
  const suppressionAsked: Array<[string, string, string]> = [];
  const released: Array<[string, string, string]> = [];
  const deps: SendDeps = {
    claimSend: opts.claimSend ?? (() => Promise.resolve(STAMP)),
    releaseSend: (id, channel, stamp) => {
      released.push([id, channel, stamp]);
      return Promise.resolve();
    },
    getNotification: (id) => Promise.resolve(opts.rows ? (opts.rows[id] ?? null) : ROW),
    backlogIds: () => Promise.resolve(opts.backlog ?? []),
    getClient: () =>
      opts.clientLookupThrows
        ? Promise.reject(new Error("statement timeout"))
        : Promise.resolve({
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
    assertEmailConfigured: () => {
      if (opts.emailUnconfigured) {
        throw new HttpError(500, "email_not_configured", "not configured");
      }
    },
    sendEmail: (msg) => {
      sentTo.push(msg.to);
      sentHeaders.push(msg.headers);
      return opts.send ? opts.send() : Promise.resolve({ ok: true as const });
    },
    record: (id, outcome, previousAttempts, stamp) => {
      recordedStamps.push(stamp);
      recorded.push({ id, outcome, previousAttempts });
      return Promise.resolve();
    },
    renderEmail: (b, t, _body, url) => `<p>${b}: ${t} <a href="${url}">Unsubscribe</a></p>`,
  };
  return { deps, recorded, recordedStamps, sentTo, sentHeaders, suppressionAsked, released };
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

// ── H17's loud failure, and where it can still BE loud ─────────────────────

Deno.test("a deployment with no email key FAILS the request, it does not record", async () => {
  // The whole of H17: `if (!apiKey) return jsonOk({skipped:true})` meant a
  // deploy that forgot the secret reported uniform success forever while
  // sending zero email. Round five moved the throw inside `sendEmail`, where
  // `deliverNotification`'s catch records any throw as a retryable delivery
  // failure — so the 500 quietly became `resend unreachable` on the row and a
  // 502 to the caller (Codex review on PR #85). Same defect, new clothes.
  const { deps, recorded, sentTo } = makeDeps({ emailUnconfigured: true });
  const err = await deliverNotification(ROW, deps).then(() => null, (e) => e);
  assert(err instanceof HttpError, `expected a thrown HttpError, got ${JSON.stringify(err)}`);
  assertEquals(err.status, 500);
  assertEquals(err.code, "email_not_configured");
  assertEquals(sentTo, [], "attempted a send with no provider configured");
  assertEquals(recorded, [], "recorded a delivery outcome for a configuration fault");
});

Deno.test("but a TERMINAL row is still recorded, key or no key", async () => {
  // Every skip above the check is terminal regardless of configuration —
  // an operator-only notification has nobody to email whatever the env says —
  // so 500ing on those would replace an honest record with a false alarm.
  const { deps, recorded } = makeDeps({ emailUnconfigured: true });
  const outcome = await deliverNotification({ ...ROW, client_id: null }, deps);
  assertEquals(outcome.kind, "skipped");
  assertEquals(recorded.length, 1);

  const noAddress = makeDeps({ emailUnconfigured: true, email: null });
  assertEquals((await deliverNotification(ROW, noAddress.deps)).kind, "skipped");
  assertEquals(noAddress.recorded.length, 1);
});

Deno.test("the drain does not abort on one row, and stays loud by its backlog", async () => {
  // The drain must not take the remaining rows' PUSH down with it, so it
  // counts the failure and continues. Its loudness is the surviving backlog
  // and the nightly ops check, not an aborted run.
  const { deps, recorded } = makeDeps({
    emailUnconfigured: true,
    backlog: ["n1", "n2"],
    rows: { n1: ROW, n2: { ...ROW, id: "n2" } },
  });
  const result = await drainBacklog(deps);
  assertEquals(result, { drained: 2, sent: 0, failed: 2, pushSent: 0, pushFailed: 0 });
  assertEquals(recorded, [], "a configuration fault must not stamp an outcome");
});

Deno.test("losing the claim race sends nothing and records nothing", async () => {
  // The email arm. `isSettled` is a READ: two invocations both pass it and
  // both deliver, which is reachable via the INSERT webhook racing the drain
  // or an operator POSTing the same notification_id (M1). The claim is the
  // exclusion, so the loser must not send AND must not write an outcome over
  // the winner's.
  const h = makeDeps({ claimSend: () => Promise.resolve(null) });
  const outcome = await deliverNotification(ROW, h.deps);

  assertEquals(outcome.kind, "skipped");
  assertEquals(h.sentTo.length, 0, "the loser sent an email anyway");
  assertEquals(h.recorded.length, 0, "the loser wrote an outcome over the winner's");
});

Deno.test("winning the claim still delivers — the guard is not a wall", async () => {
  // The other direction, and it is not ceremony: a claim that always refused
  // would satisfy the test above while delivering nothing, ever.
  const h = makeDeps({ claimSend: () => Promise.resolve(STAMP) });
  const outcome = await deliverNotification(ROW, h.deps);

  assertEquals(outcome.kind, "sent");
  assertEquals(h.sentTo.length, 1);
});

Deno.test("the claim is asked for BEFORE any terminal skip is recorded", async () => {
  // Placement matters. If the claim came after the "not client-facing" and
  // "no email address" checks, two racing callers would both write `skipped`
  // — harmless in itself, but it means the row's outcome is written by a
  // caller that never held the claim, and the rule stops being "one sender
  // decides this row".
  const asked: Array<[string, string]> = [];
  const h = makeDeps({
    email: null, // terminal: no address
    claimSend: (id, channel) => {
      asked.push([id, channel]);
      return Promise.resolve(null);
    },
  });
  const outcome = await deliverNotification(ROW, h.deps);

  assertEquals(asked.length, 1, "the terminal path skipped the claim entirely");
  assertEquals(asked[0]?.[1], "email");
  assertEquals(outcome.kind, "skipped");
  assertEquals(h.recorded.length, 0, "recorded a terminal outcome without holding the claim");
});

Deno.test("recording an outcome RELEASES the claim, on every kind", () => {
  // The lease is for a sender that CRASHED; one that recorded an outcome did
  // not. Holding the claim afterwards hides the row from
  // fn_notification_backlog for five minutes — and the nightly ops check
  // drains and then re-reads that backlog, going red if anything survives.
  // That re-read happens seconds later, so a permanently failing provider
  // would report green: H17's only alarm for undelivered email, silenced by
  // the fix for a different defect.
  for (const outcome of [
    { kind: "sent" } as const,
    { kind: "skipped", reason: "not a client-facing notification" } as const,
    { kind: "failed", error: "resend 500", permanent: false } as const,
  ]) {
    const patch = recordPatch(outcome, 1);
    assertEquals(
      patch.email_claimed_at,
      null,
      `${outcome.kind} kept the claim, so the drained row stays invisible to the ops check`,
    );
    assertEquals(
      patch.email_claim_token,
      null,
      `${outcome.kind} left a stale fencing token on a settled row`,
    );
  }
});

// ── The real claim, the one both arms actually call ──────────────────────

Deno.test("the real claim asks the RPC for the named channel and returns its answer", async () => {
  // Until this existed, the two `claimSend` implementations had NO test: the
  // email copy sat in index.ts, which binds a port on import, and every test
  // above injects a constant. So the rule their comments call load-bearing was
  // enforced by nothing — the `overage_deps.ts` blind spot exactly.
  const calls: Array<[string, Record<string, unknown>]> = [];
  const db = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push([fn, args]);
      return Promise.resolve({ data: STAMP, error: null });
    },
  };

  // The STAMP, not a boolean: it is the fencing token every later write by
  // this sender carries (0051, Codex PR #86).
  assertEquals(await claimNotificationSend(db, "n-9", "push"), STAMP);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.[0], "fn_claim_notification_send");
  assertEquals(calls[0]?.[1], { p_id: "n-9", p_channel: "push" });

  // The lease is NOT passed: the RPC's default is the single definition of it.
  assertFalse("p_lease" in (calls[0]?.[1] ?? {}), "the caller pinned its own lease");
});

Deno.test("the real claim returns null ONLY for a genuine refusal", async () => {
  const refused = { rpc: () => Promise.resolve({ data: null, error: null }) };
  assertEquals(await claimNotificationSend(refused, "n-9", "email"), null);

  // Anything that is not a STRING is not a claim, and the stamp is what every
  // later write is fenced on — so a non-string answer read as a claim would
  // produce a sender holding a token no row can match. An RPC that answered
  // `true` (the pre-fencing shape) must not read as "we hold it".
  for (const data of [true, 1, {}, []]) {
    const odd = { rpc: () => Promise.resolve({ data, error: null }) };
    assertEquals(
      await claimNotificationSend(odd, "n-9", "email"),
      null,
      `a ${typeof data} answer was read as a claim`,
    );
  }
});

Deno.test("the real claim THROWS on a database error, never answers false", async () => {
  // This is the rule. Reading a transient failure as "somebody else has it"
  // silently drops the delivery — the defect this whole change exists to fix,
  // inverted, and invisible because the drain counts a skip as a success.
  const broken = {
    rpc: () => Promise.resolve({ data: null, error: { message: "57P01 terminating connection" } }),
  };
  let threw: unknown = null;
  try {
    await claimNotificationSend(broken, "n-9", "email");
  } catch (e) {
    threw = e;
  }
  assert(threw instanceof HttpError, "a database error did not throw");
  assertEquals((threw as HttpError).status, 500);
  // The cause is carried, not dropped — the H14 contract.
  assert((threw as HttpError).cause != null, "the underlying error was discarded");
});

// ── a claim is released by EVERY exit, not only by a recorded outcome ──────

Deno.test("a pre-send throw releases the email claim", async () => {
  // Codex review on PR #86. Releasing inside `recordPatch` covers the three
  // OUTCOMES; it does not cover a throw between the claim and any of them —
  // and the loudest one is exactly that. `assertEmailConfigured()` throws when
  // RESEND_API_KEY is unset, `drainBacklog` catches it and still answers 200,
  // and the row keeps its claim, so `fn_notification_backlog` hides it for the
  // whole lease. job-health.yml drains and re-reads seconds later: empty, exit
  // 0. That is H17's alarm dead again, reached through the throw path instead
  // of the record path — the same defect this PR exists to fix.
  const h = makeDeps({ emailUnconfigured: true });

  const err = await assertRejects(
    () => deliverNotification(ROW, h.deps),
    "a missing RESEND_API_KEY must still throw",
  );
  // NOT a bare assertRejects: it passes for any rejection, which is how a
  // sabotage that broke something unrelated once read as green here (0048).
  assert(err instanceof HttpError, `expected HttpError, got ${err.name}`);

  assertEquals(h.recorded.length, 0, "a config error must not settle the row");
  assertEquals(h.released, [[ROW.id, "email", STAMP]], "the claim outlived the sender");
});

Deno.test("a pre-send throw that is NOT a config error releases the claim too", async () => {
  // The rule is structural, not a list of the throws I could think of. Fixing
  // only `assertEmailConfigured` would be the enumeration this repository has
  // already recorded three rounds of (verify-photo-integrity.sh, and the
  // pre-fetch classification on the push arm).
  const h = makeDeps({ clientLookupThrows: true });

  const err = await assertRejects(
    () => deliverNotification(ROW, h.deps),
    "a failed client lookup must still throw",
  );
  assert(/statement timeout/.test(err.message), `unexpected error: ${err.message}`);

  assertEquals(h.recorded.length, 0);
  assertEquals(h.released, [[ROW.id, "email", STAMP]], "the claim outlived the sender");
});

Deno.test("a recorded outcome does NOT double-release", async () => {
  // The release belongs to the throw path; `recordPatch` already clears the
  // column on every kind. A second write would be harmless but would mean two
  // rules for one property, which is how they drift.
  const h = makeDeps();

  const outcome = await deliverNotification(ROW, h.deps);

  assertEquals(outcome.kind, "sent");
  assertEquals(h.released.length, 0, "released a claim the outcome had already cleared");
});

Deno.test("a failing release does not mask the original error", async () => {
  // Best-effort, and the lease is the backstop. Swallowing the real failure to
  // report a bookkeeping one is the `fix(edge-errors)` defect: the operator
  // would be told the wrong thing about why nothing was sent.
  const h = makeDeps({ emailUnconfigured: true });
  h.deps.releaseSend = () => Promise.reject(new Error("db unreachable"));

  const err = await assertRejects(
    () => deliverNotification(ROW, h.deps),
    "the configuration error must still surface",
  );
  assert(err instanceof HttpError, `expected the config HttpError, got ${err.name}`);
  assert(
    !err.message.includes("db unreachable"),
    "the release's own failure replaced the configuration error",
  );
});

Deno.test("a throw AFTER a successful send also releases — and that is the honest choice", async () => {
  // The rule is "every exit gives the claim back", which includes an exit
  // after the email has already left: `deps.record` throwing is the case.
  //
  // That looks like it risks a duplicate, so it is worth being explicit that
  // it does NOT change the risk, only its timing. `record` throwing means
  // nothing was written, so the row is still `pending` with its old attempt
  // count and the drain returns it either way — retained, in five minutes;
  // released, on the next drain. The lease was never protection against this.
  //
  // What the claim buys is exclusion between CONCURRENT senders. It does not
  // make delivery exactly-once across a crash between Resend accepting the
  // message and us recording it, and nothing short of a transaction spanning
  // Resend could. Spec 04 says so rather than implying otherwise.
  const h = makeDeps();
  h.deps.record = () => Promise.reject(new Error("db unreachable"));

  const err = await assertRejects(
    () => deliverNotification(ROW, h.deps),
    "a failed outcome write must still throw",
  );
  assert(/db unreachable/.test(err.message), `unexpected error: ${err.message}`);

  assertEquals(h.sentTo.length, 1, "the email did leave");
  assertEquals(h.released, [[ROW.id, "email", STAMP]]);
});

// ── fencing: a sender that lost its lease may not write ────────────────────

Deno.test("every outcome write carries the claim's stamp", async () => {
  // Codex round 2 on PR #86. A lease cannot tell a crashed sender from a slow
  // one, so a sender still running when its lease lapses is replaced and both
  // are live. Without the stamp on the write, the first one's outcome update
  // is unconditional: it clears the REPLACEMENT's claim and records its own
  // outcome over it, marking the row sent while the replacement is still
  // delivering. The database enforces this — the write is `.eq(column, stamp)`
  // — so what is checked here is that the stamp actually reaches it.
  const h = makeDeps();
  await deliverNotification(ROW, h.deps);
  assertEquals(h.recordedStamps, [STAMP], "an outcome was written unfenced");
});

Deno.test("the stamp written is the one THIS claim returned, not a constant", async () => {
  // A stamp hard-coded anywhere would fence nothing: every sender would carry
  // the same token and the replacement's row would still match.
  const other = "2026-09-01T17:30:00.000Z";
  const h = makeDeps({ claimSend: () => Promise.resolve(other) });
  await deliverNotification(ROW, h.deps);
  assertEquals(h.recordedStamps, [other]);
});

Deno.test("a terminal skip is fenced too, not only the send path", async () => {
  // The skips write outcomes as well, so an unfenced one lets a lapsed sender
  // mark the row `skipped` over a replacement that is mid-send.
  const h = makeDeps({ email: null });
  const outcome = await deliverNotification(ROW, h.deps);
  assertEquals(outcome.kind, "skipped");
  assertEquals(h.recordedStamps, [STAMP]);
});

Deno.test("the Resend request carries a deadline below the claim lease", async () => {
  // Codex round 2 on PR #86. The push arm has had `AbortSignal.timeout` since
  // PR #85 and this one had nothing — the sibling asymmetry this repository
  // keeps recording. It is load-bearing beyond tidiness: a send with no bound
  // can outlive its 5-minute lease, at which point a second sender takes the
  // channel and both are live. That is the duplicate email send-once exists to
  // prevent, and no amount of fencing stops it — fencing protects the WRITE,
  // the deadline is what stops the second SEND.
  const { makeSendDeps } = await import("../send-notification/deps.ts");
  const calls: RequestInit[] = [];
  const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as unknown as typeof fetch;

  const deps = makeSendDeps(
    {
      db: {} as never,
      apiKey: "re_test_key",
      operatorId: null,
      fromEmail: "Sanpo <n@sanpo.test>",
      unsubscribeBase: "https://x.test/unsubscribe",
    },
    fetchImpl,
  );
  await deps.sendEmail({ to: "a@b.test", subject: "s", html: "<p>h</p>", headers: {} });

  assertEquals(calls.length, 1);
  assert(calls[0]?.signal instanceof AbortSignal, "the Resend request has no deadline");
});
