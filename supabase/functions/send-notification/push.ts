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
import type { Outcome } from "./handler.ts";

export interface PushSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushDeps {
  /** This notification's recipient's devices. `client` null ⇒ the operator's. */
  getSubscriptions(operatorId: string, clientId: string | null): Promise<PushSubscription[]>;
  /** POST the encrypted body. Resolves with the push service's own status. */
  sendPush(sub: PushSubscription, payload: string): Promise<{ status: number; detail?: string }>;
  /** 404/410 — the browser has permanently forgotten this registration. */
  dropSubscription(id: string): Promise<void>;
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
 * What the service worker receives. Deliberately small: a push payload lands
 * on a LOCK SCREEN, so it carries what the person needs to decide whether to
 * look, and the deep link — never a credit balance, an address or a door code.
 * `notifications.body` is already written for the in-app bell under the same
 * constraint (0038 removed a balance from one of them).
 */
export function pushPayload(row: PushableRow): string {
  return JSON.stringify({
    id: row.id,
    title: row.title,
    body: row.body ?? "",
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
  // attempt must stay retryable, which is the whole point of the backlog.
  if (row.push_status === "sent") {
    return { kind: "skipped", reason: "already sent" };
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
  let lastError = "";
  let anyTransient = false;

  for (const sub of subs) {
    let status: number;
    let detail: string | undefined;
    try {
      ({ status, detail } = await deps.sendPush(sub, payload));
    } catch (e) {
      // A thrown transport error is not a verdict from the push service, so
      // it must never be read as "this device is gone".
      status = 0;
      detail = e instanceof Error ? e.message : String(e);
    }

    if (status >= 200 && status < 300) {
      delivered += 1;
      continue;
    }
    lastError = `${status} ${detail ?? ""}`.trim();
    if (isGoneStatus(status)) {
      gone += 1;
      await deps.dropSubscription(sub.id);
      continue;
    }
    if (!isPermanentPushFailure(status)) anyTransient = true;
    await deps.noteFailure(sub.id, lastError);
  }

  let outcome: Outcome;
  if (delivered > 0) {
    outcome = { kind: "sent" };
  } else if (gone === subs.length) {
    outcome = { kind: "skipped", reason: "every registered device was gone" };
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
