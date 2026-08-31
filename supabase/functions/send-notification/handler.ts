// Delivery decisions for send-notification, with dependencies injected
// (review H17).
//
// Split out because this function had branching behaviour and zero coverage,
// which is the same shape as the defect it exists to fix: nothing recorded what
// happened, so nothing could be checked. `payment_failed` and `walk_cancelled`
// go through here — a client learning their card failed, an operator learning a
// walk was cancelled — so "we think it sends" is not good enough.
import { HttpError } from "../_lib/http.ts";

/** Notification types whose CLIENT gets an email. Others reach the bell only. */
export const CLIENT_FACING = new Set([
  "walk_complete",
  "low_credit",
  "renewal_upcoming",
  "payment_failed",
  "walk_scheduled",
  "walk_cancelled",
]);

export interface NotificationRow {
  id: string;
  operator_id: string;
  client_id: string | null;
  type: string;
  title: string;
  body: string | null;
  walk_id: string | null;
  email_attempts: number;
  /** 0029. `sent` is terminal — see the send-once guard in deliverNotification.
   *
   * The column is `email_status`. This field was `email_delivery_status` from
   * 0032 until M27 — which is the ENUM TYPE's name, not the column's — so the
   * select naming it raised 42703 and every lookup 500'd. `select-columns.test.ts`
   * is the gate. */
  email_status?: string | null;
  /** 0049, the push mirror. Same terminal rule. */
  push_attempts?: number;
  push_status?: string | null;
}

/** The outcome recorded against the row. */
export type Outcome =
  | { kind: "sent" }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; error: string; permanent: boolean };

export interface SendDeps {
  getNotification(id: string): Promise<NotificationRow | null>;
  /** Rows the nightly job counted as still owed an email. */
  backlogIds(): Promise<string[]>;
  getClient(id: string): Promise<{
    full_name: string;
    email: string | null;
    unsubscribe_token: string;
  } | null>;
  /** Whether this address has opted out — see 0038 and review M29. */
  isSuppressed(email: string, operatorId: string, type: string): Promise<boolean>;
  getOperator(id: string): Promise<{ business_name: string | null } | null>;
  /** Resolves on a 2xx; rejects or returns the provider's own words otherwise. */
  sendEmail(msg: {
    to: string;
    subject: string;
    html: string;
    /**
     * `List-Unsubscribe` and `List-Unsubscribe-Post`. Every operator sends
     * from ONE shared identity, so the sending reputation is the platform's,
     * aggregated — Sanpo is the bulk sender even when no operator is.
     */
    headers: Record<string, string>;
  }): Promise<{ ok: true } | { ok: false; status: number; detail: string }>;
  /** Stamp the outcome. The whole point of H17: no path leaves the row silent. */
  record(id: string, outcome: Outcome, previousAttempts: number): Promise<void>;
  renderEmail(business: string, title: string, body: string, unsubscribeUrl: string): string;
  /** The one-click URL for a token, so the handler stays free of env lookups. */
  unsubscribeUrl(token: string): string;
}

/**
 * Whether a failure is worth retrying.
 *
 * A 4xx from Resend is our request being wrong — unverified sending domain,
 * invalid recipient — and it will be wrong again tomorrow. 5xx and 429 are the
 * provider, and may not be. Both are recorded as `failed`; the attempt ceiling
 * in 0029 is what stops the permanent ones being retried forever, but the
 * distinction decides what the operator is told.
 */
export function isPermanentSendFailure(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429;
}

/**
 * Deliver one notification and record what happened.
 *
 * Returns the outcome rather than throwing, so a drain can carry on through a
 * failure. The single-notification caller turns a failure into a 502, which is
 * what tells the webhook and the operator that something is wrong.
 */
