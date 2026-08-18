import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGeolocation } from "./useGeolocation";
import { GPS_GAP_MS } from "@/lib/geo";

/**
 * Review M28, and a defect this change introduced before it fixed anything.
 *
 * `useGeolocation` was only ever switched on: `active` in Walk Mode was
 * `status === 'in_progress' && !result`, and once `result` existed the walk was
 * over. The overrun cap is the first code path that deactivates a LIVE walk and
 * can reactivate it, which makes the deactivate branch reachable for the first
 * time — and it cleared `lastFix` without leaving anything behind to say the
 * run had ended. `isGapFix(null, t)` is false, so the first fix after resuming
 * joined straight onto the last fix before the stop and `pathDistanceM`
 * measured the whole un-recorded stretch.
 *
 * That is H7's defect exactly — a straight line drawn across time nobody
 * recorded, on the distance the client is shown as proof of service.
 */

interface Watcher {
  (pos: { coords: { latitude: number; longitude: number; accuracy: number }; timestamp: number }): void;
}

const watchers: Watcher[] = [];
let cleared = 0;

beforeEach(() => {
  watchers.length = 0;
  cleared = 0;
  vi.stubGlobal("navigator", {
    geolocation: {
      watchPosition: (onFix: Watcher) => {
        watchers.push(onFix);
        return watchers.length;
      },
      clearWatch: () => {
        cleared += 1;
      },
    },
  });
});

/** Delivers a fix to the currently-installed watch. */
function fix(lat: number, lng: number, t: number) {
  const onFix = watchers[watchers.length - 1];
  if (!onFix) throw new Error("no watch is installed");
  act(() => onFix({ coords: { latitude: lat, longitude: lng, accuracy: 5 }, timestamp: t }));
}

const T0 = 1_760_000_000_000;
// Far enough apart to clear the ≥5 s / ≥10 m emit throttle. ~0.001° of
// latitude is ~111 m.
const north = (n: number) => 41.9 + n * 0.001;

describe("useGeolocation across a stop and a resume", () => {
  it("marks the first fix after a resume as a gap", () => {
    const { result, rerender } = renderHook(({ on }) => useGeolocation(on), {
      initialProps: { on: true },
    });

    fix(north(0), -87.6, T0);
    fix(north(1), -87.6, T0 + 10_000);
    expect(result.current.points).toHaveLength(2);
    expect(result.current.points[1]?.gapBefore).toBeUndefined();

    // The overrun cap.
    rerender({ on: false });
    expect(cleared).toBe(1);

    // …and the operator answering "Resume recording". The next fix arrives
    // immediately, so no TIME gap is visible from inside the watch — the only
    // thing that knows a stretch is missing is the deactivation itself.
    rerender({ on: true });
    fix(north(2), -87.6, T0 + 20_000);

    expect(result.current.points).toHaveLength(3);
    expect(result.current.points[2]?.gapBefore).toBe(true);
  });

  it("marks it even when the device wakes where it slept", () => {
    // `shouldEmitPoint` lets a gap fix through regardless of the ≥10 m rule,
    // so a resume within a few metres still lands on the trail — otherwise the
    // mark would attach to some later point, or to none.
    const { result, rerender } = renderHook(({ on }) => useGeolocation(on), {
      initialProps: { on: true },
    });
    fix(north(0), -87.6, T0);
    rerender({ on: false });
    rerender({ on: true });
    fix(north(0), -87.6, T0 + 1_000);

    expect(result.current.points).toHaveLength(2);
    expect(result.current.points[1]?.gapBefore).toBe(true);
  });

  it("does not mark a gap on a run that never produced a fix", () => {
    // Mounting, or a walk that has not started, must not open the trail with a
    // break — there is no preceding segment for it to break away from.
    const { result, rerender } = renderHook(({ on }) => useGeolocation(on), {
      initialProps: { on: false },
    });
    rerender({ on: true });
    fix(north(0), -87.6, T0);

    expect(result.current.points).toHaveLength(1);
    expect(result.current.points[0]?.gapBefore).toBeUndefined();
  });

  it("marks a gap only once, not on every fix after a resume", () => {
    const { result, rerender } = renderHook(({ on }) => useGeolocation(on), {
      initialProps: { on: true },
    });
    fix(north(0), -87.6, T0);
    rerender({ on: false });
    rerender({ on: true });
    fix(north(1), -87.6, T0 + 10_000);
    fix(north(2), -87.6, T0 + 20_000);

    expect(result.current.points[1]?.gapBefore).toBe(true);
    // A sticky flag would break the polyline into single points forever and
    // erase the rest of the walk's distance.
    expect(result.current.points[2]?.gapBefore).toBeUndefined();
  });

  it("still reports the ordinary time gap while a run is live", () => {
    // The M28 flag must not replace the H7 rule it sits beside.
    const { result } = renderHook(() => useGeolocation(true));
    fix(north(0), -87.6, T0);
    fix(north(1), -87.6, T0 + GPS_GAP_MS + 1_000);

    expect(result.current.points[1]?.gapBefore).toBe(true);
  });

  it("clears lastFixAt on deactivation so a resumed walk is not called stale", () => {
    const { result, rerender } = renderHook(({ on }) => useGeolocation(on), {
      initialProps: { on: true },
    });
    fix(north(0), -87.6, T0);
    expect(result.current.lastFixAt).toBe(T0);

    rerender({ on: false });
    expect(result.current.lastFixAt).toBeNull();
  });
});
