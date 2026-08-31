// RFC 8291 `aes128gcm`, pinned against the reference implementation.
//
// The vector below was produced by `http_ece` — the reference JS implementation
// of RFC 8188/8291, and the one `web-push` delegates to — with the salt and the
// sender's ephemeral key fixed so the output is deterministic. Regenerate it
// with `scripts/gen-webpush-vector.mjs`.
//
// Why it is byte-exact rather than "it encrypted something": a payload built
// with the wrong HKDF info, the wrong salt role, or the public keys in the
// wrong order still produces a well-formed body of the right length that no
// browser can ever open, and the push service still returns 201. The failure
// is invisible from the sending side, so the only test worth having is one
// that compares against an implementation we did not write.
import { assert, assertEquals, assertRejects } from "./asserts.ts";
import {
  b64urlToBytes,
  bytesToB64url,
  encryptPushPayload,
  pushAudience,
  RECORD_SIZE,
  vapidAuthorization,
} from "../_lib/webpush.ts";

const VECTOR = {
  p256dh: "BDgBTGA8idqXEkJjIO5TqUx5Xdo7kLtbB5Guj120hrfbJeOqNo7eN7llZvZlkPieoqyDS81hVBuQc4y8gpRwbJY",
  auth: "ZmVkY2JhOTg3NjU0MzIxMA",
  saltB64: "MDEyMzQ1Njc4OWFiY2RlZg",
  senderPrivateHex: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  senderPublicB64:
    "BHYKBshY3BflxTbegR9xB7-iTU_uOdZK_ZFY7rqrPPJbxO3PNMLAjRaw3NuIHYRwFLhAKusNb8UweMqU884c5M4",
  payload: '{"title":"Walk complete","url":"/portal/walks/abc"}',
  bodyB64:
    "MDEyMzQ1Njc4OWFiY2RlZgAAEABBBHYKBshY3BflxTbegR9xB7-iTU_uOdZK_ZFY7rqrPPJbxO3PNMLAjRaw3NuIHYRwFLhAKusNb8UweMqU884c5M5kuvewA2ijaqUL-t5A8O_ffKgAUiwI_GZ6vSF-szXNteduhzcnhSitIHXiWou6ndbBaG7rPUHBDmP32s8k6IKoZueycw",
};

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** WebCrypto will not import a raw private scalar, so rebuild the JWK: `d` is
 * the scalar and `x`/`y` are the halves of the uncompressed public point. */
async function senderKey(): Promise<CryptoKey> {
  const pub = b64urlToBytes(VECTOR.senderPublicB64);
  return await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: bytesToB64url(hexToBytes(VECTOR.senderPrivateHex)),
      x: bytesToB64url(pub.slice(1, 33)),
      y: bytesToB64url(pub.slice(33, 65)),
      ext: true,
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
}

Deno.test("the encrypted body is byte-identical to the reference implementation", async () => {
  const body = await encryptPushPayload(
    VECTOR.payload,
    { p256dh: VECTOR.p256dh, auth: VECTOR.auth },
    {
      salt: b64urlToBytes(VECTOR.saltB64),
      senderPrivate: await senderKey(),
      senderPublicRaw: b64urlToBytes(VECTOR.senderPublicB64),
    },
  );
  assertEquals(bytesToB64url(body), VECTOR.bodyB64);
});

Deno.test("the header is the aes128gcm framing the push service parses", async () => {
  const body = await encryptPushPayload(
    VECTOR.payload,
    { p256dh: VECTOR.p256dh, auth: VECTOR.auth },
    {
      salt: b64urlToBytes(VECTOR.saltB64),
      senderPrivate: await senderKey(),
      senderPublicRaw: b64urlToBytes(VECTOR.senderPublicB64),
    },
  );
  assertEquals(bytesToB64url(body.slice(0, 16)), VECTOR.saltB64, "salt is the first 16 bytes");
  assertEquals(new DataView(body.buffer, body.byteOffset).getUint32(16, false), RECORD_SIZE);
  assertEquals(body[20], 65, "the key id length is the uncompressed point length");
  assertEquals(bytesToB64url(body.slice(21, 86)), VECTOR.senderPublicB64);
});

Deno.test("a fresh call reuses neither the salt nor the ephemeral key", async () => {
  // Both are generated per message, and that is not cosmetic: a repeated salt
  // under a repeated key repeats the GCM nonce, which loses AES-GCM outright.
  const keys = { p256dh: VECTOR.p256dh, auth: VECTOR.auth };
  const a = await encryptPushPayload(VECTOR.payload, keys);
  const b = await encryptPushPayload(VECTOR.payload, keys);
  assert(bytesToB64url(a.slice(0, 16)) !== bytesToB64url(b.slice(0, 16)), "salt repeated");
  assert(bytesToB64url(a.slice(21, 86)) !== bytesToB64url(b.slice(21, 86)), "sender key repeated");
  assertEquals(a.length, b.length);
});

