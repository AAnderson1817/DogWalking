// AES-256-GCM for the credential vault (spec 03/04).
// Stored blob layout: iv(12) ‖ tag(16) ‖ ciphertext.
// Key: 32 bytes base64 from the vault master edge secret — never in the DB.

const IV_LEN = 12;
const TAG_LEN = 16;

export async function importVaultKey(base64Key: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(atob(base64Key.trim()), (c) => c.charCodeAt(0));
  } catch {
    throw new Error("vault key is not valid base64");
  }
  if (raw.length !== 32) {
    throw new Error("vault key must decode to exactly 32 bytes");
  }
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptSecret(key: CryptoKey, plaintext: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  // WebCrypto returns ciphertext ‖ tag; the stored layout is iv ‖ tag ‖ ct.
  const ct = encrypted.subarray(0, encrypted.length - TAG_LEN);
  const tag = encrypted.subarray(encrypted.length - TAG_LEN);
  const blob = new Uint8Array(IV_LEN + TAG_LEN + ct.length);
  blob.set(iv, 0);
  blob.set(tag, IV_LEN);
  blob.set(ct, IV_LEN + TAG_LEN);
  return blob;
}

export async function decryptSecret(key: CryptoKey, blob: Uint8Array): Promise<string> {
  if (blob.length < IV_LEN + TAG_LEN) {
    throw new Error("ciphertext blob too short");
  }
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const joined = new Uint8Array(ct.length + TAG_LEN);
  joined.set(ct, 0);
  joined.set(tag, ct.length);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    joined as BufferSource,
  );
  return new TextDecoder().decode(plaintext);
}

// PostgREST represents bytea as '\x<hex>'.
export function bytesToPgHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return "\\x" + hex;
}

export function pgHexToBytes(pgHex: string): Uint8Array {
  const hex = pgHex.startsWith("\\x") ? pgHex.slice(2) : pgHex;
  if (hex.length % 2 !== 0) throw new Error("bad bytea hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
