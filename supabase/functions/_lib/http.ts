// CORS + JSON helpers + JWT verification (spec 04 shared _lib).
// Response envelope everywhere: { ok: true, data } | { ok: false, error: { code, message } }.
import { adminClient } from "./admin.ts";
import {
  type ErrorContext,
  functionName,
  logServerError,
  requestId,
} from "./observe.ts";

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/**
 * `cause` and `context` are the whole of review H14.
 *
 * `message` is OURS — the sentence the client is allowed to read. `cause` is
 * the underlying Postgres/Stripe error, which never reaches the client and is
 * the only thing that can answer "why did this actually fail". Before this
 * there was nowhere to put it, so all 41 deliberate 5xx throws discarded it at
 * the throw site.
 *
 * `context` is what makes the log line findable later: an operator reports
 * "completing the walk failed yesterday", and the question is answerable only
 * if the line carries the walk id.
 */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    cause?: unknown,
    public context?: ErrorContext,
  ) {
    super(message, cause == null ? undefined : { cause });
  }
}

export function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function jsonErr(
  code: string,
  message: string,
  status: number,
  reqId?: string,
): Response {
  // request_id in the envelope AND the header. A person looking at a failure
  // can quote the id, and the line that recorded it carries the same one —
  // which is the difference between "completing the walk failed yesterday" and
  // a searchable incident.
  const error: Record<string, string> = { code, message };
  if (reqId) error.request_id = reqId;
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      ...(reqId ? { "x-request-id": reqId } : {}),
    },
  });
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "bad_json", "request body must be valid JSON");
  }
}

/**
 * True when the Authorization header carries the service-role key (cron
 * jobs, DB webhooks). Two accepted shapes:
 *   1. exact match against the platform-injected key (covers the new
 *      `sb_secret_…` API keys, which are not JWTs), or
 *   2. a bearer JWT whose `role` claim is `service_role`.
 * Shape 2 does NOT verify the signature itself — that is safe only because
 * every function using this helper deploys with verify_jwt enabled, so the
 * platform gateway rejects forged tokens before they reach us. Never pair
 * this helper with verify_jwt=false. The claim fallback exists because the
 * dashboard-displayed key and the injected env can legitimately differ
 * (API-key migration, JWT secret rotation), which made exact-match-only
 * auth return spurious 401s to scheduled invocations.
 */
export function isServiceAuth(authHeader: string | null, injectedKey: string): boolean {
  const header = authHeader ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const token = header.slice(7).trim();
  if (token.length === 0) return false;
  if (injectedKey.length > 0 && token === injectedKey) return true;
  return jwtClaimRole(token) === "service_role";
}

/** Unverified read of a JWT payload; null on any malformation. */
function jwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replaceAll("-", "+").replaceAll("_", "/");
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function jwtClaimRole(token: string): string | null {
  const role = jwtClaims(token)?.role;
  return typeof role === "string" ? role : null;
}

/**
 * The session's authenticator assurance level, from the `aal` claim.
 *
 * `aal1` = one factor (a password). `aal2` = a second factor was presented in
 * THIS session. The distinction is what makes a re-auth mean anything: an
 * attacker holding only a stolen session can change the account password
 * without knowing the old one (Supabase `secure_password_change`, off by
 * default and never deployed — review H2) and then satisfy a password check
 * with the password they just set. They cannot manufacture aal2.
 *
 * Unverified, like the role read above, and safe for the same reason: every
 * function using this deploys with `verify_jwt` enabled, so the platform
 * gateway has already rejected a forged token. Never pair either with
 * `verify_jwt = false`.
 *
 * Returns null when the claim is absent, which is what a project with no MFA
 * configured looks like — the caller decides what to do about that rather than
 * having a default guessed here.
 */
export function sessionAssurance(authHeader: string | null): "aal1" | "aal2" | null {
  const header = authHeader ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const aal = jwtClaims(header.slice(7).trim())?.aal;
  return aal === "aal1" || aal === "aal2" ? aal : null;
}

/** Verified JWT user from the Authorization header. */
export async function requireUser(req: Request): Promise<{ id: string; email?: string }> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new HttpError(401, "unauthenticated", "missing bearer token");
  const { data, error } = await adminClient().auth.getUser(token);
  if (error || !data?.user) {
    throw new HttpError(401, "unauthenticated", "invalid or expired token");
  }
  return { id: data.user.id, email: data.user.email ?? undefined };
}

/** requireUser + the caller must own an operators row. Returns the operator id. */
export interface OperatorPrincipal {
  id: string;
  email?: string;
  /** Standard connected account; null until the operator finishes onboarding. */
  stripe_account_id: string | null;
  stripe_charges_enabled: boolean;
}

