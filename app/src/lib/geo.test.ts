import { describe, expect, it } from "vitest";
import { haversineM, pathDistanceM, shouldEmitPoint, type GeoPoint } from "./geo";

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
