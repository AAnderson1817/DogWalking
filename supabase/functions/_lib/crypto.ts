// AES-256-GCM for the credential vault (spec 03/04).
//
// v2 blob layout — every byte answers a question, and decrypt never guesses:
//
//   offset  len   field
//   [ 0]      1   version = 0x02
//   [ 1]      8   key id   (HKDF-derived fingerprint of the master key)
//   [ 9]     12   iv       (fresh per encryption)
//   [21]  n+16   body     = crypto.subtle.encrypt output, i.e. ct ‖ tag(16)
//
// Header is 21 bytes; the shortest possible blob is 37 (empty plaintext).
//
// The previous format was `iv(12) ‖ tag(16) ‖ ct` with no version and no key
// id (review B2). Three consequences, all fixed here:
//
//   1. Nothing said which key wrote a blob, so two keys could never coexist and
//      rotation was structurally impossible — not hard, impossible.
//   2. Nothing bound a blob to its row, so a ciphertext moved between rows
//      decrypted happily under a different client's label.
//   3. Wrong key, tampered ciphertext and tampered tag all raise the identical
//      DOMException, so the vault could not tell a custody problem from an
//      attack. With the key id in the header, a key we do not hold is decided
//      by a map lookup BEFORE any crypto runs.
//
// Note also what is NOT here any more: the old code split WebCrypto's native
// `ct ‖ tag` and stored `tag ‖ ct`, then re-joined on the way back. That
// transposition was pure ceremony, cost an allocation and a copy per decrypt,
// and was where offset bugs lived — the old "flip a tag bit" test would have
// silently become "flip an IV bit" under a shifted layout while staying green,
// because IV corruption rejects identically. WebCrypto's output is now stored
// verbatim and the concept of a tag offset is gone from the codebase.

const VERSION = 0x02;
const KID_LEN = 8;
const IV_LEN = 12;
const TAG_LEN = 16;
const KID_OFF = 1;
const IV_OFF = KID_OFF + KID_LEN; // 9
const BODY_OFF = IV_OFF + IV_LEN; // 21
const MIN_BLOB = BODY_OFF + TAG_LEN; // 37

/** Domain-separated HKDF labels. Changing either orphans every existing blob. */
const INFO_ENC = "sanpo/vault/v2/aes-256-gcm";
const INFO_KID = "sanpo/vault/v2/key-id";
const AAD_LABEL = "sanpo/vault/aad"; // 15 bytes
const AAD_LEN = 56;

/** The nil uuid, used as the canary's binding. gen_random_uuid() never emits
 *  it, so a canary blob can never be mistaken for a credential's, or vice
 *  versa — the AAD would not match in either direction. */
export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export interface VaultKey {
  /** 16 lowercase hex chars. Derived from the key, so it cannot disagree with it. */
  readonly id: string;
  readonly idBytes: Uint8Array;
  readonly key: CryptoKey;
}

export interface VaultBinding {
  /** access_credentials.id, or NIL_UUID for the canary. */
  credentialId: string;
  /** access_credentials.operator_id, or NIL_UUID for the canary. */
  operatorId: string;
}

export class VaultBlobError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "VaultBlobError";
  }
}

function b64ToBytes(base64Key: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(base64Key.trim());
  } catch {
    throw new Error("vault key is not valid base64");
  }
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * Derives the encryption key and the key id from one master secret, via HKDF
 * with two disjoint labels.
 *
 * Why HKDF rather than hashing or HMAC-ing the key directly: those use one key
 * for two primitives, which has no standard security reduction. HKDF's stated
 * purpose is exactly this — mutually independent outputs from one input under
 * separate labels — so publishing the key id provably reveals nothing about
 * the encryption key.
 *
 * The honest cost: a published key id lets anyone holding a candidate master
 * key confirm it without a ciphertext. Against 256 bits of CSPRNG output that
 * costs 2^256 trials and is worth nothing — which is precisely why the runbook
 * change (generate the key with a CSPRNG, off the database) is part of this
 * work and not a nicety. A key with guessable entropy is the only world where
 * the derived id hurts.
 */
