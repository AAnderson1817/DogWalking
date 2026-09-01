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
import type { Outcome } from "./handler.ts";
import { deliverPush, type PushableRow } from "./push.ts";
import { adminClient } from "../_lib/admin.ts";
import { makePushDeps, vapidConfig } from "./push_deps.ts";
import {
  claimNotificationSend,
  releaseNotificationSend,
  deliverNotification,
  drainBacklog,
  failureResponse,
  type NotificationRow,
  recordPatch,
  type SendDeps,
} from "./handler.ts";

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

const COLS =
  "id, operator_id, client_id, type, title, body, walk_id, email_attempts, email_status, " +
  "push_attempts, push_status";

/**
 * `operatorId` scopes every lookup to one tenant. Null means the service role,
 * which legitimately sends for everybody (the DB webhook and the nightly
 * drain).
 *
 * Review M1: this function verified the caller was AN operator and then
 * discarded the result, fetching the row by id alone through the service-role
 * client — so any registered operator, and signup is open, could force an
 * email to another tenant's client. The four differentiated responses also
 * formed an existence-and-type oracle. The only thing standing in the way was
 * uuid unguessability, which is not an authorization control.
 *
 * The scope goes into the QUERY rather than into a check after it. A
 * post-fetch comparison is the version that leaks: it has already read the row
 * and must then be careful about every path out, and every other edge function
 * here gets this right by construction.
 */