export async function deliverNotification(
  row: NotificationRow,
  deps: SendDeps,
): Promise<Outcome> {
  // Send-once (review M1). Nothing else stopped the same notification being
  // delivered repeatedly: the DB webhook fires on INSERT, but the endpoint
  // also accepts a `notification_id` directly, so an operator could POST the
  // same id in a loop and mail-bomb their own client — and, before the tenant
  // scoping added alongside this, somebody else's.
  //
  // Deliberately not `email_attempts > 0`: an attempt that FAILED must stay
  // retryable, which is the whole point of the backlog 0029 added. Only a
  // recorded `sent` is terminal.
  if (row.email_status === "sent") {
    return { kind: "skipped", reason: "already sent" };
  }

  // Terminal, not a failure: an operator-only notification has no client to
  // email, and nothing about that will change. A sweep that treated this as
  // "not yet sent" would retry it every night forever.
  if (!row.client_id || !CLIENT_FACING.has(row.type)) {
    const outcome: Outcome = { kind: "skipped", reason: "not a client-facing notification" };
    await deps.record(row.id, outcome, row.email_attempts);
    return outcome;
  }

  const [client, operator] = await Promise.all([
    deps.getClient(row.client_id),
    deps.getOperator(row.operator_id),
  ]);

  // Also terminal. There is no address, and no number of retries produces one.
  // The reason lands on the row so the operator can see whose email is missing.
  if (!client?.email) {
    const outcome: Outcome = { kind: "skipped", reason: "client has no email address" };
    await deps.record(row.id, outcome, row.email_attempts);
    return outcome;
  }

  // Review M29. Terminal, like the two skips above: an address that has opted
  // out is not owed a retry, and a sweep that treated this as "not yet sent"
  // would try again every night against somebody who explicitly asked it to
  // stop — which is worse than the original defect.
  //
  // Checked HERE rather than in the queue, so it applies to every path into
  // this function: the DB webhook on INSERT, the nightly drain, and a direct
  // POST of a notification id.
  let suppressed: boolean;
  try {
    suppressed = await deps.isSuppressed(client.email, row.operator_id, row.type);
  } catch (e) {
    // FAIL CLOSED, and retryably. An unreadable suppression list means we do
    // not know whether this person asked us to stop, and sending anyway is the
    // one outcome here that cannot be taken back. Recorded as a failure so the
    // nightly drain comes back to it — which is what makes failing closed
    // affordable rather than a silent drop.
    const outcome: Outcome = {
      kind: "failed",
      error: `suppression lookup failed: ${e instanceof Error ? e.message : "unknown"}`,
      permanent: false,
    };
    await deps.record(row.id, outcome, row.email_attempts);
    return outcome;
  }
  if (suppressed) {
    const outcome: Outcome = { kind: "skipped", reason: "recipient unsubscribed" };
    await deps.record(row.id, outcome, row.email_attempts);
    return outcome;
  }

  const business = operator?.business_name ?? "Your walker";
  const unsubscribeUrl = deps.unsubscribeUrl(client.unsubscribe_token);
  let result: Awaited<ReturnType<SendDeps["sendEmail"]>>;
  try {
    result = await deps.sendEmail({
      to: client.email,
      subject: `${row.title} — ${business}`,
      html: deps.renderEmail(business, row.title, row.body ?? "", unsubscribeUrl),
      // The pair, not just the URL: `List-Unsubscribe-Post` is what makes a
      // mail client show its own one-click control instead of making the
      // recipient find the link in the body.
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
  } catch (e) {
    // Resend unreachable. Retryable — and the row now says so. Before this it
    // threw out of the handler and the webhook, which does not retry, simply
    // forgot the email had ever been owed.
    const outcome: Outcome = {
      kind: "failed",
      error: `resend unreachable: ${e instanceof Error ? e.message : "unknown"}`,
      permanent: false,
    };
    await deps.record(row.id, outcome, row.email_attempts);
    return outcome;
  }

  if (!result.ok) {
    const outcome: Outcome = {
      kind: "failed",
      error: `resend ${result.status}: ${result.detail.slice(0, 300)}`,
      permanent: isPermanentSendFailure(result.status),
    };
    await deps.record(row.id, outcome, row.email_attempts);
    return outcome;
  }

  const outcome: Outcome = { kind: "sent" };
  await deps.record(row.id, outcome, row.email_attempts);
  return outcome;
}

export interface DrainResult {
  drained: number;
  sent: number;
  failed: number;
  pushSent: number;
  pushFailed: number;
}

/** Injected so `handler.ts` need not import the push arm's wiring. */
export type PushDelivery = (row: NotificationRow) => Promise<Outcome>;

/**
 * Retry everything the nightly job counted as still owed.
 *
 * Carries on past a failure: one bad recipient must not strand the rest of the
 * backlog, which is what a throw-on-first-error loop would do.
 */
export async function drainBacklog(
  deps: SendDeps,
  pushDelivery?: PushDelivery,
): Promise<DrainResult> {
  const ids = await deps.backlogIds();
  let sent = 0;
  let failed = 0;
  let pushSent = 0;
  let pushFailed = 0;
  for (const id of ids) {
    const row = await deps.getNotification(id);
    if (!row) continue; // deleted between the count and the send

    // Both channels, because the backlog now selects rows owed EITHER (Codex
    // review on PR #85). Each is send-once on its own `*_status = 'sent'`, so
    // a row selected because its push failed does not re-email, and vice
    // versa — the drain does not need to know which one put it here.
    //
    // Push first and isolated, for the same reason the single-notification
    // path does it: a database blip in the optional channel must not cost the
    // email, and one bad row must not strand the rest of the backlog.
    if (pushDelivery) {
      try {
        const p = await pushDelivery(row);
        if (p.kind === "failed") pushFailed += 1;
        else if (p.kind === "sent") pushSent += 1;
      } catch {
        pushFailed += 1;
      }
    }

    const outcome = await deliverNotification(row, deps);
    if (outcome.kind === "failed") failed += 1;
    else sent += 1;
  }
  return { drained: ids.length, sent, failed, pushSent, pushFailed };
}

/**
 * Turn a delivery failure into the response for a SINGLE notification request.
 *
 * A 502 is what makes the failure visible to the caller — the DB webhook, or an
 * operator retrying by hand. The row has already recorded the detail; this is
 * the part a person or a log sees.
 */
export function failureResponse(row: NotificationRow, outcome: Outcome): HttpError {
  if (outcome.kind !== "failed") {
    throw new Error("failureResponse called for a non-failure outcome");
  }
  return new HttpError(
    502,
    "email_failed",
    "email provider rejected the message",
    outcome.error,
    {
      notification_id: row.id,
      type: row.type,
      client_id: row.client_id,
      permanent: outcome.permanent,
    },
  );
}

/**
 * The column values for an outcome.
 *
 * Here rather than in index.ts because importing index.ts executes
 * `serveFunction`, which binds a port — so anything a test needs to reach has
 * to live on this side of the split.
 */
export function recordPatch(outcome: Outcome, previousAttempts: number): Record<string, unknown> {
  switch (outcome.kind) {
    case "sent":
      return {
        email_status: "sent",
        email_sent_at: new Date().toISOString(),
        email_attempts: previousAttempts + 1,
        email_last_error: null,
      };
    case "skipped":
      // No attempt was made, so the count does not move. A skip is a decision,
      // not a try, and inflating attempts here would push terminal rows toward
      // the give-up ceiling for no reason.
      return { email_status: "skipped", email_last_error: outcome.reason };
    case "failed":
      return {
        email_status: "failed",
        email_attempts: previousAttempts + 1,
        email_last_error: outcome.error.slice(0, 500),
      };
  }
}
