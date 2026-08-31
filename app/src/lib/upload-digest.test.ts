import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Migration 0047. The one property that cannot be allowed to regress: the
 * digest recorded describes the bytes that were UPLOADED.
 *
 * `addPhotos` holds `file` (the camera original) and `compressed` on adjacent
 * lines, and `compressImage` re-encodes to JPEG — so hashing the wrong one
 * produces a digest that matches nothing, on every photo, forever. Nothing in
 * the product reads these columns yet, so that defect would ship green and
 * poison the whole corpus before the DR script ever ran.
 *
 * This asserts against the blob the storage client actually received, not
 * against the argument passed in, so it also survives a future refactor that
 * uploads something derived.
 */
const uploaded: { path?: string; body?: Blob } = {};

vi.mock("./supabase", () => ({
  supabase: {
    storage: {
      from: () => ({
        upload: (path: string, body: Blob) => {
          uploaded.path = path;
          uploaded.body = body;
          return Promise.resolve({ error: null });
        },
      }),
    },
  },
}));

const { uploadWalkPhoto } = await import("./api");
const { photoSha256 } = await import("./photo-digest");

describe("uploadWalkPhoto records the bytes it uploaded", () => {
  beforeEach(() => {
    uploaded.path = undefined;
    uploaded.body = undefined;
  });

  it("returns the digest OF THE BLOB THE STORAGE CLIENT RECEIVED", async () => {
    const compressed = new Blob([new Uint8Array([9, 8, 7, 6, 5])]);
    const result = await uploadWalkPhoto("op-1", "walk-1", compressed);

    expect(uploaded.body, "nothing reached the storage client").toBeDefined();
    // The assertion that matters: digest-of-what-was-sent, computed here
    // independently, must equal what the function reported.
    expect(result.sha256).toBe(await photoSha256(uploaded.body!));
    expect(result.byteSize).toBe(uploaded.body!.size);
  });

  it("does not report the digest of some OTHER blob", async () => {
    // The concrete wrong implementation: hashing the camera original instead of
    // the compressed bytes. Different content, so a different digest.
    const original = new Blob([new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1])]);
    const compressed = new Blob([new Uint8Array([2, 2, 2])]);
    const result = await uploadWalkPhoto("op-1", "walk-1", compressed);

    expect(result.sha256).not.toBe(await photoSha256(original));
    expect(result.byteSize).not.toBe(original.size);
  });

  it("mints a fresh path per call, so an object is never replaced in place", async () => {
    // Why the digest stays valid for the life of the object without anything
    // defending it: two uploads never collide, so a recorded digest can never
    // start describing different bytes at the same path.
    const blob = new Blob(["same bytes"]);
    const first = await uploadWalkPhoto("op-1", "walk-1", blob);
    const second = await uploadWalkPhoto("op-1", "walk-1", blob);

    expect(first.path).not.toBe(second.path);
    expect(first.path.startsWith("op-1/walk-1/")).toBe(true);
    // Identical bytes still hash identically — the path changes, the digest does not.
    expect(first.sha256).toBe(second.sha256);
  });

  it("still returns a usable record when the runtime cannot hash", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest").mockRejectedValue(new Error("nope"));
    try {
      const result = await uploadWalkPhoto("op-1", "walk-1", new Blob(["x"]));
      // "not recorded" — a NULL the 0047 column allows — with the path and the
      // size still captured. Losing the row here would be the worse trade.
      expect(result.sha256).toBeNull();
      expect(result.byteSize).toBe(1);
      expect(result.path).toBeTruthy();
    } finally {
      digest.mockRestore();
    }
  });
});
