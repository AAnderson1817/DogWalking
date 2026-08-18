// Geolocation math + emission throttle (spec 06: useGeolocation emits
// points throttled to ≥5 s AND ≥10 m deltas). Pure — unit-tested directly.

export interface GeoPoint {
  lat: number;
  lng: number;
  t: number; // epoch ms
  acc?: number; // accuracy metres
  /**
   * The watch stopped delivering fixes before this point — the screen locked,
   * the app was backgrounded, or the OS suspended the page (review H7). The
   * segment leading into this point is not a route the dog walked, so it is
   * not drawn and not counted.
   */
  gapBefore?: boolean;
}

const EARTH_R = 6371000;

/** Haversine distance in metres. */
export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(s));
}

export const EMIT_MIN_MS = 5000;
export const EMIT_MIN_M = 10;

/**
 * How long a silence between RAW fixes means the watch stopped rather than
 * paused (review H7).
 *
 * Measured on raw fixes, never on emitted ones. `watchPosition` with
 * `maximumAge: 0` delivers roughly once a second whether or not the device is
 * moving, but the emit throttle above requires ≥10 m — so an operator waiting
 * at a crossing for two minutes legitimately produces no emitted point for two
 * minutes. Reading a gap off emitted points would call that a suspension and
 * silently delete 10 m of real walking from the client's report.
 */
export const GPS_GAP_MS = 15_000;

/**
 * Did the watch stop between these two RAW fixes?
 *
 * `prevFixAt` null means this is the first fix of the run: there is no silence
 * to measure and nothing on screen for a gap to break away from, so a walk
 * never opens with one.
 *
 * Callers must pass raw-fix timestamps, never emitted-point timestamps. The
 * emit throttle needs ≥10 m as well as ≥5 s, so an operator standing at a
 * crossing produces no emitted point for as long as they wait — and applying
 * this rule there would report a suspension that never happened and delete
 * real walking from the client's distance.
 */
export function isGapFix(prevFixAt: number | null, t: number): boolean {
  return prevFixAt != null && t - prevFixAt > GPS_GAP_MS;
}

/**
 * Throttle rule: the first point always emits; after that a point emits only
 * when BOTH the time delta ≥5 s AND the distance delta ≥10 m.
 *
 * `gapBefore` overrides both. The first fix after a suspension is where
 * recording resumed, and that has to be on the trail even if the device came
 * back within 10 m of where it stopped — otherwise the mark that says "the
 * route is broken here" lands on a point somewhere further along, or never.
 */
export function shouldEmitPoint(prev: GeoPoint | null, next: GeoPoint): boolean {
  if (!prev) return true;
  if (next.gapBefore) return true;
  const dt = next.t - prev.t;
  const dm = haversineM(prev, next);
  return dt >= EMIT_MIN_MS && dm >= EMIT_MIN_M;
}

/**
 * Total path length of an emitted polyline, in metres (walk distance).
 *
 * A segment INTO a `gapBefore` point is skipped: nobody walked it, the device
 * was simply somewhere else when it woke up. Counting it inflates `distance_m`
 * — the client-facing proof of service on the report card — by the straight
 * line across however far the walk got while the screen was locked.
 */
export function pathDistanceM(
  points: ReadonlyArray<{ lat: number; lng: number; gapBefore?: boolean }>,
): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i]!.gapBefore) continue;
    total += haversineM(points[i - 1]!, points[i]!);
  }
  return Math.round(total);
}

/**
 * Split a trail into the runs that were actually recorded, so a renderer draws
 * separate lines instead of one that cuts across the gap.
 *
 * Returns at least one segment for a non-empty trail; a leading `gapBefore` on
 * the very first point is meaningless and does not open an empty segment.
 */
export function splitOnGaps<T extends { gapBefore?: boolean }>(
  points: ReadonlyArray<T>,
): T[][] {
  const out: T[][] = [];
  let run: T[] = [];
  for (const p of points) {
    if (p.gapBefore && run.length > 0) {
      out.push(run);
      run = [];
    }
    run.push(p);
  }
  if (run.length > 0) out.push(run);
  return out;
}
