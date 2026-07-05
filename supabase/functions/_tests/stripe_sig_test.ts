// Stripe webhook signature verification against locally-signed payloads.
import { assert, assertFalse } from "./asserts.ts";
import { signStripePayload, verifyStripeSignature } from "../_lib/stripe.ts";

const SECRET = "whsec_test_secret_for_local_suite";
const PAYLOAD = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: {} } });

Deno.test("valid locally-signed payload verifies", async () => {
  const header = await signStripePayload(PAYLOAD, SECRET);
  assert(await verifyStripeSignature(PAYLOAD, header, SECRET));
});

Deno.test("wrong secret fails", async () => {
  const header = await signStripePayload(PAYLOAD, SECRET);
  assertFalse(await verifyStripeSignature(PAYLOAD, header, "whsec_other"));
});

Deno.test("tampered payload fails", async () => {
  const header = await signStripePayload(PAYLOAD, SECRET);
  assertFalse(await verifyStripeSignature(PAYLOAD + " ", header, SECRET));
});

Deno.test("stale timestamp outside tolerance fails", async () => {
  const header = await signStripePayload(PAYLOAD, SECRET, Date.now() - 10 * 60 * 1000);
  assertFalse(await verifyStripeSignature(PAYLOAD, header, SECRET));
});

Deno.test("stale timestamp passes with injected clock", async () => {
  const at = Date.now() - 10 * 60 * 1000;
  const header = await signStripePayload(PAYLOAD, SECRET, at);
  assert(await verifyStripeSignature(PAYLOAD, header, SECRET, 300, () => at + 1000));
});

Deno.test("missing/garbage headers fail", async () => {
  assertFalse(await verifyStripeSignature(PAYLOAD, null, SECRET));
  assertFalse(await verifyStripeSignature(PAYLOAD, "", SECRET));
  assertFalse(await verifyStripeSignature(PAYLOAD, "t=abc,v1=zzz", SECRET));
  assertFalse(await verifyStripeSignature(PAYLOAD, "v1=deadbeef", SECRET));
});