function makeDeps(apiKey: string | null, operatorId: string | null): SendDeps {
  const db = adminClient();
  return {
    claimSend: (id, channel) => claimNotificationSend(db, id, channel),
    releaseSend: (id, channel) => releaseNotificationSend(db, id, channel),
    async getNotification(id) {
      let q = db.from("notifications").select(COLS).eq("id", id);
      if (operatorId) q = q.eq("operator_id", operatorId);
      const { data, error } = await q.maybeSingle();
      if (error) {
        throw new HttpError(500, "db_error", "notification lookup failed", error, {
          notification_id: id,
        });
      }
      return data as NotificationRow | null;
    },

    async backlogIds() {
      const { data, error } = await db.rpc("fn_notification_backlog", {});
      if (error) throw new HttpError(500, "db_error", "backlog lookup failed", error);
      return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
    },

    async getClient(id) {
      const { data } = await db
        .from("clients")
        .select("full_name, email, unsubscribe_token")
        .eq("id", id)
        .maybeSingle();
      return data;
    },

    // Review M29. Suppression is keyed on the ADDRESS, not the client: the
    // wrong recipient of a mistyped address has no client row of their own,
    // so suppressing "this client" would let the same person start receiving
    // again the moment the operator corrects and re-enters it.
    async isSuppressed(email, operatorId, type) {
      const { data, error } = await db.rpc("fn_email_suppressed", {
        p_email: email,
        p_operator: operatorId,
        p_type: type,
      });
      // FAIL CLOSED. An unreadable suppression list means we do not know
      // whether this person asked us to stop, and sending anyway is the one
      // outcome that cannot be taken back. The row records the reason, and the
      // nightly drain retries it.
      if (error) {
        throw new HttpError(500, "db_error", "suppression lookup failed", error, {
          notification_id: null,
        });
      }
      return data === true;
    },

    async getOperator(id) {
      const { data } = await db.from("operators").select("business_name").eq("id", id).maybeSingle();
      return data;
    },

    unsubscribeUrl(token) {
      // The FUNCTION host, not the app's. RFC 8058 one-click sends a POST
      // straight from the mail client, and a client-side SPA route cannot
      // serve a POST at all — nor anything with JavaScript disabled, which is
      // most mail clients. The recipient's only escape route has to work
      // without the app loading.
      //
      // `NOTIFY_UNSUBSCRIBE_BASE` lets the owner put a friendlier domain in
      // front of it later without touching this code; `SUPABASE_URL` is always
      // set inside an edge function, so there is no unset case.
      const base = (
        Deno.env.get("NOTIFY_UNSUBSCRIBE_BASE")
        ?? `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/unsubscribe`
      ).replace(/\/+$/, "");
      return `${base}?t=${encodeURIComponent(token)}`;
    },

    assertEmailConfigured() {
      if (apiKey) return;
      // H17's loud failure, at the last point it can still BE loud. This used
      // to live inside `sendEmail`, where `deliverNotification`'s catch turned
      // it into an ordinary retryable delivery failure (Codex review on PR
      // #85) — a deploy that forgot the key answering 502, or 200 from the
      // drain, which is the uniform success H17 exists to prevent.
      throw new HttpError(
        500,
        "email_not_configured",
        "email delivery is not configured, so this notification was not emailed",
        "the Resend API key env var is unset in this deployment",
      );
    },

    async sendEmail({ to, subject, html, headers }) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey ?? ""}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: Deno.env.get("NOTIFY_FROM_EMAIL") ?? "Sanpo <notifications@sanpocare.com>",
          to: [to],
          subject,
          html,
          headers,
        }),
      });
      if (res.ok) return { ok: true };
      // Resend's body says WHY — domain out of verification, rate limited, bad
      // recipient — and dropping it left "email_failed" as the entire record.
      // Read defensively: a non-JSON error page must not turn a send failure
      // into an unhandled 500.
      return { ok: false, status: res.status, detail: await res.text().catch(() => "") };
    },

    async record(id, outcome, previousAttempts) {
      const patch = recordPatch(outcome, previousAttempts);
      const { error } = await db.from("notifications").update(patch).eq("id", id);
      // Deliberately loud. If the outcome cannot be written the row goes back to
      // looking un-attempted, which is the original defect — better to fail the
      // request and let the backlog retry than to send an email nothing records.
      if (error) {
        throw new HttpError(500, "db_error", "could not record the delivery outcome", error, {
          notification_id: id,
          outcome: outcome.kind,
        });
      }
    },

    renderEmail,
  };
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
  const deps = makeDeps(apiKey, operator?.id ?? null);

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
function renderEmail(
  business: string,
  title: string,
  body: string,
  unsubscribeUrl: string,
): string {
  return `<!doctype html>
<body style="margin:0;padding:24px;background:#FEF6EA;font-family:Nunito,system-ui,sans-serif;color:#0C4774;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0"
             style="background:#FFFFFF;border:1px solid #CAD7DC;border-radius:12px;overflow:hidden;">
        <tr><td style="background:#0C4774;padding:16px 24px;">
          <span style="color:#FEF6EA;font-weight:700;font-size:16px;">${escapeHtml(business)}</span>
          <span style="float:right;width:10px;height:10px;border-radius:999px;background:#E5AB35;margin-top:4px;"></span>
        </td></tr>
        <tr><td style="padding:24px;">
          <h1 style="margin:0 0 8px;font-size:20px;color:#0C4774;">${escapeHtml(title)}</h1>
          <p style="margin:0;color:#5D7180;font-size:14px;line-height:1.6;">${escapeHtml(body)}</p>
        </td></tr>
        <tr><td style="padding:0 24px 24px;">
          <p style="margin:0;color:#5D7180;font-size:12px;">Sent by Sanpo on behalf of ${escapeHtml(business)}.</p>
          <!-- Review M29. A visible link as well as the List-Unsubscribe
               header: the header is honoured by the big mail clients, and the
               link is what a person on anything else can actually use. If the
               address is wrong, this is the recipient's only route out. -->
          <p style="margin:8px 0 0;color:#5D7180;font-size:12px;">
            Not expecting these?
            <a href="${escapeHtml(unsubscribeUrl)}" style="color:#0C4774;">Unsubscribe</a>.
          </p>
          <p style="margin:8px 0 0;color:#5D7180;font-size:11px;">${escapeHtml(postalAddress())}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>`;
}

/**
 * The sender's physical postal address (review M29).
 *
 * Required in commercial mail by CAN-SPAM and expected by spam filters in
 * transactional mail too. It is an env var rather than a literal because only
 * the owner knows it, and it is listed in `docs/dev/owner-actions.md`.
 *
 * The fallback is deliberately a visible placeholder rather than a plausible
 * address: an unset value should look unset in a test send, not ship a wrong
 * address that nobody notices.
 */
function postalAddress(): string {
  return Deno.env.get("NOTIFY_POSTAL_ADDRESS") ?? "[postal address not configured]";
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
