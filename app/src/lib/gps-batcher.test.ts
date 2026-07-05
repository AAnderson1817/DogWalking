import { describe, expect, it } from "vitest";
import { GpsBatcher } from "./gps-batcher";
import type { GeoPoint } from "./geo";

const p = (i: number): GeoPoint => ({ lat: 51.5, lng: -0.1 + i * 0.0001, t: i * 6000 });

function makeBatcher() {
  const flushes: GeoPoint[][] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const batcher = new GpsBatcher((points) => void flushes.push(points), {
    setTimer: (fn, ms) => {
      const handle = { fn, ms, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearTimer: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  });
  return { batcher, flushes, timers };
}

describe("useWalkChannel batching (10 points / 60 s / end)", () => {
  it("the 10th point triggers a flush of all ten", () => {
    const { batcher, flushes } = makeBatcher();
    for (let i = 0; i < 9; i++) batcher.add(p(i));
    expect(flushes.length).toBe(0);
    expect(batcher.pending).toBe(9);
    batcher.add(p(9));
    expect(flushes.length).toBe(1);
    expect(flushes[0]).toHaveLength(10);
    expect(batcher.pending).toBe(0);
  });

  it("the 60 s timer flushes a partial batch", () => {
    const { batcher, flushes, timers } = makeBatcher();
    batcher.add(p(0));
    batcher.add(p(1));
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(60_000);
    timers[0]!.fn(); // fire the timer
    expect(flushes.length).toBe(1);
    expect(flushes[0]).toHaveLength(2);
  });

  it("end() flushes the remainder", () => {
    const { batcher, flushes } = makeBatcher();
    for (let i = 0; i < 13; i++) batcher.add(p(i));
    expect(flushes.length).toBe(1); // the full ten
    batcher.end();
    expect(flushes.length).toBe(2);
    expect(flushes[1]).toHaveLength(3);
  });

  it("end() with an empty buffer is a no-op", () => {
    const { batcher, flushes } = makeBatcher();
    batcher.end();
    expect(flushes.length).toBe(0);
  });

  it("a size flush cancels the pending timer", () => {
    const { batcher, timers } = makeBatcher();
    for (let i = 0; i < 10; i++) batcher.add(p(i));
    expect(timers[0]!.cleared).toBe(true);
  });
});
