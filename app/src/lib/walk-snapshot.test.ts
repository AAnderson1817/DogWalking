// Walk-mode durability (review H8).
//
// Photos, care toggles and notes lived only in React state until the walk was
// completed, so any remount — a reload, a back-swipe, the OS reclaiming the
// tab — lost all of them silently. The resume path reseeded GPS and nothing
// else. These are the decisions that make resuming correct, kept pure so they
// can be tested: the screen itself renders in a browser and this suite runs in
// Node.
import { describe, expect, it } from "vitest";
import {
  clearWalkSnapshot,
  EMPTY_PROGRESS,
  loadWalkSnapshot,
  mergeResumedPhotos,
  readWalkProgress,
  resumeNotes,
  saveWalkSnapshot,
  shouldPersistProgress,
  walkSnapshotKeys,
  type SnapshotStore,
  type WalkSnapshot,
} from "./walk-snapshot";

function makeStore(): SnapshotStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    getItem: (k) => rows.get(k) ?? null,
    setItem: (k, v) => void rows.set(k, v),
    removeItem: (k) => void rows.delete(k),
  };
}

const WALK = {
  id: "walk-1",
  operator_id: "op-1",
  client_id: "cl-1",
  status: "in_progress",
  started_at: "2026-08-18T14:00:00.000Z",
  scheduled_date: "2026-08-18",
  window_start: "14:00",
  window_end: "15:00",
};

const PROGRESS = {
  photo_paths: ["op-1/walk-1/a.jpg", "op-1/walk-1/b.jpg"],
  toggles: { potty_pee: true, potty_poo: false, fed: true, watered: false },
  notes: "Chased a squirrel, otherwise uneventful.",
};

describe("walk snapshot round-trip", () => {
  it("carries photos, toggles and notes across a remount", () => {
    const store = makeStore();
    saveWalkSnapshot(WALK, PROGRESS, store);
    const back = readWalkProgress(loadWalkSnapshot("walk-1", store));
    expect(back).toEqual(PROGRESS);
  });

  it("still round-trips the walk fields the offline resume needs", () => {
    // The original job of this record: re-enter recording mode with no network.
    const store = makeStore();
    saveWalkSnapshot(WALK, PROGRESS, store);
    const snap = loadWalkSnapshot("walk-1", store);
    expect(snap?.started_at).toBe(WALK.started_at);
    expect(snap?.operator_id).toBe("op-1");
    expect(snap?.status).toBe("in_progress");
  });

  it("is dropped when the walk completes", () => {
    const store = makeStore();
    saveWalkSnapshot(WALK, PROGRESS, store);
    clearWalkSnapshot("walk-1", store);
    expect(loadWalkSnapshot("walk-1", store)).toBeNull();
  });

  it("refuses a record belonging to another walk", () => {
    const store = makeStore();
    store.setItem("pawtrail:walk:walk-1", JSON.stringify({ ...WALK, id: "walk-2" }));
    expect(loadWalkSnapshot("walk-1", store)).toBeNull();
  });

  it("survives having no storage at all rather than throwing", () => {
    // Private mode, or Node. The walk must still record.
    expect(() => saveWalkSnapshot(WALK, PROGRESS, null)).not.toThrow();
    expect(loadWalkSnapshot("walk-1", null)).toBeNull();
    expect(() => clearWalkSnapshot("walk-1", null)).not.toThrow();
  });
});

describe("readWalkProgress", () => {
  it("defaults every field for a snapshot written before H8", () => {
    // These exist in the wild: any walk started before this shipped has a
    // snapshot with no `progress` key at all. Returning undefined toggles here
    // would crash the resume path, which is worse than not resuming.
    expect(readWalkProgress({ ...WALK } as WalkSnapshot)).toEqual(EMPTY_PROGRESS);
    expect(readWalkProgress(null)).toEqual(EMPTY_PROGRESS);
  });

  it("defaults each field independently when the record is half-written", () => {
    const half = {
      ...WALK,
      progress: { photo_paths: ["a.jpg"] },
    } as unknown as WalkSnapshot;
    const p = readWalkProgress(half);
    expect(p.photo_paths).toEqual(["a.jpg"]);
    expect(p.toggles).toEqual(EMPTY_PROGRESS.toggles);
    expect(p.notes).toBe("");
  });

  it("coerces a truthy-but-not-true toggle to false", () => {
    const odd = {
      ...WALK,
      progress: { ...PROGRESS, toggles: { potty_pee: "yes" } },
    } as unknown as WalkSnapshot;
    expect(readWalkProgress(odd).toggles.potty_pee).toBe(false);
  });
});

