// Stripe SDK init + webhook signature verification (spec 04 shared _lib).
import Stripe from "npm:stripe@17";

let cached: Stripe | null = null;

export function stripeClient(): Stripe {
  if (!cached) {
    const key = Deno.env.get("STRIPE_SECRET_KEY");
    if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
    cached = new Stripe(key); // SDK-pinned API version
  }
  return cached;
}

/**
 * Verify a `Stripe-Signature` header against the raw payload.
 * Scheme: header carries `t=<unix>,v1=<hex hmac>` (v1 may repeat);
 * signed payload is `${t}.${body}`, HMAC-SHA256 with the endpoint secret.
 * Implemented locally (WebCrypto) so it is hermetically testable.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  toleranceSec = 300,
  nowMs: () => number = Date.now,
): Promise<boolean> {
  if (!header) return false;
  const parts = new Map<string, string[]>();
  for (const kv of header.split(",")) {
    const [k, ...rest] = kv.trim().split("=");
    const v = rest.join("=");
    if (!k || !v) continue;
    parts.set(k, [...(parts.get(k) ?? []), v]);
  }
  const t = parts.get("t")?.[0];
  const sigs = parts.get("v1") ?? [];
  if (!t || sigs.length === 0) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowMs() / 1000 - ts) > toleranceSec) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)),
  );
  let expected = "";
  for (const b of mac) expected += b.toString(16).padStart(2, "0");

  return sigs.some((s) => timingSafeEqualHex(s, expected));
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Sign a payload the way Stripe does — used by the local test suite only. */
export async function signStripePayload(
  payload: string,
  secret: string,
  atMs: number = Date.now(),
): Promise<string> {
  const t = Math.floor(atMs / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)),
  );
  let hex = "";
  for (const b of mac) hex += b.toString(16).padStart(2, "0");
  return `t=${t},v1=${hex}`;
}
