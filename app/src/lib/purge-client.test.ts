import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Review H5, the two-phase erasure, as 0058 left it.
 *
 * SQL cannot delete an object from a Supabase bucket: dropping the
 * `storage.objects` row removes the metadata and leaves the file. So
 * `fn_purge_client` returns every object in the client's folders, the browser
 * deletes them, and `fn_purge_client_photos` drops any photo rows written
 * since — but only once the database, counting `storage.objects` itself, says
 * nothing is left. Neither of Storage's own answers can prove an
 * object gone: `remove` reports only what it deleted just now, and a HEAD it
 * refuses reads the same as "not found".
 *
 * The mock keeps a set of the objects Storage holds, so "what is left" is
 * whatever the test's storage still contains, the way `fn_purge_client_status`
 * reads it — not whatever `remove` said.
 */

const rpc = vi.fn();
const remove = vi.fn();
const calls: string[] = [];
/** The objects Storage holds, as `bucket/name`. */
const stored = new Set<string>();

vi.mock("./supabase", () => ({
  supabase: {
    rpc: (...a: unknown[]) => {
      calls.push(`rpc:${String(a[0])}`);
      return rpc(...a);
    },
    // No `exists`: whether an object is gone is the database's question now,
    // and a call to it fails here rather than being answered.
    storage: {
      from: (bucket: string) => ({
        remove: (names: string[]) => {
          calls.push(`remove:${bucket}:${names.length}`);
          return remove(bucket, names);
        },
      }),
    },
  },
}));

const { getErasureStatus, purgeClient } = await import("./api");

const OP = "11111111-1111-4111-8111-111111111111";
const WALK_OBJECT = `${OP}/22222222-2222-4222-8222-222222222222/a.jpg`;
const PET_OBJECT = `${OP}/33333333-3333-4333-8333-333333333333/b.jpg`;
const WALK = `walk-photos/${WALK_OBJECT}`;
const PET = `pet-photos/${PET_OBJECT}`;

let listed: string[] = [];

function database() {
  rpc.mockImplementation((fn: string) => {
    if (fn === "fn_purge_client") {
      return Promise.resolve({ data: listed.map((storage_path) => ({ storage_path })), error: null });
    }
    if (fn === "fn_purge_client_status") {
      return Promise.resolve({
        data: { erased: true, finished: false, photos_left: stored.size },
        error: null,
      });
    }
    if (fn === "fn_purge_client_photos") {
      return stored.size > 0
        ? Promise.resolve({ data: null, error: { message: `${stored.size} photo(s) are still in storage` } })
        : Promise.resolve({ data: 1, error: null });
    }
    return Promise.reject(new Error(`unexpected rpc ${fn}`));
  });
}

beforeEach(() => {
  calls.length = 0;
  rpc.mockReset();
  remove.mockReset();
  stored.clear();
  stored.add(WALK).add(PET);
  listed = [WALK, PET];
  database();
  // Storage deletes what it is asked to, and reports each deletion.
  remove.mockImplementation((bucket: string, names: string[]) => {
    const gone = names.filter((n) => stored.delete(`${bucket}/${n}`));
    return Promise.resolve({ data: gone.map((name) => ({ name })), error: null });
  });
});

