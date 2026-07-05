// Live position stream (spec 06): watchPosition with high accuracy, points
// throttled to ≥5 s AND ≥10 m deltas (lib/geo.ts — tested there).
import { useEffect, useRef, useState } from "react";
import { shouldEmitPoint, type GeoPoint } from "@/lib/geo";

export interface GeolocationState {
  /** Emitted (throttled) trail since activation. */
  points: GeoPoint[];
  /** Latest raw fix, throttled or not (for the "you are here" marker). */
  current: GeoPoint | null;
  error: string | null;
  permission: "unknown" | "granted" | "denied";
}

export function useGeolocation(active: boolean): GeolocationState {
  const [points, setPoints] = useState<GeoPoint[]>([]);
  const [current, setCurrent] = useState<GeoPoint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [permission, setPermission] = useState<GeolocationState["permission"]>("unknown");
  const lastEmitted = useRef<GeoPoint | null>(null);

  useEffect(() => {
    if (!active) return;
    if (!("geolocation" in navigator)) {
      setError("geolocation is not available on this device");
      return;
    }
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setPermission("granted");
        setError(null);
        const point: GeoPoint = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          t: pos.timestamp,
          acc: pos.coords.accuracy,
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

  return { points, current, error, permission };
}
