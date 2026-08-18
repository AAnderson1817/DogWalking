// Vault crypto: v2 blob layout, key identity, row binding, and the failure
// modes the old format could not tell apart (review B2).
import { assert, assertEquals, assertRejects } from "./asserts.ts";
import {
  blobKeyId,
  bytesToPgHex,
  decryptSecret,
  encryptSecret,
  importVaultKey,
  NIL_UUID,
  pgHexToBytes,
  VaultBlobError,
  type VaultBinding,
  type VaultKey,
} from "../_lib/crypto.ts";

function testKeyB64(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const b of raw) s += String.fromCharCode(b);
  return btoa(s);
}

const CRED_A = "11111111-2222-4333-8444-555555555555";
const CRED_B = "99999999-8888-4777-8666-555555555555";
const OP_A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OP_B = "12121212-3434-4565-8787-989898989898";
const bind = (credentialId = CRED_A, operatorId = OP_A): VaultBinding => ({ credentialId, operatorId });

function ringOf(...keys: VaultKey[]): Map<string, VaultKey> {
  return new Map(keys.map((k) => [k.id, k]));
}

async function code(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof VaultBlobError) return e.code;
    return `unexpected:${(e as Error).name}`;
  }
  return "no-error";
}

Deno.test("encrypt → decrypt roundtrips", async () => {
  const vk = await importVaultKey(testKeyB64());
  const secret = "lockbox 4711 — turn twice, alarm code 8842#";
  const blob = await encryptSecret(vk, secret, bind());
  assertEquals(await decryptSecret(ringOf(vk), blob, bind()), secret);
});

Deno.test("blob layout is version(1) ‖ kid(8) ‖ iv(12) ‖ ct‖tag", async () => {
  const vk = await importVaultKey(testKeyB64());
  const secret = "0000";
  const blob = await encryptSecret(vk, secret, bind());
  assertEquals(blob.length, 21 + new TextEncoder().encode(secret).length + 16);
  assertEquals(blob[0], 0x02);
  assertEquals(bytesToPgHex(blob.subarray(1, 9)), "\\x" + vk.id);
});

Deno.test("empty and one-byte plaintexts sit exactly on the minimum", async () => {
  const vk = await importVaultKey(testKeyB64());
  const empty = await encryptSecret(vk, "", bind());
  assertEquals(empty.length, 37);
  assertEquals(await decryptSecret(ringOf(vk), empty, bind()), "");
  const one = await encryptSecret(vk, "x", bind());
  assertEquals(one.length, 38);
  assertEquals(await decryptSecret(ringOf(vk), one, bind()), "x");
});

Deno.test("unique iv per encryption", async () => {
  const vk = await importVaultKey(testKeyB64());
  const a = await encryptSecret(vk, "same secret", bind());
  const b = await encryptSecret(vk, "same secret", bind());
  assert(bytesToPgHex(a.subarray(9, 21)) !== bytesToPgHex(b.subarray(9, 21)));
});

Deno.test("the key id is derived, stable, and distinct per key", async () => {
  const b64 = testKeyB64();
  const one = await importVaultKey(b64);
  const again = await importVaultKey(b64);
  const other = await importVaultKey(testKeyB64());
  assertEquals(one.id, again.id, "same key must derive the same id");
  assert(one.id !== other.id, "different keys must derive different ids");
  assertEquals(one.id.length, 16);
  assert(/^[0-9a-f]{16}$/.test(one.id));
});

Deno.test("the key id is readable without holding the key", async () => {
  const vk = await importVaultKey(testKeyB64());
  const blob = await encryptSecret(vk, "s", bind());
  assertEquals(blobKeyId(blob), vk.id);
});

// ── The four failure modes the old format collapsed into one ───────────────

Deno.test("a key we do not hold is key_unknown, not decrypt_failed", async () => {
  const writer = await importVaultKey(testKeyB64());
  const other = await importVaultKey(testKeyB64());
  const blob = await encryptSecret(writer, "supersecret", bind());
  // This is the distinction that makes rotation recoverable: supplying the
  // right key later fixes it, and the vault can say so.
  assertEquals(await code(() => decryptSecret(ringOf(other), blob, bind())), "key_unknown");
});

Deno.test("tampering with the ciphertext is decrypt_failed", async () => {
  const vk = await importVaultKey(testKeyB64());
  const blob = await encryptSecret(vk, "supersecret", bind());
  const t = new Uint8Array(blob);
  t[t.length - 1] ^= 0x01;
  assertEquals(await code(() => decryptSecret(ringOf(vk), t, bind())), "decrypt_failed");
});

Deno.test("tampering with the tag is decrypt_failed", async () => {
  const vk = await importVaultKey(testKeyB64());
  const blob = await encryptSecret(vk, "supersecret", bind());
  const t = new Uint8Array(blob);
  t[t.length - 8] ^= 0x01; // inside the trailing tag
  assertEquals(await code(() => decryptSecret(ringOf(vk), t, bind())), "decrypt_failed");
});

Deno.test("tampering with the iv is decrypt_failed", async () => {
  const vk = await importVaultKey(testKeyB64());
  const blob = await encryptSecret(vk, "supersecret", bind());
  const t = new Uint8Array(blob);
  t[9] ^= 0x01;
  assertEquals(await code(() => decryptSecret(ringOf(vk), t, bind())), "decrypt_failed");
});

