// Web Push payload encryption (RFC 8291, `aes128gcm`) and VAPID (RFC 8292).
//
// Written against `crypto.subtle` rather than pulled from npm, for one reason
// that matters more than the dependency count: every primitive it needs is
// already exercised in this repository — ECDH and HKDF in `crypto.ts`, ECDSA
// signing in `stripe.ts` — and an npm package running under the edge runtime's
// Node compatibility layer is a thing this session cannot test the way it can
// test these.
//
// ── How this is known to be correct ──────────────────────────────────────
//
// Encryption that "did not throw" is indistinguishable from encryption that
// produces a body no browser can open, and the failure is SILENT: the push
// service accepts the request and the notification simply never appears. That
// is the false-assurance shape this repository keeps recording, so it is not
// how this is tested.
//
// `webpush_test.ts` pins a byte-exact vector produced by `http_ece`, the
// reference JS implementation of RFC 8188/8291 (the one `web-push` itself
// delegates to), with the salt and the sender's ephemeral key fixed so the
// output is deterministic. `scripts/gen-webpush-vector.mjs` regenerates it,
// so the vector's provenance is reproducible rather than asserted.
//
// That oracle is INDEPENDENT, which is the point. A test written from the same
// reading of the spec as the code shares its misunderstandings and passes
// anyway — the defect that left `check-auth-posture.sh` permanently red while
// its own suite was green.

const enc = new TextEncoder();

/** RFC 8291 §3.4. The trailing NUL is part of the string, not a separator. */
const KEY_INFO_PREFIX = enc.encode("WebPush: info\0");
const CEK_INFO = enc.encode("Content-Encoding: aes128gcm\0");
const NONCE_INFO = enc.encode("Content-Encoding: nonce\0");

/** RFC 8188 §2. One record, so `rs` only has to exceed the payload. */
export const RECORD_SIZE = 4096;
const SALT_LEN = 16;
const KEY_LEN = 65; // uncompressed P-256 point

export interface PushKeys {
  /** The subscription's `p256dh`, base64url — an uncompressed P-256 point. */
  p256dh: string;
  /** The subscription's `auth` secret, base64url — 16 bytes. */
  auth: string;
}

export function b64urlToBytes(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  bytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Encrypt one push payload into an `aes128gcm` body.
 *
 * `salt` and `senderPrivate` exist only so the vector test can pin them. In
 * production both are generated here: a reused salt with a reused key would
 * repeat a GCM nonce across messages, which is the one way to lose AES-GCM
 * outright. They are OPTIONAL rather than required so that no caller can
 * supply them by accident — the deps of every send path leave them unset.
 */
export async function encryptPushPayload(
  payload: string,
  keys: PushKeys,
  opts: { salt?: Uint8Array; senderPrivate?: CryptoKey; senderPublicRaw?: Uint8Array } = {},
): Promise<Uint8Array> {
  const recipientRaw = b64urlToBytes(keys.p256dh);
  if (recipientRaw.length !== KEY_LEN) {
    throw new Error(`p256dh must be ${KEY_LEN} bytes, got ${recipientRaw.length}`);
  }
  const authSecret = b64urlToBytes(keys.auth);
  if (authSecret.length < 16) {
    throw new Error(`auth secret must be at least 16 bytes, got ${authSecret.length}`);
  }

  let senderPrivate = opts.senderPrivate;
  let senderPublicRaw = opts.senderPublicRaw;
  if (!senderPrivate || !senderPublicRaw) {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ]) as CryptoKeyPair;
    senderPrivate = pair.privateKey;
    senderPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  }
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(SALT_LEN));
  if (salt.length !== SALT_LEN) {
    throw new Error(`salt must be ${SALT_LEN} bytes, got ${salt.length}`);
  }

  const recipientKey = await crypto.subtle.importKey(
    "raw",
    recipientRaw as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: recipientKey }, senderPrivate, 256),
  );

  // RFC 8291 §3.4: the auth secret is the HKDF *salt* for this first step, and
  // the key info binds the derivation to BOTH public keys — receiver first.
  // Getting that order backwards still produces 32 plausible bytes and a body
  // that silently never decrypts, which is why the vector test exists.
  const ikm = await hkdf(
    authSecret,
    shared,
    concat(KEY_INFO_PREFIX, recipientRaw, senderPublicRaw),
    32,
  );
  const cek = await hkdf(salt, ikm, CEK_INFO, 16);
  const nonce = await hkdf(salt, ikm, NONCE_INFO, 12);

  // RFC 8188 §2: the record's padding delimiter is 0x02 for the LAST record,
  // 0x01 otherwise. One record here, so it is always 0x02.
  const plaintext = concat(enc.encode(payload), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, [
    "encrypt",
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 },
      aesKey,
      plaintext as BufferSource,
    ),
  );

  const header = new Uint8Array(SALT_LEN + 4 + 1);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(SALT_LEN, RECORD_SIZE, false); // big-endian
  header[SALT_LEN + 4] = senderPublicRaw.length;
  return concat(header, senderPublicRaw, ciphertext);
}

