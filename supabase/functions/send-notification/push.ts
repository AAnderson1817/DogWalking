// The push arm of send-notification (review M27).
//
// Alongside H17's email arm rather than in its own function, deliberately: the
// existing Database Webhook already calls `send-notification` on INSERT into
// `notifications`, and a second function would need a second webhook — a
// dashboard step only the owner can perform, and one more thing that is
// invisible when it is missing. One insert, two channels, each recording its
// own outcome.
//
// The two channels do NOT gate each other. A push failure must not stop the
// email, and an email skip must not stop the push: they are separate promises
// to the same person, and the `email_*` / `push_*` column pairs exist so
// neither can hide behind the other.
//
// ── Who gets a push, and how it differs from email ──────────────────────
//
// Email is client-facing only: `CLIENT_FACING` plus a `client_id`. Push goes
// to WHOEVER the notification is addressed to, because an operator wants
// "walk cancelled" on their phone as much as a client wants "walk complete".
// `client_id is null` means the operator's own devices, which is the same
// convention `notifications` and `push_subscriptions` already use.
import { isPushServiceEndpoint } from "../_lib/webpush.ts";
import { isSettled, type Outcome } from "./handler.ts";

export interface PushSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * What one attempt at one device produced.
 *
 * `status` is the push service's own answer. `blocked` says why there was no
 * answer at all, and it is the difference between "the network blinked" and
 * "this deployment cannot push", which the operator can act on and the other
 * they cannot.
 */
export interface PushAttempt {
  status: number;
  blocked?: "not_configured" | "payload" | "transport";
}

export interface PushDeps {
  /**
   * Claim the push channel for sending, atomically. See `SendDeps.claimSend`
   * and 0051 — `isSettled` is a read-then-act and cannot exclude on its own.
   */
  claimSend(id: string, channel: "email" | "push"): Promise<boolean>;
  /** This notification's recipient's devices. `client` null ⇒ the operator's. */
  getSubscriptions(operatorId: string, clientId: string | null): Promise<PushSubscription[]>;
  /**
   * POST the encrypted body. Resolves with the push service's own status, or
   * with `status: 0` and a `blocked` reason when we never reached it.
   *
   * The STATUS and nothing else (Codex review on PR #85). This used to hand
   * back 300 characters of the service's response body, which then travelled
   * into `notifications.push_last_error` — a column `authenticated` may
   * select. H14's rule is that the client sees OUR message and the underlying
   * system's words never leave the server; this path broke it, and with an
   * attacker-registrable endpoint it was an exfiltration channel rather than
   * merely untidy. The body is logged server-side by the implementation, at
   * the point it is read, so it cannot reach a column by being forgotten.
   *
   * It does not THROW for its own pre-flight failures either (Codex review on
   * PR #85, twelfth round). Missing VAPID keys and a payload that cannot be
   * encrypted both failed before the `fetch`, so the catch below turned them
   * into `status: 0` — recorded as "the request to the push service did not
   * complete", which is false, since no request was made — and the
   * implementation's logging ran only AFTER the fetch, so nothing recorded
   * them anywhere. A deployment whose VAPID keys were removed while devices
   * existed therefore reported an ordinary transient failure forever. Same
   * shape as the email arm's `assertEmailConfigured` one round earlier: an
   * actionable configuration fault, indistinguishable from a bad minute.
   */
  sendPush(sub: PushSubscription, payload: string): Promise<PushAttempt>;
  /**
   * 404/410 — the browser has permanently forgotten this registration.
   *
   * Returns whether the row actually WENT, rather than throwing (Codex review
   * on PR #85, tenth round). Throwing aborted the fanout mid-loop: the
   * recipient's remaining healthy devices were never tried, no aggregate
   * outcome was recorded at all, and a device that had already accepted the
   * push got it a second time when the still-pending row came back through
   * the drain. A database blip on a dead row is not a reason to drop a live
   * notification.
   *
   * The failure still has to be VISIBLE — a swallowed delete error is what
   * round five fixed, where `deliverPush` could record the terminal `skipped`
   * over a dead endpoint that was still in the table. So the implementation
   * logs it server-side and answers false, and the caller must decide: a row
   * that did not go means the recipient still has that device, so the
   * notification stays retryable.
   */
  dropSubscription(id: string): Promise<boolean>;
  /** Per-device health, so a flapping endpoint is visible before it is dropped. */
  noteFailure(id: string, error: string): Promise<void>;
  recordPush(id: string, outcome: Outcome, previousAttempts: number): Promise<void>;
}

export interface PushableRow {
  id: string;
  operator_id: string;
  client_id: string | null;
  type: string;
  title: string;
  body: string | null;
  walk_id: string | null;
  push_attempts: number;
  push_status?: string | null;
}

