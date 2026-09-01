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
  /**
   * Claim one channel of this notification for sending, atomically.
   *
   * Returns false when somebody else holds a live claim, or the channel has
   * already settled. `isSettled` below is a read-then-act and cannot be the
   * mutual exclusion on its own — two invocations both pass it and both
   * deliver. See 0051; the exclusion is the conditional UPDATE inside the RPC.
   */
  /**
   * Claim one channel for sending, returning the claim's FENCING STAMP —
   * `null` means another sender holds it (0051).
   *
   * A stamp rather than a boolean because a lease cannot tell a crashed
   * sender from a slow one: a sender still running when its lease lapses is
   * replaced, and both are then live (Codex, PR #86). Every later write by
   * this sender carries the stamp, so a sender that has been fenced out
   * cannot clear the replacement's claim or record an outcome over it.
   */
  claimSend(id: string, channel: "email" | "push"): Promise<string | null>;
  /**
   * Give a claim back without recording an outcome (0051).
   *
   * `recordPatch` clears the column on every outcome kind, which covers every
   * way this function RETURNS. It does not cover the ways it THROWS, and the
   * loudest of those is `assertEmailConfigured()` — H17's deliberate 500 for a
   * missing RESEND_API_KEY. `drainBacklog` catches it and still answers 200,
   * so a retained claim hides the row from `fn_notification_backlog` for the
   * whole lease and job-health.yml's drain-then-re-read comes back empty:
   * H17's only alarm, dead again, through the throw path (Codex, PR #86).
   */
  releaseSend(id: string, channel: "email" | "push", stamp: string): Promise<void>;
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
  /**
   * Throw if this deployment cannot send email at all.
   *
   * Called from OUTSIDE the try that wraps the provider, because inside it a
   * configuration error is indistinguishable from Resend having a bad minute
   * and is recorded as a retryable failure (Codex review on PR #85). That is
   * how H17's deliberately loud 500 became a 502 on the webhook path and a
   * 200 on the drain — a deploy that forgot RESEND_API_KEY reporting success
   * forever, which is the exact defect H17 exists to prevent, reintroduced by
   * the round-five change that moved this check to make room for push.
   *
   * It lives on the deps rather than as a boolean so the throw stays in the
   * layer that owns HTTP status codes, and so `handler.ts` still knows nothing
   * about the environment.
   */
  assertEmailConfigured(): void;
  /** Stamp the outcome. The whole point of H17: no path leaves the row silent. */
  record(id: string, outcome: Outcome, previousAttempts: number, stamp: string): Promise<void>;
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
 * Is this channel's outcome already final for this notification?
 *
 * Only `pending` and `failed` are retryable, which is exactly the set
 * `fn_notification_backlog` selects on — stated once here rather than as two
 * status lists that can drift apart, the way the payment-status sets did.
 *
 * Both arms guarded on `=== "sent"` alone (Codex review on PR #85, ninth
 * round), which left `skipped` — documented in both as TERMINAL — retryable in
 * practice. The widened backlog selects a row when EITHER channel is owed, and
 * `drainBacklog` then runs both, so a notification whose push was skipped for
 * want of a device and whose email failed came back through the drain and
 * pushed retroactively if the recipient had since registered one. "Your walk
 * is complete" about a walk two days ago is the harm H17's backfill decision
 * named, arriving by a different route.
 *
 * The reviewer named the push arm; the email arm had the identical hole, one
 * function over. Fixing one and not its sibling is a shape this repository has
 * recorded more than once, so there is one rule and both call it.
 */
export function isSettled(status: string | null | undefined): boolean {
  return status != null && status !== "pending" && status !== "failed";
}

/**
 * Claim one channel of one notification for sending (0051).
 *
 * One RPC, one conditional UPDATE. A database error must NOT be read as
 * "somebody else has it": that would silently skip a delivery on a transient
 * failure, which is the defect this whole change is about, inverted. It
 * throws, and the caller's 502 says so.
 *
 * There is ONE implementation because both arms need exactly this and two
 * copies of one rule is drift already paid for here (the `payment_status`
 * sets). It also makes the rule testable at all: `index.ts` binds a port on
 * import, so the copy that lived there could never be driven by a test.
 *
 * `db` is structural rather than the supabase client type, so this module
 * keeps its single `_lib/http.ts` import and a stub is enough to drive it.
 */
