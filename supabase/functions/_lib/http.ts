// CORS + JSON helpers + JWT verification (spec 04 shared _lib).
// Response envelope everywhere: { ok: true, data } | { ok: false, error: { code, message } }.
import { adminClient } from "./admin.ts";

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function jsonErr(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
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

/** Unverified read of a JWT payload's `role` claim; null on any malformation. */
function jwtClaimRole(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replaceAll("-", "+").replaceAll("_", "/");
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
    const claims = JSON.parse(atob(padded)) as { role?: unknown };
    return typeof claims.role === "string" ? claims.role : null;
  } catch {
    return null;
  }
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
export async function requireOperator(req: Request): Promise<{ id: string; email?: string }> {
  const user = await requireUser(req);
  const { data, error } = await adminClient()
    .from("operators")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();
  if (error) throw new HttpError(500, "db_error", "operator lookup failed");
  if (!data) throw new HttpError(403, "not_operator", "caller is not an operator");
  return user;
}

/** Deno.serve wrapper: OPTIONS preflight, envelope errors, no internals leaked. */
export function serveFunction(handler: (req: Request) => Promise<Response>): void {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
      return jsonErr("method_not_allowed", "POST only", 405);
    }
    try {
      return await handler(req);
    } catch (e) {
      if (e instanceof HttpError) return jsonErr(e.code, e.message, e.status);
      console.error("unhandled error:", e instanceof Error ? e.message : "unknown");
      return jsonErr("internal", "internal error", 500);
    }
  });
}