/**
 * A dead registration, as opposed to a bad moment.
 *
 * 404 and 410 are the push service saying the subscription no longer exists —
 * the browser dropped it, the app was uninstalled, the user revoked
 * permission. Retrying is pointless forever, so the row is deleted rather than
 * kept as a tombstone hoarding an endpoint that identifies a browser.
 *
 * 413 is OURS: the payload exceeded the service's limit. Also permanent, but
 * the subscription is fine and deleting it would destroy a good device over a
 * bug in our own message.
 */
export function isGoneStatus(status: number): boolean {
  return status === 404 || status === 410;
}

export function isPermanentPushFailure(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429;
}

/**
 * What a failure is allowed to SAY, as opposed to what it means.
 *
 * `notifications.push_last_error` is selectable by `authenticated` (0004
 * grants the whole row and the RLS policies scope it to the recipient), so
 * whatever goes in here is client-readable. It used to be the push service's
 * own response body, truncated to 300 characters — which is H14's rule
 * inverted: ours is the only part a client sees, the underlying system's
 * words stay on the server.
 *
 * A status is a number we chose to keep, not text somebody else wrote, and it
 * is the part that is actually diagnostic. The body still exists — it is on
 * the log line the sender emits when it reads it, with the subscription id
 * for context.
 */
export function pushFailureLabel(attempt: PushAttempt): string {
  if (attempt.status !== 0) return `the push service answered ${attempt.status}`;
  switch (attempt.blocked) {
    case "not_configured":
      return "push delivery is not configured for this deployment";
    case "payload":
      return "this notification could not be encrypted for that device";
    default:
      return "the request to the push service did not complete";
  }
}

/**
 * What the service worker receives. Deliberately small: a push payload lands
 * on a LOCK SCREEN, so it carries what the person needs to decide whether to
 * look, and the deep link — never a credit balance, an address or a door code.
 * `notifications.body` is already written for the in-app bell under the same
 * constraint (0038 removed a balance from one of them).
 */
/** A lock screen shows a line and a bit. These bound the encrypted record as
 * well as the display: `title` and `body` are unconstrained text and operator
 * notifications embed a client's name, so nothing upstream stops one growing
 * past the 4096-byte record `encryptPushPayload` frames (Codex review on PR
 * #85). Clamping is also the better product answer — a truncated sentence on
 * a lock screen beats a notification that does not arrive. */
const MAX_TITLE = 120;
const MAX_BODY = 400;

function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function pushPayload(row: PushableRow): string {
  return JSON.stringify({
    id: row.id,
    title: clamp(row.title, MAX_TITLE),
    body: clamp(row.body ?? "", MAX_BODY),
    url: deepLink(row),
    // The NOTIFICATION id, not the type (Codex review on PR #85). Tagging by
    // type collapsed two distinct `walk_complete` events into one tray entry:
    // an operator with two clients would see Max's walk replace Luna's and
    // never know Luna's existed. Losing a notification is a worse outcome
    // than a fuller tray.
    //
    // It still collapses what a tag is here for — a duplicate delivery of the
    // SAME row, which is the residual left by send-once being a read-then-act
    // (backlog item 1). Same id, same tag, one entry.
    tag: row.id,
  });
}

function deepLink(row: PushableRow): string {
  const operator = row.client_id === null;
  if (row.walk_id) return operator ? `/calendar` : `/portal/walks/${row.walk_id}`;
  return operator ? `/` : `/portal`;
}

/**
 * Push one notification to every device its recipient has registered, and
 * record ONE aggregate outcome.
 *
 * Aggregate because the question a person asks is "was I told", not "did
 * device 3 of 4 accept it":
 *
 *   sent     at least one device accepted. A second device failing does not
 *            make it untrue that they were told.
 *   skipped  they have no live registrations. TERMINAL — somebody who never
 *            turned push on is not a delivery failure, and retrying them
 *            nightly forever is how a backlog stops being read.
 *   failed   they had devices and every one failed. Retryable.
 *
 * The "every device was gone" case resolves to `skipped`, not `failed`: after
 * dropping them the recipient has no devices at all, so a retry would find
 * nothing and record `skipped` on the next pass anyway. Recording it now says
 * the same true thing one night earlier.
 */
