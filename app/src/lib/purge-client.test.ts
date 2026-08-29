import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Review H5, the two-phase erasure.
 *
 * SQL cannot delete an object from a Supabase bucket: dropping the
 * `storage.objects` row removes the metadata and leaves the file. So a
 * SQL-only purge destroys the POINTER to a photo of somebody's house and
 * leaves the photo.
 *
 * `fn_purge_client` therefore returns the paths and KEEPS the rows naming
 * them; the browser deletes the objects; `fn_purge_client_photos` then drops
 * the rows. The rows are the work queue, so the sequence is resumable, and a
 * file orphaned in the bucket with nothing naming it is impossible by
 * construction.
 *
 * These tests pin that ordering, because it is invisible in the happy path —
 * an implementation that drops the rows first passes every "did the purge
 * work" check and silently leaves the photos behind.
 */

const rpc = vi.fn();
const remove = vi.fn();
const calls: string[] = [];

vi.mock("./supabase", () => ({
  supabase: {
    rpc: (...a: unknown[]) => {
      calls.push(`rpc:${String(a[0])}`);
      return rpc(...a);
    },
    storage: {
      from: (bucket: string) => ({
        remove: (paths: string[]) => {
          calls.push(`remove:${bucket}`);
          return remove(bucket, paths);
        },
      }),
    },
  },
}));

const { purgeClient } = await import("./api");

const WALK = "op-1/walk-9/1.jpg";
const PET = "op-1/pet/rex.jpg";

beforeEach(() => {
  calls.length = 0;
  rpc.mockReset();
  remove.mockReset();
  rpc.mockImplementation((fn: string) => {
    if (fn === "fn_purge_client") {
      return Promise.resolve({
        data: [{ storage_path: WALK }, { storage_path: PET }],
        error: null,
      });
    }
    return Promise.resolve({ data: 2, error: null });
  });
  remove.mockImplementation((_b: string, paths: string[]) =>
    Promise.resolve({ data: paths.map((name) => ({ name })), error: null })
  );
});

describe("purgeClient", () => {
  it("deletes the objects before dropping the rows that name them", async () => {
    await purgeClient("c-1");
    const purge = calls.indexOf("rpc:fn_purge_client");
    const photos = calls.indexOf("rpc:fn_purge_client_photos");
    const removals = calls.filter((c) => c.startsWith("remove:")).map((c) => calls.indexOf(c));
    expect(purge).toBeGreaterThanOrEqual(0);
    expect(photos).toBeGreaterThan(purge);
    for (const r of removals) expect(r).toBeLessThan(photos);
  });

  it("routes each path to the bucket it lives in", async () => {
    await purgeClient("c-1");
    expect(remove).toHaveBeenCalledWith("walk-photos", [WALK]);
    expect(remove).toHaveBeenCalledWith("pet-photos", [PET]);
  });

  it("handles paths that carry the bucket as a first segment", async () => {
    rpc.mockImplementation((fn: string) =>
      fn === "fn_purge_client"
        ? Promise.resolve({
          data: [{ storage_path: "pet-photos/op-1/pet/a.jpg" }],
          error: null,
        })
        : Promise.resolve({ data: 1, error: null })
    );
    await purgeClient("c-1");
    expect(remove).toHaveBeenCalledWith("pet-photos", ["op-1/pet/a.jpg"]);
  });

  /**
   * The failure that matters. If storage refuses, the rows must SURVIVE — they
   * are the only remaining record that those files exist, and dropping them
   * turns a retryable gap into an untracked photo of a client's house.
   */
  it("does not drop the rows when storage refuses", async () => {
    remove.mockResolvedValue({ data: null, error: { message: "denied" } });
    const result = await purgeClient("c-1");
    expect(result.failedPaths).toHaveLength(2);
    expect(calls).not.toContain("rpc:fn_purge_client_photos");
  });

  /** A partial removal is a failure too — storage can accept some and not all. */
  it("treats a partially-removed batch as incomplete", async () => {
    remove.mockImplementation((bucket: string, paths: string[]) =>
      Promise.resolve({
        data: bucket === "walk-photos" ? paths.map((name) => ({ name })) : [],
        error: null,
      })
    );
    const result = await purgeClient("c-1");
    expect(result.failedPaths).toEqual(["op-1/pet/rex.jpg"]);
    expect(calls).not.toContain("rpc:fn_purge_client_photos");
  });

  it("reports how many objects actually went", async () => {
    const result = await purgeClient("c-1");
    expect(result.photosDeleted).toBe(2);
    expect(result.failedPaths).toEqual([]);
  });

  it("still finishes cleanly when there are no photos at all", async () => {
    rpc.mockImplementation((fn: string) =>
      fn === "fn_purge_client"
        ? Promise.resolve({ data: [], error: null })
        : Promise.resolve({ data: 0, error: null })
    );
    const result = await purgeClient("c-1");
    expect(remove).not.toHaveBeenCalled();
    expect(calls).toContain("rpc:fn_purge_client_photos");
    expect(result.failedPaths).toEqual([]);
  });

  it("surfaces a refusal from the purge itself rather than continuing", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "no such client" } });
    await expect(purgeClient("c-1")).rejects.toThrow("no such client");
    expect(remove).not.toHaveBeenCalled();
  });
});
