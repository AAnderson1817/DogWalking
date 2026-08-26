// The unsubscribe endpoint's behaviour, with its one dependency injected.
//
// Split out of index.ts because importing index.ts runs `serveFunction`, which
// binds a port — the same reason send-notification has a handler.ts. Before
// this split the endpoint had no test at all, which is how it shipped
// answering 405 to every recipient who clicked the link (review M4).
import { HttpError } from "../_lib/http.ts";

export type UnsubscribeDeps = {
  /** Records the suppression. Answers identically for a known and an unknown
   * token — see the oracle note in index.ts. */
  suppress: (token: string) => Promise<{ error: unknown } | void>;
};

/**
 * A confirmation page, because a GET here is a person clicking a link in an
 * email client, not a program. Deliberately self-contained: a strict CSP
 * cannot reach the app's stylesheets from this origin.
 */
export function page(title: string, message: string): Response {
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

const DONE_TITLE = "You're unsubscribed";
const DONE_BODY = "You won't receive any more emails at this address.";

/** The token, from the query string or a one-click form post. */
export async function readToken(req: Request): Promise<string | null> {
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

export async function handleUnsubscribe(req: Request, deps: UnsubscribeDeps): Promise<Response> {
  const token = await readToken(req);

  // Shape-checked before it reaches the database, so a malformed token is a
  // refusal here rather than a `22P02` from the uuid cast inside a definer
  // function — the same reasoning as the regex guard in 0020.
  if (!token || !UUID.test(token)) {
    // Still not an oracle: an unparseable token and an unknown one both get
    // the same page a successful one does.
    return reply(req);
  }

  const result = await deps.suppress(token);
  if (result && result.error) {
    // The one case worth failing loudly: the person asked to stop and we did
    // not record it. A cheerful confirmation page over a failed write is the
    // worst outcome this endpoint can produce.
    throw new HttpError(500, "db_error", "could not record the unsubscribe", result.error);
  }
  return reply(req);
}

function reply(req: Request): Response {
  if (req.method === "POST") {
    // One-click expects a bare 200; a mail client is not going to render this.
    return new Response(null, { status: 200 });
  }
  return page(DONE_TITLE, DONE_BODY);
}
