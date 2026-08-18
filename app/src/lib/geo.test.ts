import { describe, expect, it } from "vitest";
import {
  GPS_GAP_MS,
  haversineM,
  isGapFix,
  pathDistanceM,
  shouldEmitPoint,
  splitOnGaps,
  type GeoPoint,
} from "./geo";

// ~0.000090° latitude ≈ 10 m; ~0.000072° ≈ 8 m; ~0.000108° ≈ 12 m.
const at = (latOffset: number, t: number): GeoPoint => ({
  lat: 51.5 + latOffset,
  lng: -0.1,
  t,
});

describe("useGeolocation throttle rule (5 s AND 10 m)", () => {
  const start = at(0, 0);

  it("always emits the first point", () => {
    expect(shouldEmitPoint(null, start)).toBe(true);
  });

  it("suppresses 4 s / 8 m (neither threshold met)", () => {
    expect(shouldEmitPoint(start, at(0.000072, 4000))).toBe(false);
  });

  it("suppresses 6 s / 8 m (time ok, distance short)", () => {
    expect(shouldEmitPoint(start, at(0.000072, 6000))).toBe(false);
  });

  it("suppresses 4 s / 12 m (distance ok, too soon)", () => {
    expect(shouldEmitPoint(start, at(0.000108, 4000))).toBe(false);
  });

  it("passes 6 s / 12 m (both thresholds met)", () => {
    expect(shouldEmitPoint(start, at(0.000108, 6000))).toBe(true);
  });

  it("passes exactly at 5 s / 10 m", () => {
    expect(shouldEmitPoint(start, at(0.0000902, 5000))).toBe(true);
  });
});

describe("haversine", () => {
  it("measures ~111 m per 0.001° latitude", () => {
    const d = haversineM({ lat: 51.5, lng: -0.1 }, { lat: 51.501, lng: -0.1 });
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(112);
  });

  it("sums a path", () => {
    const path = [
      { lat: 51.5, lng: -0.1 },
      { lat: 51.501, lng: -0.1 },
      { lat: 51.502, lng: -0.1 },
    ];
    expect(pathDistanceM(path)).toBeGreaterThan(220);
    expect(pathDistanceM(path)).toBeLessThan(224);
  });
});

// ── Recording gaps (review H7) ─────────────────────────────────────────────
// watchPosition stops delivering when the phone screen locks or the app is
// backgrounded, and it does so silently. The next fix used to be appended as
// though it were the next step of the walk, so the route drew a straight line
// across the suspended interval and distance_m — the client-facing proof of
// service — measured it.

describe("isGapFix", () => {
  it("does not open a walk with a gap", () => {
    // No previous fix means no silence to measure, and nothing on screen for
    // the mark to break away from.
    expect(isGapFix(null, 10_000)).toBe(false);
  });

  it("ignores the ordinary one-a-second fix cadence", () => {
    expect(isGapFix(10_000, 11_000)).toBe(false);
  });

  it("flags a silence longer than the threshold", () => {
    expect(isGapFix(10_000, 10_000 + GPS_GAP_MS + 1)).toBe(true);
  });

  it("does not flag exactly at the threshold", () => {
    expect(isGapFix(10_000, 10_000 + GPS_GAP_MS)).toBe(false);
  });
});

describe("shouldEmitPoint after a gap", () => {
  it("emits the resume fix even when it is under BOTH thresholds", () => {
    // The device can wake up a metre from where it went to sleep — an operator
    // who stopped to talk to someone. That fix is where recording resumed, and
    // if the throttle suppresses it the mark lands further along the trail or
    // never lands at all.
    const prev = at(0, 0);
    const resume: GeoPoint = { ...at(0.0000090, 1000), gapBefore: true };
    expect(shouldEmitPoint(prev, resume)).toBe(true);
  });

  it("still suppresses an ordinary point under both thresholds", () => {
    expect(shouldEmitPoint(at(0, 0), at(0.0000090, 1000))).toBe(false);
  });
});

describe("pathDistanceM across a gap", () => {
  const A = { lat: 51.5, lng: -0.1 };
  const B = { lat: 51.501, lng: -0.1 };   // ~111 m from A
  const FAR = { lat: 51.51, lng: -0.1 };  // ~1001 m further on

  it("does not count the jump the device made while asleep", () => {
    const walked = pathDistanceM([A, B, { ...FAR, gapBefore: true }]);
    const drawn = pathDistanceM([A, B, FAR]);
    expect(walked).toBeGreaterThan(110);
    expect(walked).toBeLessThan(112);
    // Without the mark, a walk that recorded 111 m reports 1112 m.
    expect(drawn).toBeGreaterThan(1100);
  });

  it("keeps counting after the gap", () => {
    const d = pathDistanceM([A, { ...FAR, gapBefore: true }, { lat: 51.511, lng: -0.1 }]);
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(112);
  });

  it("is unchanged for a trail with no gaps", () => {
    expect(pathDistanceM([A, B])).toBe(pathDistanceM([A, B]));
    expect(pathDistanceM([A, B])).toBeGreaterThan(110);
  });
});

describe("splitOnGaps", () => {
  // `n` just labels the points so the assertions read as trails rather than
  // coordinates; the function only ever looks at `gapBefore`.
  type P = { n: number; gapBefore?: boolean };

  it("splits the trail into the runs that were actually recorded", () => {
    const pts: P[] = [{ n: 1 }, { n: 2 }, { n: 3, gapBefore: true }, { n: 4 }];
    expect(splitOnGaps(pts)).toEqual([[{ n: 1 }, { n: 2 }], [{ n: 3, gapBefore: true }, { n: 4 }]]);
  });

  it("returns one run when nothing was interrupted", () => {
    const pts: P[] = [{ n: 1 }, { n: 2 }];
    expect(splitOnGaps(pts)).toEqual([[{ n: 1 }, { n: 2 }]]);
  });

  it("does not open an empty run on a leading gap", () => {
    // A renderer handed [[], [...]] draws a zero-length line, and Mapbox
    // rejects an empty MultiLineString member.
    const pts: P[] = [{ n: 1, gapBefore: true }, { n: 2 }];
    expect(splitOnGaps(pts)).toEqual([[{ n: 1, gapBefore: true }, { n: 2 }]]);
  });

  it("handles consecutive gaps and an empty trail", () => {
    const pts: P[] = [{ n: 1 }, { n: 2, gapBefore: true }, { n: 3, gapBefore: true }];
    expect(splitOnGaps(pts))
      .toEqual([[{ n: 1 }], [{ n: 2, gapBefore: true }], [{ n: 3, gapBefore: true }]]);
    expect(splitOnGaps([] as P[])).toEqual([]);
  });
});
