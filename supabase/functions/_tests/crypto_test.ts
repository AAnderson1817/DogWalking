// Vault crypto: roundtrip, blob layout, tamper detection (phase 01).
import { assert, assertEquals, assertRejects } from "./asserts.ts";
import { decryptSecret, encryptSecret, importVaultKey, bytesToPgHex, pgHexToBytes } from "../_lib/crypto.ts";

function testKeyB64(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const b of raw) s += String.fromCharCode(b);
  return btoa(s);
}

Deno.test("encrypt → decrypt roundtrips", async () => {
  const key = await importVaultKey(testKeyB64());
  const secret = "lockbox 4711 — turn twice, alarm code 8842#";
  const blob = await encryptSecret(key, secret);
  assertEquals(await decryptSecret(key, blob), secret);
});

Deno.test("blob layout is iv(12) ‖ tag(16) ‖ ct", async () => {
  const key = await importVaultKey(testKeyB64());
  const secret = "0000";
  const blob = await encryptSecret(key, secret);
  assertEquals(blob.length, 12 + 16 + new TextEncoder().encode(secret).length);
});

Deno.test("unique iv per encryption", async () => {
  const key = await importVaultKey(testKeyB64());
  const a = await encryptSecret(key, "same secret");
  const b = await encryptSecret(key, "same secret");
  assert(bytesToPgHex(a.subarray(0, 12)) !== bytesToPgHex(b.subarray(0, 12)));
});

Deno.test("tampering with the ciphertext fails the auth tag", async () => {
  const key = await importVaultKey(testKeyB64());
  const blob = await encryptSecret(key, "supersecret");
  const tampered = new Uint8Array(blob);
  tampered[tampered.length - 1] ^= 0x01; // flip a ciphertext bit
  await assertRejects(() => decryptSecret(key, tampered));
});

Deno.test("tampering with the tag fails", async () => {
  const key = await importVaultKey(testKeyB64());
  const blob = await encryptSecret(key, "supersecret");
  const tampered = new Uint8Array(blob);
  tampered[12] ^= 0x01; // flip a tag bit (tag occupies bytes 12..27)
  await assertRejects(() => decryptSecret(key, tampered));
});

Deno.test("wrong key fails", async () => {
  const blob = await encryptSecret(await importVaultKey(testKeyB64()), "supersecret");
  const otherKey = await importVaultKey(testKeyB64());
  await assertRejects(() => decryptSecret(otherKey, blob));
});

Deno.test("vault key must be exactly 32 bytes", async () => {
  await assertRejects(() => importVaultKey(btoa("short")));
});

Deno.test("pg hex helpers roundtrip", () => {
  const bytes = new Uint8Array([0, 1, 254, 255, 16]);
  const hex = bytesToPgHex(bytes);
  assertEquals(hex, "\\x0001feff10");
  assertEquals(Array.from(pgHexToBytes(hex)), Array.from(bytes));
});