describe("mergeResumedPhotos", () => {
  it("keeps a photo whose walk_photos row never landed", () => {
    // Uploaded while offline: the file reached Storage, the row insert had
    // nowhere to go. Dropping it strands the file in the bucket with nothing
    // pointing at it — the original H8 failure, smaller.
    expect(mergeResumedPhotos(["a.jpg"], ["a.jpg", "b.jpg"])).toEqual(["a.jpg", "b.jpg"]);
  });

  it("does not duplicate a photo present in both", () => {
    expect(mergeResumedPhotos(["a.jpg", "b.jpg"], ["b.jpg"])).toEqual(["a.jpg", "b.jpg"]);
  });

  it("puts the server first — it is the record that survives a new device", () => {
    expect(mergeResumedPhotos(["s1.jpg"], ["local.jpg"])).toEqual(["s1.jpg", "local.jpg"]);
  });

  it("handles either side being empty", () => {
    expect(mergeResumedPhotos([], ["a.jpg"])).toEqual(["a.jpg"]);
    expect(mergeResumedPhotos(["a.jpg"], [])).toEqual(["a.jpg"]);
    expect(mergeResumedPhotos([], [])).toEqual([]);
  });
});

describe("shouldPersistProgress", () => {
  it("does NOT write before the initial load has restored what was there", () => {
    // The whole fix inverts if this clause goes: the screen mounts with no
    // photos, all-false toggles and empty notes, and writing that over the
    // saved record is the bug this file exists to prevent.
    expect(shouldPersistProgress({ hydrated: false, status: "in_progress", completed: false }))
      .toBe(false);
  });

  it("writes once hydrated and the walk is running", () => {
    expect(shouldPersistProgress({ hydrated: true, status: "in_progress", completed: false }))
      .toBe(true);
  });

  it("stops once the walk is completed — the server has it now", () => {
    expect(shouldPersistProgress({ hydrated: true, status: "in_progress", completed: true }))
      .toBe(false);
  });

  it("never writes for a walk that has not started", () => {
    expect(shouldPersistProgress({ hydrated: true, status: "scheduled", completed: false }))
      .toBe(false);
    expect(shouldPersistProgress({ hydrated: true, status: null, completed: false }))
      .toBe(false);
  });
});

describe("resumeNotes", () => {
  it("prefers the snapshot — walks.notes is not written until completion", () => {
    expect(resumeNotes("typed mid-walk", "")).toBe("typed mid-walk");
    expect(resumeNotes("typed mid-walk", null)).toBe("typed mid-walk");
  });

  it("falls back to the column when the snapshot has nothing", () => {
    expect(resumeNotes("", "prefilled")).toBe("prefilled");
    expect(resumeNotes("   ", "prefilled")).toBe("prefilled");
  });

  it("returns empty rather than undefined when neither has anything", () => {
    expect(resumeNotes("", null)).toBe("");
    expect(resumeNotes("", undefined)).toBe("");
  });
});

/**
 * Review M8. Sign-out cleared the session and three pieces of React state and
 * nothing else, so the previous operator's walk notes, care toggles and photo
 * paths stayed on a shared device — beside the raw GPS coordinates in the
 * outbox.
 */
describe("walkSnapshotKeys", () => {
  /** Minimal Storage-shaped fake: only `length` and `key(i)` are read. */
  function fakeStorage(keys: string[]) {
    return { length: keys.length, key: (i: number) => keys[i] ?? null };
  }

  it("finds every walk snapshot", () => {
    const keys = walkSnapshotKeys(
      fakeStorage(["pawtrail:walk:a", "pawtrail:walk:b", "pawtrail:walk:c"]),
    );
    expect(keys).toEqual(["pawtrail:walk:a", "pawtrail:walk:b", "pawtrail:walk:c"]);
  });

  it("leaves everything else alone", () => {
    // Supabase keeps the session under `sb-*`, and clearing storage wholesale
    // would sign the user out of a tab that is not signing out.
    const keys = walkSnapshotKeys(
      fakeStorage(["sb-abc-auth-token", "pawtrail:walk:a", "theme", "pawtrail:other"]),
    );
    expect(keys).toEqual(["pawtrail:walk:a"]);
  });

  it("collects before deleting, so no key is skipped", () => {
    // The bug this shape avoids: removing inside an index-based `key(i)` loop
    // shifts the remaining entries, so every second match is stepped over. The
    // function returns a list precisely so the caller cannot make that mistake.
    const live = ["pawtrail:walk:a", "pawtrail:walk:b", "pawtrail:walk:c", "pawtrail:walk:d"];
    const store = {
      get length() {
        return live.length;
      },
      key: (i: number) => live[i] ?? null,
    };
    const found = walkSnapshotKeys(store);
    for (const k of found) live.splice(live.indexOf(k), 1);
    expect(found).toHaveLength(4);
    expect(live).toEqual([]);
  });

  it("finds nothing in empty storage", () => {
    expect(walkSnapshotKeys(fakeStorage([]))).toEqual([]);
  });
});