// ── VAPID (RFC 8292) ─────────────────────────────────────────────────────
//
// The push service will not accept a message without proof that it comes from
// the application server the browser subscribed to. That proof is an ES256 JWT
// signed by the VAPID private key, sent alongside the matching public key.
//
// The keys are an OWNER ACTION: nothing in this repository can mint them,
// because the public half has to be baked into the client bundle at build time
// and the private half is a deploy secret. Absent them, the opt-in UI never
// offers to subscribe, so there are no devices, so every notification records
// `skipped` for want of a recipient — which is the honest state and not a
// silent failure. See docs/dev/owner-actions.md.

/** RFC 8292 §2: 24h is the ceiling; 12h leaves room for clock skew. */
export const VAPID_TTL_SECONDS = 12 * 60 * 60;

export interface VapidConfig {
  /** base64url, the same 65-byte point the browser subscribed with. */
  publicKey: string;
  /** base64url, the 32-byte P-256 private scalar. */
  privateKey: string;
  /** RFC 8292 §2.1 — `mailto:` or `https:`, so a push service can complain. */
  subject: string;
}

/** The `aud` claim is the push service ORIGIN, never the full endpoint. */
export function pushAudience(endpoint: string): string {
  return new URL(endpoint).origin;
}

function b64urlJson(value: unknown): string {
  return bytesToB64url(enc.encode(JSON.stringify(value)));
}

/**
 * Build the `Authorization: vapid t=…, k=…` header for one endpoint.
 *
 * `now` is injectable so the test can pin `exp`; production never passes it.
 */
export async function vapidAuthorization(
  endpoint: string,
  vapid: VapidConfig,
  now: number = Date.now(),
): Promise<string> {
  if (!/^(mailto:|https:)/.test(vapid.subject)) {
    // A push service that cannot reach a human on a misbehaving sender may
    // simply stop accepting from the key. Refusing here names the setting.
    throw new Error("VAPID subject must be a mailto: or https: URI");
  }
  const priv = b64urlToBytes(vapid.privateKey);
  const pub = b64urlToBytes(vapid.publicKey);
  if (priv.length !== 32) throw new Error(`VAPID private key must be 32 bytes, got ${priv.length}`);
  if (pub.length !== KEY_LEN) throw new Error(`VAPID public key must be 65 bytes, got ${pub.length}`);

  const key = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: bytesToB64url(priv),
      x: bytesToB64url(pub.slice(1, 33)),
      y: bytesToB64url(pub.slice(33, 65)),
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  const signingInput = `${b64urlJson({ typ: "JWT", alg: "ES256" })}.${
    b64urlJson({
      aud: pushAudience(endpoint),
      exp: Math.floor(now / 1000) + VAPID_TTL_SECONDS,
      sub: vapid.subject,
    })
  }`;
  // WebCrypto emits the raw r‖s pair JWS wants. Node's default is DER, which
  // is why an implementation ported from a Node example fails here with a
  // signature the push service rejects and nothing else to look at.
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      enc.encode(signingInput) as BufferSource,
    ),
  );
  return `vapid t=${signingInput}.${bytesToB64url(sig)}, k=${vapid.publicKey}`;
}
