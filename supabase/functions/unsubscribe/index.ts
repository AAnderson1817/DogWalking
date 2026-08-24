// unsubscribe — the only public, unauthenticated endpoint in this project.
//
// Review M29. `clients.email` is typed by the operator and reconciled with
// nothing, so one typo sends a stranger a recurring feed of `walk_complete`
// notifications: when a named person's house is empty, several times a week.
// That person cannot sign in — they are not a client, they claimed no invite —
// so an opt-out behind a session is no opt-out at all for exactly the recipient
// who most needs one.
//
// Hence a bearer token in the URL, carried only in mail already addressed to
// them, and `verify_jwt = false` in `config.toml` (which `supabase functions
// deploy` does read, unlike the `[auth]` block — see review H2).
//
// ── What this endpoint deliberately does not do ──────────────────────────
//
//   * It never says whether a token exists. `fn_unsubscribe_by_token` answers
//     identically either way, because an unauthenticated endpoint that
//     distinguishes them is an oracle for guessing them.
//   * It takes no other input. No email address, no client id, no scope — a
//     public endpoint that accepts an address is a way to unsubscribe somebody
//     else.
//   * It is not rate-limited, because there is nothing to gain by calling it:
//     a valid token only ever suppresses its own address, and the operation is
//     idempotent.
import { adminClient } from "../_lib/admin.ts";
import { serveFunction, HttpError } from "../_lib/http.ts";

/**
 * A confirmation page, because a GET here is a person clicking a link in an
 * email client, not a program. Deliberately self-contained: a strict CSP
 * cannot reach the app's stylesheets from this origin.
 */
function page(title: string, message: string): Response {
  return new Response(
    `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Sanpo</title>
</head>
<body style="margin:0;padding:48px 24px;background:#FEF6EA;font-family:system-ui,sans-serif;color:#0C4774;">
  <main style="max-width:420px;margin:0 auto;background:#FFFFFF;border:1px solid #CAD7DC;border-radius:12px;padding:24px;">
    <h1 style="margin:0 0 8px;font-size:20px;">${title}</h1>
    <p style="margin:0;color:#5D7180;font-size:14px;line-height:1.6;">${message}</p>
  </main>
</body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

/** The token, from the query string or a one-click form post. */
async function readToken(req: Request): Promise<string | null> {
  const fromQuery = new URL(req.url).searchParams.get("t");
  if (fromQuery) return fromQuery;
  if (req.method !== "POST") return null;

  // RFC 8058 one-click sends `List-Unsubscribe=One-Click` as a form body with
  // no token of its own, so the token has to be in the URL for that path too.
  // Reading the body anyway costs nothing and covers a client that echoes it.
  try {
    const type = req.headers.get("content-type") ?? "";
    if (type.includes("application/json")) {
      const body = await req.json();
      return typeof body?.token === "string" ? body.token : null;
    }
    if (type.includes("form")) {
      const form = await req.formData();
      const t = form.get("token");
      return typeof t === "string" ? t : null;
    }
  } catch {
    // A malformed body is not a reason to fail an unsubscribe.
  }
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

serveFunction(async (req) => {
  const token = await readToken(req);

  // Shape-checked before it reaches the database, so a malformed token is a
  // refusal here rather than a `22P02` from the uuid cast inside a definer
  // function — the same reasoning as the regex guard in 0020.
  if (!token || !UUID.test(token)) {
    // Still not an oracle: an unparseable token and an unknown one both get
    // the same page a successful one does.
    return page("You're unsubscribed", "You won't receive any more emails at this address.");
  }

  const db = adminClient();
  const { error } = await db.rpc("fn_unsubscribe_by_token", { p_token: token });
  if (error) {
    // The one case worth failing loudly: the person asked to stop and we did
    // not record it. A cheerful confirmation page over a failed write is the
    // worst outcome this endpoint can produce.
    throw new HttpError(500, "db_error", "could not record the unsubscribe", error);
  }

  if (req.method === "POST") {
    // One-click expects a bare 200; a mail client is not going to render this.
    return new Response(null, { status: 200 });
  }
  return page("You're unsubscribed", "You won't receive any more emails at this address.");
});
