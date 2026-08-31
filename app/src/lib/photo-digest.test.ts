import { describe, expect, it, vi } from "vitest";
import { photoSha256 } from "./photo-digest";

/**
 * Migration 0047. These run in the `node` project, which has a REAL
 * `crypto.subtle` — the assertions below are against known SHA-256 vectors, so
 * a stub or a mock could not satisfy them.
 */
describe("photoSha256", () => {
  it("computes the real SHA-256, not something that merely looks like one", async () => {
    // The published vector for the empty input. A digest function that returned
    // a plausible-looking 64-hex string would pass a shape test and fail this.
    await expect(photoSha256(new Blob([]))).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    // ...and for "abc".
    await expect(photoSha256(new Blob(["abc"]))).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("emits exactly the form the 0047 CHECK constraint accepts", async () => {
    // `check (sha256 ~ '^[0-9a-f]{64}$')`. Upper-case hex is refused by the
    // database, so a formatter that emitted it would insert nothing — and the
    // insert is best-effort, so the failure would be silent.
    const digest = await photoSha256(new Blob([new Uint8Array([0, 255, 16])]));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("distinguishes bytes that differ by one bit", async () => {
    const a = await photoSha256(new Blob([new Uint8Array([1, 2, 3])]));
    const b = await photoSha256(new Blob([new Uint8Array([1, 2, 2])]));
    expect(a).not.toBe(b);
  });

  it("returns null rather than throwing when the runtime cannot hash", async () => {
    // The photo is already in Storage by the time a digest is wanted. Throwing
    // here would lose the ROW over a missing digest — trading a complete record
    // with one blank field for no record at all.
    const digest = vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(new Error("nope"));
    await expect(photoSha256(new Blob(["x"]))).resolves.toBeNull();
    digest.mockRestore();
  });

  it("hashes even where isSecureContext is falsy — the guard is capability, not context", async () => {
    // The load-bearing case. `isSecureContext` is `undefined` in BOTH vitest
    // projects, so a guard written as `if (!isSecureContext) return null` would
    // make every test here return null and the hashing path would be tested
    // nowhere while looking covered. Pinned explicitly, with the value forced
    // false so the wrong guard cannot pass by accident.
    const original = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");
    Object.defineProperty(globalThis, "isSecureContext", { value: false, configurable: true });
    try {
      await expect(photoSha256(new Blob(["abc"]))).resolves.toBe(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      );
    } finally {
      if (original) Object.defineProperty(globalThis, "isSecureContext", original);
      else delete (globalThis as Record<string, unknown>).isSecureContext;
    }
  });
});