export async function importVaultKey(base64Key: string): Promise<VaultKey> {
  const raw = b64ToBytes(base64Key);
  if (raw.length !== 32) {
    throw new Error("vault key must decode to exactly 32 bytes");
  }
  const ikm = await crypto.subtle.importKey("raw", raw as BufferSource, "HKDF", false, [
    "deriveBits",
  ]);
  const encBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(INFO_ENC) },
    ikm,
    256,
  );
  const idBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(INFO_KID) },
    ikm,
    KID_LEN * 8,
  );
  const key = await crypto.subtle.importKey("raw", encBits, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  raw.fill(0);
  const idBytes = new Uint8Array(idBits);
  return { id: hex(idBytes), idBytes, key };
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** 32 hex chars → 16 raw bytes. Case-insensitive, so a caller that upper-cases
 *  a uuid cannot produce a different AAD for the same row. */
function uuidToBytes(uuid: string, field: string): Uint8Array {
  const clean = uuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(clean)) {
    throw new VaultBlobError("bad_binding", `${field} is not a uuid`);
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Fixed-length additional authenticated data — 56 bytes, every field a
 * compile-time length, so the encoding is injective by construction and needs
 * no delimiters or length prefixes.
 *
 *   [ 0] 15  "sanpo/vault/aad"   domain separation
 *   [15]  1  version             the same value written to blob[0]
 *   [16]  8  key id              the same bytes written to blob[1..9)
 *   [24] 16  credential_id       raw uuid bytes
 *   [40] 16  operator_id         raw uuid bytes
 *
 * Raw uuid BYTES, not text: it makes uuid casing structurally irrelevant.
 * Version and key id are inside the AAD because they are the selectors — an
 * unauthenticated selector lets an attacker relabel which key a blob claims to
 * need, turning tampering into what looks like a custody problem.
 *
 * If a variable-length field is ever added here it MUST be length-prefixed and
 * VERSION must increment in the same commit.
 */
function buildAad(idBytes: Uint8Array, binding: VaultBinding): Uint8Array {
  const aad = new Uint8Array(AAD_LEN);
  aad.set(new TextEncoder().encode(AAD_LABEL), 0);
  aad[15] = VERSION;
  aad.set(idBytes, 16);
  aad.set(uuidToBytes(binding.credentialId, "credential_id"), 24);
  aad.set(uuidToBytes(binding.operatorId, "operator_id"), 40);
  return aad;
}

export async function encryptSecret(
  vk: VaultKey,
  plaintext: string,
  binding: VaultBinding,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const body = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv as BufferSource,
        tagLength: TAG_LEN * 8,
        additionalData: buildAad(vk.idBytes, binding) as BufferSource,
      },
      vk.key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const blob = new Uint8Array(BODY_OFF + body.length);
  blob[0] = VERSION;
  blob.set(vk.idBytes, KID_OFF);
  blob.set(iv, IV_OFF);
  blob.set(body, BODY_OFF);
  return blob;
}

/** The key id a blob declares, without decrypting it. */
export function blobKeyId(blob: Uint8Array): string {
  if (blob.length < MIN_BLOB) {
    throw new VaultBlobError("blob_malformed", "ciphertext blob is too short");
  }
  if (blob[0] !== VERSION) {
    throw new VaultBlobError(
      "blob_unsupported_version",
      `ciphertext blob declares version ${blob[0]}, which this deployment cannot read`,
    );
  }
  return hex(blob.subarray(KID_OFF, KID_OFF + KID_LEN));
}

/**
 * Decrypts with the key the blob names. `ring` maps key id → key.
 *
 * Deliberately NOT trial decryption: a blob whose key we do not hold raises
 * `key_unknown` and is never tried against another key. That is the difference
 * between "I do not hold that key" — recoverable by supplying it — and "this
 * blob is corrupt", which is not. Collapsing the two is the original defect.
 */
export async function decryptSecret(
  ring: ReadonlyMap<string, VaultKey>,
  blob: Uint8Array,
  binding: VaultBinding,
): Promise<string> {
  const kid = blobKeyId(blob);
  const vk = ring.get(kid);
  if (!vk) {
    throw new VaultBlobError(
      "key_unknown",
      "this credential was encrypted with a key this deployment does not hold",
    );
  }
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: blob.subarray(IV_OFF, BODY_OFF) as BufferSource,
        tagLength: TAG_LEN * 8,
        additionalData: buildAad(vk.idBytes, binding) as BufferSource,
      },
      vk.key,
      blob.subarray(BODY_OFF) as BufferSource,
    );
  } catch {
    // The key is right (we selected it by id), so this is tampering, a
    // relocated blob, or a corrupt row — never a custody problem.
    throw new VaultBlobError("decrypt_failed", "credential could not be decrypted");
  }
  return new TextDecoder().decode(plaintext);
}

// PostgREST represents bytea as '\x<hex>'.
export function bytesToPgHex(bytes: Uint8Array): string {
  return "\\x" + hex(bytes);
}

export function pgHexToBytes(pgHex: string): Uint8Array {
  const raw = pgHex.startsWith("\\x") ? pgHex.slice(2) : pgHex;
  if (raw.length % 2 !== 0 || (raw.length > 0 && !/^[0-9a-fA-F]+$/.test(raw))) {
    // Previously this produced NaN → 0 bytes for invalid input, silently
    // turning a transport bug into a "corrupt ciphertext".
    throw new VaultBlobError("bad_bytea", "malformed bytea hex from the database");
  }
  const out = new Uint8Array(raw.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
