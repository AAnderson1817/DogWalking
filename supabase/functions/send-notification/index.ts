// send-notification — POST (service key via DB webhook, or operator JWT).
// Emails client-facing notifications through Resend; env-gated on
// RESEND_API_KEY and silently skipped when absent (phase 08).
import { isServiceAuth, jsonOk, readJson, requireOperator, serveFunction, HttpError } from "../_lib/http.ts";
import { adminClient } from "../_lib/admin.ts";

const CLIENT_FACING = new Set([
  "walk_complete",
  "low_credit",
  "renewal_upcoming",
  "payment_failed",
  "walk_scheduled",
  "walk_cancelled",
]);

interface Body {
  notification_id?: string;
  /** Supabase DB webhook payload shape (INSERT). */
  record?: { id?: string };
}

serveFunction(async (req) => {
  const isService = isServiceAuth(
    req.headers.get("Authorization"),
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
  if (!isService) await requireOperator(req);

  const body = await readJson<Body>(req);
  const id = body?.notification_id ?? body?.record?.id;
  if (!id) throw new HttpError(400, "bad_request", "notification_id is required");

  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) return jsonOk({ skipped: true, reason: "email delivery not configured" });

  const db = adminClient();
  const { data: n, error } = await db
    .from("notifications")
    .select("id, operator_id, client_id, type, title, body, walk_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new HttpError(500, "db_error", "notification lookup failed");
  if (!n) throw new HttpError(404, "not_found", "notification not found");
  if (!n.client_id || !CLIENT_FACING.has(n.type)) {
    return jsonOk({ skipped: true, reason: "not a client-facing notification" });
  }

  const [{ data: client }, { data: operator }] = await Promise.all([
    db.from("clients").select("full_name, email").eq("id", n.client_id).maybeSingle(),
    db.from("operators").select("business_name, email").eq("id", n.operator_id).maybeSingle(),
  ]);
  if (!client?.email) return jsonOk({ skipped: true, reason: "client has no email" });

  const business = operator?.business_name ?? "Your walker";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: Deno.env.get("NOTIFY_FROM_EMAIL") ?? "PawTrail <notifications@pawtrail.app>",
      to: [client.email],
      subject: `${n.title} — ${business}`,
      html: renderEmail(business, n.title, n.body ?? ""),
    }),
  });
  if (!res.ok) {
    console.error("email send failed:", res.status);
    throw new HttpError(502, "email_failed", "email provider rejected the message");
  }

  return jsonOk({ sent: true });
});

/** Minimal pine-styled template (spec 05 palette), inline CSS only. */
function renderEmail(business: string, title: string, body: string): string {
  return `<!doctype html>
<body style="margin:0;padding:24px;background:#F6F4EE;font-family:Inter,system-ui,sans-serif;color:#0F1F19;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0"
             style="background:#FFFFFF;border-radius:16px;overflow:hidden;">
        <tr><td style="background:#0E2A23;padding:16px 24px;">
          <span style="color:#EDF5F1;font-weight:700;font-size:16px;">${escapeHtml(business)}</span>
          <span style="float:right;width:10px;height:10px;border-radius:999px;background:#2DD4BF;margin-top:4px;"></span>
        </td></tr>
        <tr><td style="padding:24px;">
          <h1 style="margin:0 0 8px;font-size:20px;color:#0F1F19;">${escapeHtml(title)}</h1>
          <p style="margin:0;color:#46574F;font-size:14px;line-height:1.6;">${escapeHtml(body)}</p>
        </td></tr>
        <tr><td style="padding:0 24px 24px;">
          <p style="margin:0;color:#8A988F;font-size:12px;">Sent by PawTrail on behalf of ${escapeHtml(business)}.</p>
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
