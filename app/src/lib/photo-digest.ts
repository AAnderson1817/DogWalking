/**
 * The integrity digest recorded for a walk photo (migration 0047).
 *
 * Its own module rather than a helper inside `api.ts` for a testing reason
 * that decides whether this is covered at all: `compressImage` needs
 * `createImageBitmap`, which happy-dom does not implement, so anything sharing
 * a file with the upload path can only be tested through mocks. Here, the
 * `node` vitest project runs the REAL `crypto.subtle.digest` against real
 * bytes — verified, digesting [1,2,3] yields the true SHA-256.
 */

/**
 * Lower-case hex SHA-256 of `blob`, or null when this runtime cannot compute
 * one.
 *
 * NULL is a real answer meaning "not recorded", never "failed" — 0047 makes
 * the column nullable for exactly this. Returning null rather than throwing is
 * deliberate: the photo is already in Storage by the time anything wants a
 * digest, and losing the row over a missing digest would trade a complete
 * record with one blank field for no record at all.
 *
 * The capability test is `typeof crypto?.subtle?.digest === "function"` and NOT
 * `isSecureContext`. Measured: `isSecureContext` is `undefined` in BOTH vitest
 * projects, so a secure-context guard would return null in every test and the
 * hashing path would be silently untested — the "green because it checked
 * nothing" shape this repository keeps finding. The distinction costs nothing
 * in production either: `crypto.randomUUID` is gated by the same secure-context
 * rule and `uploadWalkPhoto` already calls it, so on an insecure origin the
 * upload throws before any digest is wanted.
 */
export async function photoSha256(blob: Blob): Promise<string | null> {
  if (typeof crypto?.subtle?.digest !== "function") return null;
  try {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    // A digest we could not take is "not recorded". A digest taken over the
    // wrong bytes would be worse than either, which is why this never falls
    // back to hashing something else.
    return null;
  }
}
