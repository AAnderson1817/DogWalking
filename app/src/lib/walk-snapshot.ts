// Local snapshot of an in-progress walk (re-review fix). The service worker
// keeps Supabase REST network-only for privacy, so a mid-walk reload while
// offline can't re-fetch the walk row. This lightweight localStorage snapshot
// lets Walk Mode re-enter recording mode offline instead of dead-ending and
// dropping GPS for the rest of the walk.

export interface WalkSnapshot {
  id: string;
  operator_id: string;
  client_id: string;
  status: string;
  started_at: string | null;
  scheduled_date: string;
  window_start: string;
  window_end: string;
}

const KEY = (walkId: string) => `pawtrail:walk:${walkId}`;

export function saveWalkSnapshot(walk: {
  id: string;
  operator_id: string;
  client_id: string;
  status: string;
  started_at: string | null;
  scheduled_date: string;
  window_start: string;
  window_end: string;
}): void {
  try {
    localStorage.setItem(
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
      } satisfies WalkSnapshot),
    );
  } catch {
    // storage unavailable (private mode / quota) — offline resume just won't
    // be available; not fatal.
  }
}

export function loadWalkSnapshot(walkId: string): WalkSnapshot | null {
  try {
    const raw = localStorage.getItem(KEY(walkId));
    if (!raw) return null;
    const snap = JSON.parse(raw) as WalkSnapshot;
    return snap.id === walkId ? snap : null;
  } catch {
    return null;
  }
}

export function clearWalkSnapshot(walkId: string): void {
  try {
    localStorage.removeItem(KEY(walkId));
  } catch {
    // ignore
  }
}

/** A fetch/network failure (offline) vs. a real 4xx/5xx from the server. */
export function isNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /failed to fetch|networkerror|load failed|network request failed/i.test(msg);
}