export async function deliverPush(row: PushableRow, deps: PushDeps): Promise<Outcome> {
  // Send-once, matching the email arm. Not `push_attempts > 0`: a failed
  // attempt must stay retryable, which is the whole point of the backlog —
  // and not `=== "sent"` either, which left the TERMINAL `skipped` retryable
  // (Codex review on PR #85). See `isSettled`.
  if (isSettled(row.push_status)) {
    return { kind: "skipped", reason: `already ${row.push_status}` };
  }

  // The exclusion, as in the email arm. A duplicate push is less damaging than
  // a duplicate email — the worker tags by notification id, so two deliveries
  // of one row collapse into a single lock-screen entry — but "less damaging"
  // is not "harmless": the fanout POSTs every device again, and a row whose
  // outcome is being written by another sender is not this one's to write.
  if (!(await deps.claimSend(row.id, "push"))) {
    return { kind: "skipped", reason: "another sender holds the push claim" };
  }

  const subs = await deps.getSubscriptions(row.operator_id, row.client_id);
  if (subs.length === 0) {
    const outcome: Outcome = { kind: "skipped", reason: "no registered devices" };
    await deps.recordPush(row.id, outcome, row.push_attempts);
    return outcome;
  }

  const payload = pushPayload(row);
  let delivered = 0;
  let gone = 0;
  let refused = 0;
  let lastError = "";
  let anyTransient = false;

  for (const sub of subs) {
    // Refused BEFORE the request exists, not classified after it fails
    // (Codex review on PR #85). `fetch` is the whole of the SSRF: an endpoint
    // that is not a push service must never be contacted, so this is a
    // `continue` rather than an error status fed through the loop below.
    //
    // Dropped, and that is the same call 404/410 gets: an endpoint no sender
    // will ever POST to cannot deliver, so keeping the row leaves a target
    // sitting in the table padding the recipient's device quota. 0049 refuses
    // these at registration, so on a fresh deploy this branch is unreachable
    // — which is exactly why it is here. It is the check that survives a
    // future write path forgetting the rule.
    if (!isPushServiceEndpoint(sub.endpoint)) {
      if (await deps.dropSubscription(sub.id)) {
        refused += 1;
      } else {
        // The row survives, so the recipient still has a device this send did
        // not reach. Retryable, and the drop is retried with it.
        anyTransient = true;
        lastError = "a device that is not a push service could not be dropped";
      }
      continue;
    }

    let attempt: PushAttempt;
    try {
      attempt = await deps.sendPush(sub, payload);
    } catch {
      // A backstop, not the path: `sendPush` classifies and logs its own
      // failures now. A throw reaching here is a dep implementation that does
      // not, and it is still never a verdict from the push service — so it
      // must not be read as "this device is gone".
      attempt = { status: 0, blocked: "transport" };
    }
    const status = attempt.status;

    if (status >= 200 && status < 300) {
      delivered += 1;
      continue;
    }
    lastError = pushFailureLabel(attempt);
    if (isGoneStatus(status)) {
      if (await deps.dropSubscription(sub.id)) {
        gone += 1;
      } else {
        // Recording `gone` here would let the aggregate resolve to the
        // TERMINAL `skipped` while the dead endpoint is still in the table for
        // every future notification to POST to — round five's finding. It
        // stays a transient failure until the row is actually gone.
        anyTransient = true;
      }
      continue;
    }
    if (!isPermanentPushFailure(status)) anyTransient = true;
    await deps.noteFailure(sub.id, lastError);
  }

  let outcome: Outcome;
  if (delivered > 0) {
    outcome = { kind: "sent" };
  } else if (gone + refused === subs.length) {
    // Nothing is left to retry: every device was either forgotten by its push
    // service or is one we will not contact. A retry tomorrow finds no rows
    // at all and records `skipped` anyway, so recording it now says the same
    // true thing one night earlier — and it says WHICH, because a dropped row
    // that nothing mentions is the kind of deletion nobody can account for.
    outcome = {
      kind: "skipped",
      reason: refused > 0
        ? `every registered device was gone (${gone}) or not a push service (${refused})`
        : "every registered device was gone",
    };
  } else {
    outcome = { kind: "failed", error: lastError, permanent: !anyTransient };
  }
  await deps.recordPush(row.id, outcome, row.push_attempts);
  return outcome;
}

/** The column values for a push outcome — the `push_` mirror of recordPatch. */
export function pushRecordPatch(
  outcome: Outcome,
  previousAttempts: number,
): Record<string, unknown> {
  switch (outcome.kind) {
    case "sent":
      return {
        push_status: "sent",
        push_sent_at: new Date().toISOString(),
        push_attempts: previousAttempts + 1,
        push_last_error: null,
      };
    case "skipped":
      // A skip is a decision, not a try. Counting it would march terminal rows
      // toward the give-up ceiling for nothing (0029's rule).
      return { push_status: "skipped", push_last_error: outcome.reason };
    case "failed":
      return {
        push_status: "failed",
        push_attempts: previousAttempts + 1,
        push_last_error: outcome.error.slice(0, 500),
      };
  }
}