Deno.test("a malformed subscription is refused rather than encrypted to nobody", async () => {
  // A truncated p256dh or a short auth secret produces a body that is accepted
  // by the push service and silently never opens. Refusing names the row.
  await assertRejects(() =>
    encryptPushPayload("x", { p256dh: bytesToB64url(new Uint8Array(64)), auth: VECTOR.auth })
  );
  await assertRejects(() =>
    encryptPushPayload("x", { p256dh: VECTOR.p256dh, auth: bytesToB64url(new Uint8Array(8)) })
  );
});

// ── VAPID (RFC 8292) ─────────────────────────────────────────────────────
//
// ECDSA picks a fresh `k` per signature, so a byte comparison against the
// reference is impossible by construction. The two segments that ARE
// deterministic are pinned against `web-push`'s own output, and the signature
// is verified under the advertised public key — which is the property that
// actually matters, since a push service does exactly that and rejects the
// message otherwise.
const VAPID = {
  publicKey:
    "BHYKBshY3BflxTbegR9xB7-iTU_uOdZK_ZFY7rqrPPJbxO3PNMLAjRaw3NuIHYRwFLhAKusNb8UweMqU884c5M4",
  privateKey: "u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7s",
  subject: "mailto:ops@sanpo.test",
  atMs: 1767225600000,
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  jwtHeaderB64: "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9",
  jwtPayloadB64:
    "eyJhdWQiOiJodHRwczovL2ZjbS5nb29nbGVhcGlzLmNvbSIsImV4cCI6MTc2NzI2ODgwMCwic3ViIjoibWFpbHRvOm9wc0BzYW5wby50ZXN0In0",
};

Deno.test("the VAPID JWT header and claims match the reference implementation", async () => {
  const header = await vapidAuthorization(
    VAPID.endpoint,
    { publicKey: VAPID.publicKey, privateKey: VAPID.privateKey, subject: VAPID.subject },
    VAPID.atMs,
  );
  const jwt = header.replace(/^vapid t=/, "").split(",")[0];
  const [h, p] = jwt.split(".");
  assertEquals(h, VAPID.jwtHeaderB64);
  assertEquals(p, VAPID.jwtPayloadB64, "claims differ from web-push's for the same inputs");
  assert(header.endsWith(`, k=${VAPID.publicKey}`), `k= is not the public key: ${header}`);
});

Deno.test("the aud claim is the push service ORIGIN, not the endpoint", async () => {
  // Sending the full endpoint as `aud` is the natural mistake and is rejected
  // by the push service, with nothing on our side to look at.
  assertEquals(pushAudience("https://fcm.googleapis.com/fcm/send/abc123"), "https://fcm.googleapis.com");
  assertEquals(pushAudience("https://updates.push.services.mozilla.com/wpush/v2/xyz"), "https://updates.push.services.mozilla.com");
});

Deno.test("the signature verifies under the advertised key, and is raw r‖s", async () => {
  // WebCrypto emits raw r‖s, which is what JWS wants; Node's default is DER.
  // An implementation ported from a Node example produces a signature the push
  // service rejects, and this is the assertion that catches it.
  const header = await vapidAuthorization(
    VAPID.endpoint,
    { publicKey: VAPID.publicKey, privateKey: VAPID.privateKey, subject: VAPID.subject },
    VAPID.atMs,
  );
  const jwt = header.replace(/^vapid t=/, "").split(",")[0];
  const [h, p, s] = jwt.split(".");
  const sig = b64urlToBytes(s);
  assertEquals(sig.length, 64, "not a raw r‖s pair — DER would be ~70 and variable");

  const pub = b64urlToBytes(VAPID.publicKey);
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: bytesToB64url(pub.slice(1, 33)), y: bytesToB64url(pub.slice(33, 65)), ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    sig as BufferSource,
    new TextEncoder().encode(`${h}.${p}`) as BufferSource,
  );
  assert(ok, "the push service would reject this signature");
});

Deno.test("a subject the push service cannot act on is refused", async () => {
  // RFC 8292 §2.1. A push service that cannot reach a human about a
  // misbehaving sender can simply stop accepting the key.
  await assertRejects(() =>
    vapidAuthorization(VAPID.endpoint, {
      publicKey: VAPID.publicKey,
      privateKey: VAPID.privateKey,
      subject: "ops@sanpo.test",
    })
  );
});
