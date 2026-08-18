// One structured log line per server-side failure (review H14).
//
// Before this, all 41 deliberate `HttpError(5xx)` throws dropped the
// underlying Postgres or Stripe error at the throw site — `HttpError` had
// nowhere to put one — and `serveFunction`'s catch returned the envelope with
// no logging at all. So when an operator says "completing the walk failed
// yesterday" there was nothing to look at: no log line was written, and the
// specific Postgres error had never been captured in the first place. On the
// money paths, "we cannot reconstruct what happened" is not an answer.
//
// Two functions did log (stripe-webhook, send-notification), and both bypass
// the shared wrapper — which is exactly the evidence that the gap was in the
// wrapper rather than in the call sites.

/** Values worth correlating a failure by: a walk, a client, an invoice. */
export type ErrorContext = Record<string, string | number | boolean | null | undefined>;

/**
 * The safe projection of an unknown thrown value.
 *
 * `message`, `name` and `code` only — never `details`, `hint`, `data` or
 * `body`. That is not tidiness: Postgres puts the offending VALUES in a unique
 * violation's `details` ("Key (col)=(...) already exists"), so logging that
 * field is how ciphertext or a client's address ends up in a log aggregator.
 * No unique constraint on a ciphertext column exists today, which is exactly
 * why the rule belongs here rather than in a reviewer's memory.
 *
 * Invariant 2 says plaintext secrets are never logged. This is the mechanism.
 */
export function safeCause(cause: unknown, depth = 0): Record<string, unknown> | null {
  if (cause == null) return null;
  if (typeof cause === "string") return { message: truncate(cause) };
  if (typeof cause !== "object") return { message: truncate(String(cause)) };

  const c = cause as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  const out: Record<string, unknown> = {};
  if (typeof c.name === "string" && c.name) out.name = truncate(c.name, 80);
  if (typeof c.code === "string" && c.code) out.code = truncate(c.code, 80);
  else if (typeof c.code === "number") out.code = String(c.code);
  if (typeof c.message === "string" && c.message) out.message = truncate(c.message);

  // Follow the chain. Our own wrappers say "client lookup failed" and the
  // Postgres error underneath them says why, so stopping at the first level
  // would record the label and drop the finding — which is the H14 defect
  // wearing our own error's clothes.
  //
  // Depth-capped rather than cycle-detected: a cap cannot be defeated by a
  // self-referential cause, and three levels is more nesting than any path
  // here builds.
  if (depth < 3 && c.cause != null) {
    const inner = safeCause(c.cause, depth + 1);
    if (inner) out.cause = inner;
  }
  return Object.keys(out).length > 0 ? out : { message: "(no message)" };
}

/** Bounded so one pathological error cannot blow the log line's size budget. */
function truncate(s: string, max = 300): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

/**
 * The error's CODE alone, for throw sites where even the message is untrusted.
 *
 * `safeCause` already drops `details`, which is where Postgres puts the
 * offending values. This is the stricter setting, for the two vault statements
 * that carry ciphertext in the statement itself: a syntax or constraint error
 * on those could in principle quote part of the payload back in its message,
 * and a Postgres SQLSTATE is enough to diagnose from.
 *
 * Deliberately not the default. Everywhere else the message is the single most
 * useful thing in the line, and dropping it to be safe about paths that carry
 * no secret would trade the whole point of H14 for nothing.
 */
export function causeCode(cause: unknown): string {
  const c = cause as { code?: unknown } | null;
  if (c && typeof c.code === "string" && c.code) return `sqlstate ${truncate(c.code, 40)}`;
  return "(no code)";
}

export interface ServerErrorEntry {
  /** Which edge function. Derived from the request URL — see functionName(). */
  fn: string;
  /** Correlates every line emitted for one request, and echoed to the client. */
  request_id: string;
  status: number;
  /** The envelope's machine code, e.g. db_error, billing_error. */
  code: string;
  /** The envelope's human message — ours, not the underlying system's. */
  message: string;
  cause?: unknown;
  context?: ErrorContext;
}

/**
 * Emit exactly one JSON line. A single line per failure is what makes the
 * platform log searchable at all, and JSON is what makes it searchable by
 * walk_id once a drain is wired.
 *
 * `console.error` because that is all an edge function has; the drain and the
 * error monitor are dashboard steps that no file here can perform, and they
 * are listed in both runbooks.
 */
export function logServerError(entry: ServerErrorEntry): void {
  const line: Record<string, unknown> = {
    level: "error",
    fn: entry.fn,
    request_id: entry.request_id,
    status: entry.status,
    code: entry.code,
    message: entry.message,
  };
  const cause = safeCause(entry.cause);
  if (cause) line.cause = cause;
  if (entry.context) {
    const ctx: ErrorContext = {};
    for (const [k, v] of Object.entries(entry.context)) {
      if (v !== undefined && v !== null) ctx[k] = v;
    }
    if (Object.keys(ctx).length > 0) line.context = ctx;
  }
  console.error(JSON.stringify(line));
}

/**
 * The request id for this request: the caller's if they supplied one, ours
 * otherwise. Echoed in the response headers and in the error envelope, so a
 * failure a person is looking at can be tied to the line that recorded it.
 *
 * A caller-supplied value is bounded and stripped of anything that could
 * forge a second log line — a newline in an id would split one JSON line into
 * two and let a client write arbitrary log entries.
 */
export function requestId(req: Request): string {
  const given = req.headers.get("x-request-id");
  if (given) {
    const clean = given.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
    if (clean.length >= 8) return clean;
  }
  return crypto.randomUUID();
}

/**
 * Which function is running, from the request URL.
 *
 * Derived rather than passed in at each call site: a per-site constant is one
 * more thing to copy wrongly, and a log line naming the wrong function is
 * worse than one naming none. Supabase routes as /functions/v1/<name> and the
 * isolate sees /<name>, so the last non-empty segment covers both.
 */
export function functionName(url: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    return last && last !== "v1" ? last : "unknown";
  } catch {
    return "unknown";
  }
}
