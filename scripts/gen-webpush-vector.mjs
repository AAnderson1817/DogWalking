#!/usr/bin/env node
// Regenerate the RFC 8291 test vector in supabase/functions/_tests/webpush_test.ts.
//
// The vector's whole value is that it comes from somewhere ELSE: `http_ece` is
// the reference JS implementation of RFC 8188/8291, and the one `web-push`
// delegates to. A test written from the same reading of the spec as
// `_lib/webpush.ts` would share its misunderstandings and pass anyway.
//
//   npm install --no-save web-push@3   (http_ece arrives as its dependency)
//   node scripts/gen-webpush-vector.mjs
//
// Every input is fixed, so the output is a stable vector rather than a sample.
// Deliberately NOT wired into CI: it needs a network install, and a gate that
// cannot run offline is a gate that gets deleted. The vector is committed; this
// script is how a reader reproduces it.
import crypto from "node:crypto";
import ece from "http_ece";
import vapid from "web-push/src/vapid-helper.js";

const recipient = crypto.createECDH("prime256v1");
recipient.setPrivateKey(Buffer.from("a".repeat(64), "hex"));
const sender = crypto.createECDH("prime256v1");
sender.setPrivateKey(Buffer.from("b".repeat(64), "hex"));

const salt = Buffer.from("0123456789abcdef", "utf8");
const authSecret = Buffer.from("fedcba9876543210", "utf8");
const payload = '{"title":"Walk complete","url":"/portal/walks/abc"}';

const body = ece.encrypt(Buffer.from(payload), {
  version: "aes128gcm",
  dh: recipient.getPublicKey().toString("base64url"),
  privateKey: sender,
  salt: salt.toString("base64url"),
  authSecret: authSecret.toString("base64url"),
});

// ── VAPID (RFC 8292) ─────────────────────────────────────────────────────
// The signature is randomised (ECDSA picks a fresh k), so the vector pins the
// two DETERMINISTIC segments — the JWT header and payload — and the test
// verifies our signature under the advertised public key rather than
// comparing bytes that can never match.
const vapidKeys = {
  publicKey:
    "BHYKBshY3BflxTbegR9xB7-iTU_uOdZK_ZFY7rqrPPJbxO3PNMLAjRaw3NuIHYRwFLhAKusNb8UweMqU884c5M4",
  privateKey: Buffer.from("b".repeat(64), "hex").toString("base64url"),
};
const VAPID_AT_MS = 1767225600000; // 2026-01-01T00:00:00Z, fixed
const VAPID_EXP = Math.floor(VAPID_AT_MS / 1000) + 12 * 60 * 60;
const headers = vapid.getVapidHeaders(
  "https://fcm.googleapis.com",
  "mailto:ops@sanpo.test",
  vapidKeys.publicKey,
  vapidKeys.privateKey,
  "aes128gcm",
  VAPID_EXP,
);
const jwt = headers.Authorization.replace(/^vapid t=/, "").split(",")[0];

console.log(JSON.stringify({
  vapidPublicKey: vapidKeys.publicKey,
  vapidPrivateKey: vapidKeys.privateKey,
  vapidSubject: "mailto:ops@sanpo.test",
  vapidAtMs: VAPID_AT_MS,
  vapidEndpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  vapidJwtHeaderB64: jwt.split(".")[0],
  vapidJwtPayloadB64: jwt.split(".")[1],
  vapidAuthorization: headers.Authorization,
  p256dh: recipient.getPublicKey().toString("base64url"),
  auth: authSecret.toString("base64url"),
  saltB64: salt.toString("base64url"),
  senderPrivateHex: sender.getPrivateKey().toString("hex"),
  senderPublicB64: sender.getPublicKey().toString("base64url"),
  payload,
  bodyB64: body.toString("base64url"),
}, null, 2));