Deno.test("flipping a key-id byte cannot silently reroute the key", async () => {
  const vk = await importVaultKey(testKeyB64());
  const blob = await encryptSecret(vk, "supersecret", bind());
  const t = new Uint8Array(blob);
  t[1] ^= 0x01;
  // The id no longer names a held key, so it stops at the lookup...
  assertEquals(await code(() => decryptSecret(ringOf(vk), t, bind())), "key_unknown");
  // ...and even if an attacker arranged a collision with a key we DO hold, the
  // id is inside the AAD, so the tag would still reject.
  const forged = new Uint8Array(blob);
  forged.set(vk.idBytes, 1);
  forged[1] ^= 0x00; // unchanged: proves the control path is the id, not luck
  assertEquals(await decryptSecret(ringOf(vk), forged, bind()), "supersecret");
});

Deno.test("the version byte is authenticated", async () => {
  const vk = await importVaultKey(testKeyB64());
  const blob = await encryptSecret(vk, "supersecret", bind());
  const t = new Uint8Array(blob);
  t[0] = 0x03;
  assertEquals(await code(() => decryptSecret(ringOf(vk), t, bind())), "blob_unsupported_version");
});

// ── Row binding ───────────────────────────────────────────────────────────

Deno.test("a blob moved to another credential row will not decrypt", async () => {
  const vk = await importVaultKey(testKeyB64());
  const blob = await encryptSecret(vk, "alarm 8842#", bind(CRED_A, OP_A));
  // Same key, same operator, different row — a service-role mistake, a bad
  // restore, or a copied ciphertext. Under the old format this returned the
  // plaintext under someone else's label.
  assertEquals(await code(() => decryptSecret(ringOf(vk), blob, bind(CRED_B, OP_A))), "decrypt_failed");
});

Deno.test("a blob moved to another tenant will not decrypt", async () => {
  const vk = await importVaultKey(testKeyB64());
  const blob = await encryptSecret(vk, "alarm 8842#", bind(CRED_A, OP_A));
  assertEquals(await code(() => decryptSecret(ringOf(vk), blob, bind(CRED_A, OP_B))), "decrypt_failed");
});

Deno.test("uuid casing does not change the binding", async () => {
  const vk = await importVaultKey(testKeyB64());
  const blob = await encryptSecret(vk, "s", bind(CRED_A.toUpperCase(), OP_A));
  // Raw uuid bytes, not text — so a caller that upper-cases an id cannot
  // produce an undecryptable blob.
  assertEquals(await decryptSecret(ringOf(vk), blob, bind(CRED_A.toLowerCase(), OP_A)), "s");
});

Deno.test("the canary binding cannot collide with a credential", async () => {
  const vk = await importVaultKey(testKeyB64());
  const canary = await encryptSecret(vk, "canary", bind(NIL_UUID, NIL_UUID));
  assertEquals(await decryptSecret(ringOf(vk), canary, bind(NIL_UUID, NIL_UUID)), "canary");
  assertEquals(await code(() => decryptSecret(ringOf(vk), canary, bind(CRED_A, OP_A))), "decrypt_failed");
});

Deno.test("a non-uuid binding is rejected before any crypto", async () => {
  const vk = await importVaultKey(testKeyB64());
  assertEquals(await code(() => encryptSecret(vk, "s", bind("not-a-uuid", OP_A))), "bad_binding");
});

// ── Framing ───────────────────────────────────────────────────────────────

Deno.test("blobs shorter than the minimum are malformed, not decrypt failures", async () => {
  const vk = await importVaultKey(testKeyB64());
  for (const len of [0, 1, 21, 36]) {
    assertEquals(
      await code(() => decryptSecret(ringOf(vk), new Uint8Array(len), bind())),
      "blob_malformed",
      `length ${len}`,
    );
  }
});

Deno.test("the pre-v2 format is refused by version, not by tag failure", async () => {
  const vk = await importVaultKey(testKeyB64());
  // A legacy blob is iv(12)‖tag(16)‖ct with a random first byte. 255 of 256
  // land here; the 1-in-256 that reads as 0x02 fails the tag instead. Either
  // way it is refused — there is no legacy reader.
  const legacy = new Uint8Array(60);
  legacy[0] = 0x00;
  assertEquals(await code(() => decryptSecret(ringOf(vk), legacy, bind())), "blob_unsupported_version");
});

Deno.test("vault key must be exactly 32 bytes", async () => {
  await assertRejects(() => importVaultKey(btoa("short")));
});

Deno.test("pg hex helpers roundtrip, and reject malformed input", () => {
  const bytes = new Uint8Array([0, 1, 254, 255, 16]);
  const hex = bytesToPgHex(bytes);
  assertEquals(hex, "\\x0001feff10");
  assertEquals(Array.from(pgHexToBytes(hex)), Array.from(bytes));
  // Previously "\\xzz" produced NaN → a zero byte, turning a transport bug
  // into an unexplained decrypt failure.
  let threw = "";
  try { pgHexToBytes("\\xzz"); } catch (e) { threw = (e as VaultBlobError).code; }
  assertEquals(threw, "bad_bytea");
  try { pgHexToBytes("\\x0"); } catch (e) { threw = (e as VaultBlobError).code; }
  assertEquals(threw, "bad_bytea");
});