/**
 * The Connect fields come back here rather than being looked up per call site
 * (review B5). Operators are the merchant of record, so every money path needs
 * them — and a path that forgets to fetch them is a path that charges the
 * platform account instead, which is the defect Connect exists to remove.
 * Making them part of the principal means the only way to reach Stripe is
 * already holding the account the charge belongs on.
 */
export async function requireOperator(req: Request): Promise<OperatorPrincipal> {
  const user = await requireUser(req);
  const { data, error } = await adminClient()
    .from("operators")
    .select("id, stripe_account_id, stripe_charges_enabled")
    .eq("id", user.id)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "db_error", "operator lookup failed", error, {
      auth_user_id: user.id,
    });
  }
  if (!data) throw new HttpError(403, "not_operator", "caller is not an operator");
  return {
    ...user,
    stripe_account_id: data.stripe_account_id,
    stripe_charges_enabled: data.stripe_charges_enabled,
  };
}

/**
 * Turn a Connect refusal into an envelope the client can act on. The two
 * cases need different words: one is "finish onboarding", the other is
 * "Stripe is still reviewing you", and collapsing them would send an operator
 * back through an onboarding flow they have already completed.
 */
/** Just enough of an operator to say which Stripe account their money is on. */
export interface ConnectFields {
  stripe_account_id: string | null;
  stripe_charges_enabled: boolean;
}

/**
 * For paths that TAKE money. Requires a connected account that Stripe has
 * actually enabled for charges. Returns Stripe's per-request options so the
 * account travels in the same expression as the charge.
 */
export function requireAccount(op: ConnectFields): { stripeAccount: string } {
  if (!op.stripe_account_id) throw connectError("no_account");
  if (!op.stripe_charges_enabled) throw connectError("charges_disabled");
  return { stripeAccount: op.stripe_account_id };
}

/**
 * For paths that only need to REACH an existing object on the operator's
 * account — the billing portal being the case that matters. Deliberately does
 * NOT require charges_enabled: a client updating a card or cancelling a
 * subscription should not be blocked because Stripe is still reviewing their
 * walker, and refusing there would strand them with a subscription they
 * cannot stop.
 */
export function accountOf(op: ConnectFields): { stripeAccount: string } {
  if (!op.stripe_account_id) throw connectError("no_account");
  return { stripeAccount: op.stripe_account_id };
}

export function connectError(reason: "no_account" | "charges_disabled"): HttpError {
  return reason === "no_account"
    ? new HttpError(
      409,
      "stripe_not_connected",
      "Connect a Stripe account before taking payments — clients pay you directly, so the money needs somewhere to land.",
    )
    : new HttpError(
      409,
      "stripe_charges_disabled",
      "Stripe has not enabled charges on your account yet. This usually clears once they finish reviewing the details you submitted.",
    );
}

/**
 * Deno.serve wrapper: OPTIONS preflight, envelope errors, no internals leaked
 * to the client — and, since review H14, exactly one structured log line for
 * every failure the server is responsible for.
 *
 * The threshold is status >= 500. A 4xx is the caller being told something
 * true about their own request (not an operator, bad JSON, cutoff passed);
 * logging those would bury the failures that are ours in a pile of ones that
 * are not. Anything that is not an HttpError at all is a bug and is logged as
 * a 500 regardless.
 */
export function serveFunction(handler: (req: Request) => Promise<Response>): void {
  Deno.serve((req) => handleRequest(req, handler));
}

/**
 * The whole of serveFunction's behaviour, outside `Deno.serve` so it can be
 * tested. Inside the serve callback none of this was reachable from a test —
 * which is why the "no logging at all" defect could exist unnoticed in the one
 * place every function's failures pass through.
 */
export async function handleRequest(
  req: Request,
  handler: (req: Request) => Promise<Response>,
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  const reqId = requestId(req);
  if (req.method !== "POST") {
    return jsonErr("method_not_allowed", "POST only", 405, reqId);
  }
  const fn = functionName(req.url);
  try {
    const res = await handler(req);
    // Echoed on success too, so a support conversation can start from any
    // response rather than only from a failed one.
    res.headers.set("x-request-id", reqId);
    return res;
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status >= 500) {
        logServerError({
          fn,
          request_id: reqId,
          status: e.status,
          code: e.code,
          message: e.message,
          cause: e.cause,
          context: e.context,
        });
      }
      return jsonErr(e.code, e.message, e.status, reqId);
    }
    // Not an HttpError: nobody decided this would happen. The thrown value
    // IS the cause here — there is no envelope message to distinguish it
    // from — so it is passed as such rather than flattened to `.message`,
    // which is all the old line recorded.
    logServerError({
      fn,
      request_id: reqId,
      status: 500,
      code: "internal",
      message: "unhandled error",
      cause: e,
    });
    return jsonErr("internal", "internal error", 500, reqId);
  }
}
