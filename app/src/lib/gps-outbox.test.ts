// Offline GPS outbox (phase 08): durable queue, ordered drain, backoff
// retries, reconnect backfill — with injected store/timers/connectivity.
import { describe, expect, it } from "vitest";
import { GpsOutbox, type OutboxBatch, type OutboxStore } from "./gps-outbox";
import type { GeoPoint } from "./geo";

const pts = (n: number): GeoPoint[] =>
  Array.from({ length: n }, (_, i) => ({ lat: 51.5, lng: -0.1 + i * 1e-4, t: i * 6000 }));

function makeStore(): OutboxStore & { rows: Map<string, OutboxBatch> } {
  const rows = new Map<string, OutboxBatch>();
  return {
    rows,
    put: (b) => {
      rows.set(b.id, b);
      return Promise.resolve();
    },
    all: () => Promise.resolve([...rows.values()]),
    delete: (id) => {
      rows.delete(id);
      return Promise.resolve();
    },
  };
}

function makeHarness(opts: { failTimes?: number; online?: () => boolean } = {}) {
  const store = makeStore();
  const sent: OutboxBatch[] = [];
  let failures = opts.failTimes ?? 0;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const outbox = new GpsOutbox(
    store,
    (batch) => {
      if (failures > 0) {
        failures--;
        return Promise.reject(new Error("network down"));
      }
      sent.push(batch);
      return Promise.resolve();
    },
    {
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length - 1;
      },
      clearTimer: () => {},
      online: opts.online ?? (() => true),
    },
  );
  return { outbox, store, sent, timers, fire: async () => timers.splice(0).forEach((t) => t.fn()) };
}

describe("GpsOutbox", () => {
  it("sends enqueued batches and clears the store", async () => {
    const { outbox, store, sent } = makeHarness();
    await outbox.enqueue("walk-1", "op-1", pts(10)); // enqueue drains
    expect(sent).toHaveLength(1);
    expect(sent[0]!.points).toHaveLength(10);
    expect(store.rows.size).toBe(0);
  });

  it("keeps failed batches durably and schedules a backoff retry", async () => {
    const { outbox, store, sent, timers } = makeHarness({ failTimes: 1 });
    await outbox.enqueue("walk-1", "op-1", pts(3)); // drain inside fails
    expect(sent).toHaveLength(0);
    expect(store.rows.size).toBe(1);
    expect([...store.rows.values()][0]!.attempts).toBe(1);
    expect(timers.length).toBeGreaterThan(0);
    expect(timers[timers.length - 1]!.ms).toBe(2000); // base × 2^1
  });

  it("backoff grows with attempts and is capped", async () => {
    const { outbox, store, timers } = makeHarness({ failTimes: 10 });
    await outbox.enqueue("walk-1", "op-1", pts(1));
    for (let i = 0; i < 6; i++) {
      await outbox.drain();
    }
    const delays = timers.map((t) => t.ms);
    expect(Math.max(...delays)).toBeLessThanOrEqual(30_000);
    expect([...store.rows.values()][0]!.attempts).toBeGreaterThanOrEqual(5);
  });

  it("drains the survivors after 'reconnect' (retry succeeds)", async () => {
    const { outbox, sent, store } = makeHarness({ failTimes: 1 });
    await outbox.enqueue("walk-1", "op-1", pts(20)); // first drain fails
    expect(store.rows.size).toBe(1);
    await outbox.drain(); // reconnect: succeeds
    expect(sent).toHaveLength(1);
    expect(sent[0]!.points).toHaveLength(20);
    expect(store.rows.size).toBe(0);
  });

  it("waits while offline instead of burning attempts", async () => {
    let online = false;
    const { outbox, sent, store } = makeHarness({ online: () => online });
    await outbox.enqueue("walk-1", "op-1", pts(2));
    expect(sent).toHaveLength(0);
    expect(store.rows.size).toBe(1);
    expect([...store.rows.values()][0]!.attempts).toBe(0); // never attempted
    online = true;
    await outbox.drain();
    expect(sent).toHaveLength(1);
  });

  it("preserves enqueue order across multiple batches", async () => {
    const { outbox, sent } = makeHarness();
    await outbox.enqueue("walk-1", "op-1", pts(1));
    await outbox.enqueue("walk-1", "op-1", pts(2));
    await outbox.enqueue("walk-1", "op-1", pts(3));
    await outbox.drain();
    expect(sent.map((b) => b.points.length)).toEqual([1, 2, 3]);
  });
});