export async function claimNotificationSend(
  db: { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> },
  id: string,
  channel: "email" | "push",
): Promise<string | null> {
  const { data, error } = await db.rpc("fn_claim_notification_send", {
    p_id: id,
    p_channel: channel,
  });
  if (error) {
    throw new HttpError(500, "db_error", "could not claim the notification", error, {
      notification_id: id,
    });
  }
  // The RPC returns the claim's timestamp, or null for a refusal. Anything
  // that is not a string is not a claim — an RPC that answered nothing must
  // never read as "we hold it", or two senders both proceed.
  return typeof data === "string" ? data : null;
}

/**
 * Release a claim taken by `claimNotificationSend` (0051).
 *
 * Deliberately NOT an RPC: the column carries no grant for any API role, and
 * the sender already holds UPDATE on `notifications` for the outcome write, so
 * this needs no new migration and no new definer function.
 *
 * The caller treats a failure here as best-effort — the lease is what makes
 * that affordable — so this returns rather than throwing, and says why it
 * could not release on a server-side line.
 */
export async function releaseNotificationSend(
  db: {
    from(table: string): {
      update(patch: Record<string, unknown>): {
        eq(col: string, val: string): { eq(col: string, val: string): PromiseLike<{ error: unknown }> };
      };
    };
  },
  id: string,
  channel: "email" | "push",
  stamp: string,
): Promise<void> {
  const column = channel === "email" ? "email_claimed_at" : "push_claimed_at";
  const tokenColumn = channel === "email" ? "email_claim_token" : "push_claim_token";
  // FENCED on the stamp: a sender whose lease lapsed and was replaced must not
  // hand back a claim that is no longer its own, or it silently unlocks the
  // row under a replacement that is still sending.
  const { error } = await db
    .from("notifications")
    .update({ [column]: null, [tokenColumn]: null })
    .eq("id", id)
    .eq(tokenColumn, stamp);
  if (error) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "could not release the send claim",
        notification_id: id,
        channel,
      }),
    );
  }
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
  // retryable, which is the whole point of the backlog 0029 added.
  if (isSettled(row.email_status)) {
    return { kind: "skipped", reason: `already ${row.email_status}` };
  }

  // ...and the guard above is a READ. It is kept because it answers the common
  // "already sent" case without a round trip and with a better sentence, but
  // it is not the exclusion: between reading it and recording an outcome, a
  // second invocation reads the same row and delivers too. The claim is one
  // conditional UPDATE, so exactly one caller proceeds (0051).
  //
  // Claimed BEFORE the terminal checks below rather than just before the send:
  // those checks write `skipped`, and two callers racing to write it is
  // harmless, but placing the claim first means every path out of here is
  // covered by one rule instead of most of them.
  const stamp = await deps.claimSend(row.id, "email");
  if (stamp === null) {
    return { kind: "skipped", reason: "another sender holds the email claim" };
  }

  // Once claimed, EVERY exit gives the claim back: a recorded outcome clears
  // it in `recordPatch`, and anything that throws clears it here. Structural
  // rather than a list of the throws I could think of — enumerating them is
  // how the next one is missed, which this repository has now recorded three
  // times (verify-photo-integrity.sh, and the push arm's pre-fetch
  // classification). Anything added between here and the send is covered
  // without its author knowing the rule exists.
  try {
    return await sendClaimed(row, deps, stamp);
  } catch (e) {
    // BEST-EFFORT, and it must not become the error the caller sees: replacing
    // a missing RESEND_API_KEY with "db unreachable" tells the operator the
    // wrong thing about why nothing was sent (the `fix(edge-errors)` defect).
    // The lease is what makes swallowing this affordable — a claim nobody
    // released is retryable in five minutes rather than never.
    try {
      await deps.releaseSend(row.id, "email", stamp);
    } catch {
      // deliberately ignored; `releaseNotificationSend` logs its own failure
    }
    throw e;
  }
}

