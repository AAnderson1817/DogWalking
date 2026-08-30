// Stripe SDK init + webhook signature verification (spec 04 shared _lib).
import Stripe from "npm:stripe@17";

let cached: Stripe | null = null;

/**
 * The platform client. Use this ONLY for platform-level work: creating a
 * connected account, minting an AccountLink, verifying webhooks — and, since
 * review H31, the operator's own $49/month Sanpo subscription
 * (operator-billing / platform-webhook), which is the one money that
 * legitimately moves on the platform account, because there Sanpo is the
 * merchant and the operator is the customer.
 *
 * CLIENT money never moves here. Operators are the merchant of record for
 * their clients (review B5), so every client customer, subscription,
 * PaymentIntent and portal session belongs to the operator's own Standard
 * connected account and must carry `stripeAccount`.
 */
export function stripeClient(): Stripe {
  if (!cached) {
    const key = Deno.env.get("STRIPE_SECRET_KEY");
    if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
    cached = new Stripe(key); // SDK-pinned API version
  }
  return cached;
}

/** Thrown when a money path is reached before the operator can take money. */
export class NotConnectedError extends Error {
  constructor(readonly reason: "no_account" | "charges_disabled") {
    super(
      reason === "no_account"
        ? "operator has not connected a Stripe account"
        : "the operator's Stripe account cannot accept charges yet",
    );
  }
}

export interface ConnectState {
  stripe_account_id: string | null;
  stripe_charges_enabled: boolean;
}

/**
 * The per-request options every money call must carry, so the charge is
 * created ON the operator's account: their business on the client's
 * statement, their chargeback liability, their Stripe fees, their bank
 * account.
 *
 * Passed explicitly at each call site rather than hidden inside a wrapper
 * client. `{ stripeAccount }` is the single most consequential argument in
 * this codebase — a reader checking whether a charge lands on the right
 * account should see it in the same expression as the charge, and a call site
 * that forgets it should read as obviously wrong rather than as a default.
 *
 * It REFUSES rather than falling back to the platform account. A fallback is
 * exactly how the original defect would come back: silently, and visible only
 * to whoever eventually reconciled a bank statement.
 */
export function onAccount(operator: ConnectState): { stripeAccount: string } {
  if (!operator.stripe_account_id) throw new NotConnectedError("no_account");
  if (!operator.stripe_charges_enabled) throw new NotConnectedError("charges_disabled");
  return { stripeAccount: operator.stripe_account_id };
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