describe("purgeClient", () => {
  it("deletes the objects, asks what is left, and only then drops the rows", async () => {
    const result = await purgeClient("c-1");
    const at = (c: string) => calls.findIndex((x) => x.startsWith(c));
    expect(at("rpc:fn_purge_client")).toBe(0);
    expect(at("remove:")).toBeGreaterThan(at("rpc:fn_purge_client"));
    const lastRemove = Math.max(...calls.map((c, i) => (c.startsWith("remove:") ? i : -1)));
    expect(at("rpc:fn_purge_client_status")).toBeGreaterThan(lastRemove);
    expect(at("rpc:fn_purge_client_photos")).toBeGreaterThan(at("rpc:fn_purge_client_status"));
    expect(result).toEqual({ photosDeleted: 2, photosLeft: 0, finished: true });
  });

  it("deletes each object from the bucket its path names", async () => {
    await purgeClient("c-1");
    expect(remove).toHaveBeenCalledWith("walk-photos", [WALK_OBJECT]);
    expect(remove).toHaveBeenCalledWith("pet-photos", [PET_OBJECT]);
  });

  /**
   * A pet photo and a walk photo have the same shape, `{operator}/{uuid}/{file}`.
   * The browser used to guess the bucket from it and guessed walk-photos for
   * every pet photo, so no erasure with a pet photo ever finished. A path
   * without its bucket is left alone now, and the database's count still sees
   * its object.
   */
  it("never guesses a bucket for a path that does not name one", async () => {
    listed = [WALK_OBJECT, PET_OBJECT];
    const result = await purgeClient("c-1");
    expect(remove).not.toHaveBeenCalled();
    expect(result).toEqual({ photosDeleted: 0, photosLeft: 2, finished: false });
    expect(calls).not.toContain("rpc:fn_purge_client_photos");
  });

  /** The rows naming the folders are the only way back to what is left. */
  it("keeps the rows when storage refuses", async () => {
    remove.mockResolvedValue({ data: null, error: { message: "denied" } });
    const result = await purgeClient("c-1");
    expect(result).toEqual({ photosDeleted: 0, photosLeft: 2, finished: false });
    expect(calls).not.toContain("rpc:fn_purge_client_photos");
  });

  /**
   * A retry after a partial failure: the walk photo went the first time, so
   * storage deletes nothing for it now and says nothing about it. That silence
   * is not a refusal — the database, not `remove`, says what is left.
   */
  it("finishes on a retry, whatever remove says about what went before", async () => {
    stored.delete(WALK);
    const result = await purgeClient("c-1");
    expect(result).toEqual({ photosDeleted: 1, photosLeft: 0, finished: true });
    expect(calls).toContain("rpc:fn_purge_client_photos");
  });

  /**
   * The failure the old absence check invited: Storage refuses the delete
   * (an expired token, say) and then answers a HEAD for the same object as
   * though it were missing. Nothing here asks Storage whether an object
   * exists, so nothing here can be told that.
   */
  it("does not finish while storage still holds a photo, whatever storage said", async () => {
    remove.mockImplementation((_b: string, names: string[]) =>
      Promise.resolve({ data: names.map((name) => ({ name })), error: null })
    );
    const result = await purgeClient("c-1");
    expect(result).toEqual({ photosDeleted: 2, photosLeft: 2, finished: false });
    expect(calls).not.toContain("rpc:fn_purge_client_photos");
  });

  /** Storage deletes at most a thousand objects per request. */
  it("sends at most a thousand names per request", async () => {
    stored.clear();
    listed = Array.from({ length: 2500 }, (_, i) => `walk-photos/${OP}/w/${i}.jpg`);
    for (const p of listed) stored.add(p);
    const result = await purgeClient("c-1");
    expect(calls.filter((c) => c.startsWith("remove:"))).toEqual([
      "remove:walk-photos:1000", "remove:walk-photos:1000", "remove:walk-photos:500",
    ]);
    expect(result).toEqual({ photosDeleted: 2500, photosLeft: 0, finished: true });
  });

  /**
   * A long-standing client can have tens of thousands of objects, every
   * replaced pet photo among them. Grouping them by bucket copied the list so
   * far on every path: 14 s for 50,000 paths, measured, with the tab frozen
   * the whole time (Codex on PR #106).
   */
  it("groups tens of thousands of paths without stalling", async () => {
    stored.clear();
    listed = Array.from({ length: 50_000 }, (_, i) => `pet-photos/${OP}/p/${i}.jpg`);
    for (const p of listed) stored.add(p);
    const started = performance.now();
    const result = await purgeClient("c-1");
    const took = performance.now() - started;
    expect(result).toEqual({ photosDeleted: 50_000, photosLeft: 0, finished: true });
    expect(took, `erasing 50,000 objects took ${Math.round(took)} ms`).toBeLessThan(2_000);
  }, 60_000);

  it("keeps going after one batch is refused, and says what is left", async () => {
    stored.clear();
    listed = Array.from({ length: 1500 }, (_, i) => `walk-photos/${OP}/w/${i}.jpg`);
    for (const p of listed) stored.add(p);
    let first = true;
    remove.mockImplementation((bucket: string, names: string[]) => {
      if (first) {
        first = false;
        return Promise.resolve({ data: null, error: { message: "timeout" } });
      }
      const gone = names.filter((n) => stored.delete(`${bucket}/${n}`));
      return Promise.resolve({ data: gone.map((name) => ({ name })), error: null });
    });
    const result = await purgeClient("c-1");
    expect(result).toEqual({ photosDeleted: 500, photosLeft: 1000, finished: false });
  });

  /** The second phase is the last word; its refusal is not a success. */
  it("fails, rather than reporting success, when the rows could not be dropped", async () => {
    rpc.mockImplementation((fn: string) =>
      fn === "fn_purge_client"
        ? Promise.resolve({ data: [], error: null })
        : fn === "fn_purge_client_status"
          ? Promise.resolve({ data: { erased: true, finished: false, photos_left: 0 }, error: null })
          : Promise.resolve({ data: null, error: { message: "statement timeout" } })
    );
    await expect(purgeClient("c-1")).rejects.toThrow("statement timeout");
  });

  it("fails, rather than guessing, when it cannot ask what is left", async () => {
    rpc.mockImplementation((fn: string) =>
      fn === "fn_purge_client"
        ? Promise.resolve({ data: [], error: null })
        : Promise.resolve({ data: null, error: { message: "network down" } })
    );
    await expect(purgeClient("c-1")).rejects.toThrow("network down");
    expect(calls).not.toContain("rpc:fn_purge_client_photos");
  });

  it("still finishes cleanly when there are no photos at all", async () => {
    stored.clear();
    listed = [];
    const result = await purgeClient("c-1");
    expect(remove).not.toHaveBeenCalled();
    expect(result).toEqual({ photosDeleted: 0, photosLeft: 0, finished: true });
  });

  it("surfaces a refusal from the purge itself rather than continuing", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "no such client" } });
    await expect(purgeClient("c-1")).rejects.toThrow("no such client");
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("getErasureStatus", () => {
  it("reads the database's answer", async () => {
    rpc.mockResolvedValue({ data: { erased: true, finished: false, photos_left: 3 }, error: null });
    await expect(getErasureStatus("c-1")).resolves.toEqual({ erased: true, finished: false, photosLeft: 3 });
  });

  /** An answer it cannot read is not "finished", and not "nothing left". */
  it("refuses an answer in a shape it does not know", async () => {
    rpc.mockResolvedValue({ data: { erased: true, finished: true }, error: null });
    await expect(getErasureStatus("c-1")).rejects.toThrow("shape");
  });
});
