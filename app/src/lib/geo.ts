// Geolocation math + emission throttle (spec 06: useGeolocation emits
// points throttled to ≥5 s AND ≥10 m deltas). Pure — unit-tested directly.

export interface GeoPoint {
  lat: number;
  lng: number;
  t: number; // epoch ms
  acc?: number; // accuracy metres
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
 * Throttle rule: the first point always emits; after that a point emits only
 * when BOTH the time delta ≥5 s AND the distance delta ≥10 m.
 */
export function shouldEmitPoint(prev: GeoPoint | null, next: GeoPoint): boolean {
  if (!prev) return true;
  const dt = next.t - prev.t;
  const dm = haversineM(prev, next);
  return dt >= EMIT_MIN_MS && dm >= EMIT_MIN_M;
}

/** Total path length of an emitted polyline, in metres (walk distance). */
export function pathDistanceM(points: ReadonlyArray<{ lat: number; lng: number }>): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineM(points[i - 1]!, points[i]!);
  }
  return Math.round(total);
}
