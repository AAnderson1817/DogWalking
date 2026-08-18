// Local snapshot of an in-progress walk.
//
// Two jobs, both about not losing the operator's work:
//
// 1. The service worker keeps Supabase REST network-only for privacy, so a
//    mid-walk reload while offline cannot re-fetch the walk row. The snapshot
//    lets Walk Mode re-enter recording mode offline instead of dead-ending and
//    dropping GPS for the rest of the walk.
//
// 2. Photos, care toggles and notes live only in React state until the walk is
//    completed (review H8). `walk_photos` rows are now written at upload time
//    so the photos themselves survive on the server, but the toggles and the
//    notes have no column to live in until completion — this is where they
//    survive a remount, an OS tab reclaim, or a back-swipe.
//
// The store is injectable so the round-trip is testable. Without that the
// module silently no-ops under Node (there is no `localStorage`, the access
// throws, and the catch swallows it), so a test would pass against a function
// that did nothing at all.

export interface WalkProgress {
  photo_paths: string[];
  toggles: { potty_pee: boolean; potty_poo: boolean; fed: boolean; watered: boolean };
  notes: string;
}

export interface WalkSnapshot {
  id: string;
  operator_id: string;
  client_id: string;
  status: string;
  started_at: string | null;
  scheduled_date: string;
  window_start: string;
  window_end: string;
  /** Absent on snapshots written before H8; `readWalkProgress` fills defaults. */
  progress?: WalkProgress;
}

export interface SnapshotStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY = (walkId: string) => `pawtrail:walk:${walkId}`;

export const EMPTY_PROGRESS: WalkProgress = {
  photo_paths: [],
  toggles: { potty_pee: false, potty_poo: false, fed: false, watered: false },
  notes: "",
};

function defaultStore(): SnapshotStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Private mode / disabled storage: offline resume is simply unavailable.
    return null;
  }
}

type WalkFields = Omit<WalkSnapshot, "progress">;

export function saveWalkSnapshot(
  walk: WalkFields,
  progress?: WalkProgress,
  store: SnapshotStore | null = defaultStore(),
): void {
  if (!store) return;
  try {
    store.setItem(
      KEY(walk.id),
      JSON.stringify({
        id: walk.id,
        operator_id: walk.operator_id,
        client_id: walk.client_id,
        status: walk.status,
        started_at: walk.started_at,
        scheduled_date: walk.scheduled_date,
        window_start: walk.window_start,
        window_end: walk.window_end,
        ...(progress ? { progress } : {}),
      } satisfies WalkSnapshot),
    );
  } catch {
    // quota exceeded — not fatal; the walk still records.
  }
}

export function loadWalkSnapshot(
  walkId: string,
  store: SnapshotStore | null = defaultStore(),
): WalkSnapshot | null {
  if (!store) return null;
  try {
    const raw = store.getItem(KEY(walkId));
    if (!raw) return null;
    const snap = JSON.parse(raw) as WalkSnapshot;
    return snap.id === walkId ? snap : null;
  } catch {
    return null;
  }
}

export function clearWalkSnapshot(
  walkId: string,
  store: SnapshotStore | null = defaultStore(),
): void {
  if (!store) return;
  try {
    store.removeItem(KEY(walkId));
  } catch {
    // ignore
  }
}

/**
 * Progress out of a snapshot, with every field defaulted.
 *
 * Total rather than partial on purpose: a snapshot written before H8, or one
 * half-written by a quota error, must not put `undefined` into `toggles` and
 * crash the resume path — the whole point is that resuming is more reliable
 * than not resuming.
 */
export function readWalkProgress(snap: WalkSnapshot | null | undefined): WalkProgress {
  const p = snap?.progress;
  if (!p) return EMPTY_PROGRESS;
  return {
    photo_paths: Array.isArray(p.photo_paths) ? p.photo_paths.filter((x) => typeof x === "string") : [],
    toggles: {
      potty_pee: p.toggles?.potty_pee === true,
      potty_poo: p.toggles?.potty_poo === true,
      fed: p.toggles?.fed === true,
      watered: p.toggles?.watered === true,
    },
    notes: typeof p.notes === "string" ? p.notes : "",
  };
}

/**
 * The photo set to resume with.
 *
 * `walk_photos` rows are the durable record and come first — they survive a
 * different device and a cleared cache. The snapshot is the fallback for a
 * photo uploaded to Storage while offline, whose row insert had nowhere to go:
 * dropping those would strand the file in the bucket with nothing pointing at
 * it, which is the original H8 failure wearing a smaller hat.
 */
export function mergeResumedPhotos(
  serverPaths: readonly string[],
  snapshotPaths: readonly string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...serverPaths, ...snapshotPaths]) {
    if (p && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/**
 * The notes to resume with.
 *
 * `walks.notes` is not written until completion, so on an in-progress walk the
 * column is whatever it held before — usually empty. The snapshot is therefore
 * the fresher of the two whenever it has anything in it.
 */
export function resumeNotes(snapshotNotes: string, dbNotes: string | null | undefined): string {
  return snapshotNotes.trim().length > 0 ? snapshotNotes : (dbNotes ?? "");
}

/**
 * Whether the screen should be writing the snapshot yet.
 *
 * The `hydrated` clause is the load-bearing one and the easiest to mistake for
 * redundant: Walk Mode mounts with empty photos, all-false toggles and empty
 * notes, and the initial load that puts the real values back is asynchronous.
 * A writer that runs before then persists the empty starting state over the
 * record it is about to read — turning the fix into the bug.
 */
export function shouldPersistProgress(s: {
  hydrated: boolean;
  status: string | null | undefined;
  completed: boolean;
}): boolean {
  return s.hydrated && s.status === "in_progress" && !s.completed;
}

/** A fetch/network failure (offline) vs. a real 4xx/5xx from the server. */
export function isNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /failed to fetch|networkerror|load failed|network request failed/i.test(msg);
}
