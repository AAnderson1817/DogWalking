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
import { adminClient } from "../_lib/admin.ts";
import {
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
  "id, operator_id, client_id, type, title, body, walk_id, email_attempts, email_delivery_status";

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
function makeDeps(apiKey: string, operatorId: string | null): SendDeps {
  const db = adminClient();
  return {
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
      const { data } = await db.from("clients").select("full_name, email").eq("id", id).maybeSingle();
      return data;
    },

    async getOperator(id) {
      const { data } = await db.from("operators").select("business_name").eq("id", id).maybeSingle();
      return data;
    },

    async sendEmail({ to, subject, html }) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: Deno.env.get("NOTIFY_FROM_EMAIL") ?? "Sanpo <notifications@sanpocare.com>",
          to: [to],
          subject,
          html,
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

  // A missing key is a 500, not a 200. It used to return
  // `{ skipped: true, reason: "email delivery not configured" }`, so a
  // production deploy that forgot the secret reported uniform success forever
  // while sending zero email — and because these notifications include
  // payment_failed and walk_cancelled, nobody outside the app ever heard
  // anything at all. This now fails loudly and, since review H14, writes a
  // structured log line naming what is missing.
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    throw new HttpError(
      500,
      "email_not_configured",
      "email delivery is not configured, so this notification was not emailed",
      "the Resend API key env var is unset in this deployment",
      { notification_id: body?.notification_id ?? body?.record?.id },
    );
  }

  const deps = makeDeps(apiKey, operator?.id ?? null);

  if (body?.action === "drain") {
    if (!isService) {
      throw new HttpError(403, "forbidden", "draining the backlog requires the service role");
    }
    // 200 even when some rows failed: each records its own outcome and stays in
    // the backlog, so reporting success for the ATTEMPT is honest. A non-2xx
    // would make the caller retry the whole sweep immediately.
    return jsonOk(await drainBacklog(deps));
  }

  const id = body?.notification_id ?? body?.record?.id;
  if (!id) throw new HttpError(400, "bad_request", "notification_id is required");

  const row = await deps.getNotification(id);
  // One response for "no such notification" and for "not yours". Two distinct
  // answers would let an operator probe another tenant's id space, and the
  // caller can do nothing differently with the distinction anyway.
  if (!row) throw new HttpError(404, "not_found", "notification not found");

  const outcome = await deliverNotification(row, deps);
  if (outcome.kind === "failed") throw failureResponse(row, outcome);
  return jsonOk(outcome.kind === "sent" ? { sent: true } : { skipped: true, reason: outcome.reason });
});

/** Minimal Indigo Emaki email field, inline CSS only. */
function renderEmail(business: string, title: string, body: string): string {
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
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
