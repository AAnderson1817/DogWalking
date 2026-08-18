// Live position stream (spec 06): watchPosition with high accuracy, points
// throttled to ≥5 s AND ≥10 m deltas (lib/geo.ts — tested there).
//
// The watch stops delivering when the page is backgrounded or the screen locks
// (review H7), and it does so SILENTLY — no error fires, so `error` stays null
// and nothing on screen changes. `lastFixAt` is the only honest signal that
// recording is still happening, and a fix arriving after a silence is marked
// `gapBefore` so the trail is drawn and measured as two runs rather than one
// line straight across the missing stretch.
import { useEffect, useRef, useState } from "react";
import { isGapFix, shouldEmitPoint, type GeoPoint } from "@/lib/geo";

export interface GeolocationState {
  /** Emitted (throttled) trail since activation. */
  points: GeoPoint[];
  /** Latest raw fix, throttled or not (for the "you are here" marker). */
  current: GeoPoint | null;
  error: string | null;
  permission: "unknown" | "granted" | "denied";
  /**
   * Epoch ms of the last RAW fix, or null before the first one. Compare
   * against wall-clock to know whether the watch is still alive — the caller
   * already ticks once a second for the elapsed timer.
   */
  lastFixAt: number | null;
}

export function useGeolocation(active: boolean): GeolocationState {
  const [points, setPoints] = useState<GeoPoint[]>([]);
  const [current, setCurrent] = useState<GeoPoint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [permission, setPermission] = useState<GeolocationState["permission"]>("unknown");
  const [lastFixAt, setLastFixAt] = useState<number | null>(null);
  const lastEmitted = useRef<GeoPoint | null>(null);
  const lastFix = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      // Deactivating ends the run. Leaving the timestamp behind would make a
      // resumed walk look like it had been recording all along.
      lastFix.current = null;
      setLastFixAt(null);
      return;
    }
    if (!("geolocation" in navigator)) {
      setError("geolocation is not available on this device");
      return;
    }
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setPermission("granted");
        setError(null);
        // Measured on RAW fixes. These arrive about once a second regardless
        // of movement, so a silence really is the watch stopping — whereas
        // emitted points can legitimately be minutes apart when the operator
        // is standing still, because the throttle also requires ≥10 m.
        const gapBefore = isGapFix(lastFix.current, pos.timestamp);
        lastFix.current = pos.timestamp;
        setLastFixAt(pos.timestamp);

        const point: GeoPoint = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          t: pos.timestamp,
          acc: pos.coords.accuracy,
          ...(gapBefore ? { gapBefore: true } : {}),
        };
        setCurrent(point);
        if (shouldEmitPoint(lastEmitted.current, point)) {
          lastEmitted.current = point;
          setPoints((prev) => [...prev, point]);
        }
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) setPermission("denied");
        setError(err.message);
      },
      { enableHighAccuracy: true, maximumAge: 0 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [active]);

  return { points, current, error, permission, lastFixAt };
}