async function sendClaimed(
  row: NotificationRow,
  deps: SendDeps,
  stamp: string,
): Promise<Outcome> {
  // Terminal, not a failure: an operator-only notification has no client to
  // email, and nothing about that will change. A sweep that treated this as
  // "not yet sent" would retry it every night forever.
  if (!row.client_id || !CLIENT_FACING.has(row.type)) {
    const outcome: Outcome = { kind: "skipped", reason: "not a client-facing notification" };
    await deps.record(row.id, outcome, row.email_attempts, stamp);
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
    await deps.record(row.id, outcome, row.email_attempts, stamp);
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
    await deps.record(row.id, outcome, row.email_attempts, stamp);
    return outcome;
  }
  if (suppressed) {
    const outcome: Outcome = { kind: "skipped", reason: "recipient unsubscribed" };
    await deps.record(row.id, outcome, row.email_attempts, stamp);
    return outcome;
  }

  // Now — and only now — is email genuinely owed: the row is client-facing,
  // the address exists, and it is not suppressed. Every branch above is
  // TERMINAL and is better recorded than 500'd, because none of them changes
  // when the key appears. This one does, so it is the configuration error.
  deps.assertEmailConfigured();

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
    await deps.record(row.id, outcome, row.email_attempts, stamp);
    return outcome;
  }

  if (!result.ok) {
    const outcome: Outcome = {
      kind: "failed",
      error: `resend ${result.status}: ${result.detail.slice(0, 300)}`,
      permanent: isPermanentSendFailure(result.status),
    };
    await deps.record(row.id, outcome, row.email_attempts, stamp);
    return outcome;
  }

  const outcome: Outcome = { kind: "sent" };
  await deps.record(row.id, outcome, row.email_attempts, stamp);
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

    // One bad row must not strand the rest of the backlog — the rule the
    // comment above the push arm already states, which the email arm did not
    // honour (Codex review on PR #85). A configuration error now throws from
    // `deliverNotification` so the single-row path is loud again, and here
    // that must not abort the drain and take the remaining rows' PUSH with it.
    //
    // The drain stays loud by a different mechanism, which is why it can
    // afford to continue: nothing gets sent, the backlog survives, and the
    // nightly ops check goes red on a backlog that outlives its retry.
    try {
      const outcome = await deliverNotification(row, deps);
      if (outcome.kind === "failed") failed += 1;
      else sent += 1;
    } catch {
      failed += 1;
    }
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
/**
 * Recording an outcome RELEASES the claim, in the same UPDATE.
 *
 * The claim excludes concurrent senders for the duration of a send; the lease
 * exists for a sender that CRASHED. One that recorded an outcome did neither,
 * so holding its claim afterwards buys nothing and costs two things.
 *
 * The first is the serious one. `fn_notification_backlog` skips rows under a
 * live claim, and the nightly ops check drains and then RE-READS the backlog,
 * going red if anything survives — H17's only alarm for undelivered email.
 * A drain that claims each row and keeps the claim makes that re-read 0
 * seconds later, so a permanently failing provider reported green. Measured
 * before this line existed: a row left `failed` with a fresh claim is invisible
 * to `fn_notification_backlog()`, and reappears only once the lease lapses.
 * That is a check reporting success having verified nothing, which is this
 * repository's most repeated defect, introduced by the fix for a different one.
 *
 * The second is smaller: a `failed` row could not be retried by hand for five
 * minutes, and the refusal would say another sender held it, which is false.
 *
 * Nulling on every outcome rather than only on `failed` keeps one rule. A
 * settled row is excluded by its STATUS, so releasing the claim there changes
 * nothing a caller can observe — and a rule with an exception is the shape that
 * drifts.
 */
export function recordPatch(outcome: Outcome, previousAttempts: number): Record<string, unknown> {
  switch (outcome.kind) {
    case "sent":
      return {
        email_status: "sent",
        email_sent_at: new Date().toISOString(),
        email_attempts: previousAttempts + 1,
        email_last_error: null,
        email_claimed_at: null,
        email_claim_token: null,
      };
    case "skipped":
      // No attempt was made, so the count does not move. A skip is a decision,
      // not a try, and inflating attempts here would push terminal rows toward
      // the give-up ceiling for no reason.
      return { email_status: "skipped", email_last_error: outcome.reason, email_claimed_at: null, email_claim_token: null };
    case "failed":
      return {
        email_status: "failed",
        email_attempts: previousAttempts + 1,
        email_last_error: outcome.error.slice(0, 500),
        email_claimed_at: null,
        email_claim_token: null,
      };
  }
}
