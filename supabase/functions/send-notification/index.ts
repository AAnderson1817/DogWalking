// send-notification — POST (service key via DB webhook, or operator JWT).
//
// Emails client-facing notifications through Resend, and RECORDS WHAT HAPPENED
// (review H17). Delivery is driven by a Database Webhook on INSERT, which is
// pg_net-based and does not retry on a non-2xx — so before 0029 a provider
// outage lost the email permanently with nothing on the row to show it, while
// the in-app bell still displayed it. The system looked healthy from the inside
// with the outside channel dead.
//
// The decisions live in handler.ts with dependencies injected; this file is the
// wiring. Every path leaves the row in a terminal ('sent'/'skipped') or
// retryable ('failed') state, and the nightly job counts what is still owed.
import { isServiceAuth, jsonOk, readJson, requireOperator, serveFunction, HttpError } from "../_lib/http.ts";
import { makeSendDeps } from "./deps.ts";
import type { Outcome } from "./handler.ts";
import { deliverPush, type PushableRow } from "./push.ts";
import { adminClient } from "../_lib/admin.ts";
import { makePushDeps, vapidConfig } from "./push_deps.ts";
import { deliverNotification, drainBacklog, failureResponse } from "./handler.ts";

interface Body {
  notification_id?: string;
  /** Supabase DB webhook payload shape (INSERT). */
  record?: { id?: string };
  /**
   * Retry everything the nightly job counted. Service-role only: a client
   * triggering a mass send would be both a mail-bomb and a way to burn the
   * operator's Resend quota.
   */
  action?: "drain";
}

serveFunction(async (req) => {
  const isService = isServiceAuth(
    req.headers.get("Authorization"),
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
  // The RESULT is used, not just the check. Discarding it is what M1 was.
  const operator = isService ? null : await requireOperator(req);

  const body = await readJson<Body>(req);

  // ── Push first, and BEFORE the email configuration check ───────────────
  //
  // Codex review on PR #85. The check below throws when RESEND_API_KEY is
  // missing (H17's deliberate loud failure), and it used to run first — so on
  // a deployment with push configured and email not, execution never reached
  // the push call at all. That contradicted the ordering guarantee documented
  // one paragraph down, and it meant even OPERATOR-ONLY notifications, which
  // skip email by definition, could not be pushed until an unrelated provider
  // was configured.
  const pushDeps = makePushDeps(adminClient(), vapidConfig(), req);

  // A missing key is still a 500, not a 200 — H17's rule, unchanged: this used
  // to return `{ skipped: true }`, so a deploy that forgot the secret reported
  // uniform success forever while sending zero email.
  //
  // What moved (Codex review on PR #85) is WHERE it fires. As a precondition
  // for the whole request it also blocked push, and it failed notifications
  // that have no email to send at all — an operator-only row skips email by
  // definition.
  //
  // Round five moved it inside `sendEmail`, which was too far: that call sits
  // in a try that records any throw as a retryable delivery failure, so the
  // loud 500 quietly became `resend unreachable` on the row and a 502 (webhook)
  // or 200 (drain) to the caller. The comment here asserted the opposite,
  // which is worse than the bug. It is now `assertEmailConfigured`, called by
  // `deliverNotification` after every terminal skip and OUTSIDE that try.
  const apiKey = Deno.env.get("RESEND_API_KEY") ?? null;
  const deps = makeSendDeps({
    db: adminClient(),
    apiKey,
    operatorId: operator?.id ?? null,
    // The env reads live HERE, in the wiring, so `deps.ts` takes values and
    // stays constructible in a test that holds no permissions.
    fromEmail: Deno.env.get("NOTIFY_FROM_EMAIL") ?? "Sanpo <notifications@sanpocare.com>",
    unsubscribeBase: Deno.env.get("NOTIFY_UNSUBSCRIBE_BASE")
      ?? `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/unsubscribe`,
  });

  if (body?.action === "drain") {
    if (!isService) {
      throw new HttpError(403, "forbidden", "draining the backlog requires the service role");
    }
    // 200 even when some rows failed: each records its own outcome and stays in
    // the backlog, so reporting success for the ATTEMPT is honest. A non-2xx
    // would make the caller retry the whole sweep immediately.
    return jsonOk(
      await drainBacklog(deps, (row) => deliverPush(row as unknown as PushableRow, pushDeps)),
    );
  }

  const id = body?.notification_id ?? body?.record?.id;
  if (!id) throw new HttpError(400, "bad_request", "notification_id is required");

  const row = await deps.getNotification(id);
  // One response for "no such notification" and for "not yours". Two distinct
  // answers would let an operator probe another tenant's id space, and the
  // caller can do nothing differently with the distinction anyway.
  if (!row) throw new HttpError(404, "not_found", "notification not found");

  // Push FIRST, and independently of email (review M27).
  //
  // The order matters because the email arm throws when RESEND_API_KEY is
  // missing — H17's deliberate loud failure. If push ran after it, a
  // deployment with push configured and email not would silently push nothing.
  // Running it first costs nothing on the reverse path: push is send-once on
  // `push_status = 'sent'`, so the webhook's retry after an email 500 records
  // "already sent" rather than pushing twice.
  //
  // A push failure does not fail the request. They are separate promises to
  // the same person, the row records which one broke, and turning a dead
  // Android endpoint into a 502 would put the EMAIL back in the backlog too.
  //
  // The catch is what makes that true (Codex review on PR #85). `deliverPush`
  // only handles per-ENDPOINT transport errors internally; a failure in
  // `getSubscriptions` or `recordPush` — a database blip in the optional
  // channel — rejected here and stopped `deliverNotification` from ever
  // running. The push row keeps whatever state it had and the nightly drain
  // retries it; the email goes out now, which is the whole point of the two
  // channels not gating each other.
  let pushOutcome: Outcome;
  try {
    pushOutcome = await deliverPush(row as unknown as PushableRow, pushDeps);
  } catch (e) {
    pushOutcome = {
      kind: "failed",
      error: e instanceof Error ? e.message : String(e),
      permanent: false,
    };
  }

  const outcome = await deliverNotification(row, deps);
  if (outcome.kind === "failed") throw failureResponse(row, outcome);
  return jsonOk({
    ...(outcome.kind === "sent" ? { sent: true } : { skipped: true, reason: outcome.reason }),
    push: pushOutcome.kind === "sent"
      ? { sent: true }
      : pushOutcome.kind === "skipped"
      ? { skipped: true, reason: pushOutcome.reason }
      : { failed: true, error: pushOutcome.error },
  });
});

/** Minimal Indigo Emaki email field, inline CSS only. */
