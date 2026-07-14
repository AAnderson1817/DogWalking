// isServiceAuth: cron/webhook service-key detection (materialize-walks,
// send-notification). Signature verification is the gateway's job
// (verify_jwt on); these tests cover the claim/exact-match logic only.
import { assert, assertEquals } from "./asserts.ts";
import { isServiceAuth } from "../_lib/http.ts";

/** Unsigned-but-well-formed JWT with the given payload (base64url, no padding). */
function fakeJwt(payload: Record<string, unknown>): string {
  const enc = (o: Record<string, unknown>) =>
    btoa(JSON.stringify(o)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc(payload)}.${enc({ sig: "x" })}`;
}

const INJECTED = "sb_secret_test_key_0123456789";

Deno.test("exact match against the injected key passes (non-JWT shape)", () => {
  assert(isServiceAuth(`Bearer ${INJECTED}`, INJECTED));
});

Deno.test("service_role JWT passes even when it differs from the injected key", () => {
  // The cron-401 regression: dashboard key ≠ injected env after key
  // migration or secret rotation. The role claim must be enough.
  const token = fakeJwt({ iss: "supabase", ref: "zurabcdefgh", role: "service_role" });
  assert(token !== INJECTED);
  assert(isServiceAuth(`Bearer ${token}`, INJECTED));
});

Deno.test("trailing whitespace in the pasted header value is tolerated", () => {
  const token = fakeJwt({ role: "service_role" });
  assert(isServiceAuth(`Bearer ${token} \n`, INJECTED));
});

Deno.test("anon JWT is rejected", () => {
  const token = fakeJwt({ iss: "supabase", role: "anon" });
  assertEquals(isServiceAuth(`Bearer ${token}`, INJECTED), false);
});

Deno.test("authenticated-user JWT is rejected", () => {
  const token = fakeJwt({ sub: "6a1eb09c-0000-4000-8000-000000000000", role: "authenticated" });
  assertEquals(isServiceAuth(`Bearer ${token}`, INJECTED), false);
});

Deno.test("role claim of a non-string type is rejected", () => {
  const token = fakeJwt({ role: ["service_role"] });
  assertEquals(isServiceAuth(`Bearer ${token}`, INJECTED), false);
});

Deno.test("garbage tokens, empty bearers and missing headers are rejected", () => {
  assertEquals(isServiceAuth("Bearer not.a.jwt", INJECTED), false);
  assertEquals(isServiceAuth("Bearer two.parts", INJECTED), false);
  assertEquals(isServiceAuth("Bearer ", INJECTED), false);
  assertEquals(isServiceAuth("", INJECTED), false);
  assertEquals(isServiceAuth(null, INJECTED), false);
  assertEquals(isServiceAuth(`Basic ${INJECTED}`, INJECTED), false);
});

Deno.test("empty injected key disables the exact-match path but not the claim path", () => {
  assertEquals(isServiceAuth("Bearer ", ""), false);
  assertEquals(isServiceAuth(`Bearer ${INJECTED}`, ""), false);
  assert(isServiceAuth(`Bearer ${fakeJwt({ role: "service_role" })}`, ""));
});
