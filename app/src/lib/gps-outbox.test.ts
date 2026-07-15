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

function makeHarness(
  opts: { failTimes?: number; online?: () => boolean; maxAttempts?: number; poisonFirst?: boolean } = {},
) {
  const store = makeStore();
  const sent: OutboxBatch[] = [];
  let failures = opts.failTimes ?? 0;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const outbox = new GpsOutbox(
    store,
    (batch) => {
      // Poison mode: the first-enqueued batch always fails; others succeed.
      if (opts.poisonFirst) {
        if (batch.walkId === "poison") return Promise.reject(new Error("permanent"));
        sent.push(batch);
        return Promise.resolve();
      }
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
      maxAttempts: opts.maxAttempts,
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

  it("concurrent drain callers await the active drain pass", async () => {
    let releaseAll: ((rows: OutboxBatch[]) => void) | null = null;
    const store: OutboxStore & { deleted: string[] } = {
      deleted: [],
      put: () => Promise.resolve(),
      all: () =>
        new Promise<OutboxBatch[]>((resolve) => {
          releaseAll = resolve;
        }),
      delete(id) {
        this.deleted.push(id);
        return Promise.resolve();
      },
    };
    const sent: OutboxBatch[] = [];
    const outbox = new GpsOutbox(
      store,
      (batch) => {
        sent.push(batch);
        return Promise.resolve();
      },
      { online: () => true },
    );

    const first = outbox.drain();
    const second = outbox.drain();
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();

    expect(secondSettled).toBe(false);
    expect(releaseAll).toBeTypeOf("function");
    releaseAll!([{ id: "b1", walkId: "walk-1", operatorId: "op-1", points: pts(1), attempts: 0 }]);
    await first;
    await second;
    expect(secondSettled).toBe(true);
    expect(sent).toHaveLength(1);
    expect(store.deleted).toEqual(["b1"]);
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

  it("drops a poison batch only after exactly maxAttempts, then unblocks the queue", async () => {
    let online = false; // enqueue offline so no drains fire during setup
    const { outbox, store, sent } = makeHarness({
      poisonFirst: true,
      maxAttempts: 3,
      online: () => online,
    });
    await outbox.enqueue("poison", "op-1", pts(1)); // will always fail
    await outbox.enqueue("walk-2", "op-1", pts(2)); // stuck behind it
    online = true;

    // Each drain = one send attempt on the head (poison) batch. It must
    // survive until attempt maxAttempts — a premature drop is silent loss.
    for (let i = 1; i <= 2; i++) {
      await outbox.drain();
      const poison = [...store.rows.values()].find((b) => b.walkId === "poison");
      expect(poison, `poison must survive attempt ${i}`).toBeDefined();
      expect(poison!.attempts).toBe(i);
      expect(sent.some((b) => b.walkId === "walk-2")).toBe(false); // still blocked
    }
    // The 3rd failed send hits maxAttempts → drop → the queue drains.
    await outbox.drain();
    expect([...store.rows.values()].some((b) => b.walkId === "poison")).toBe(false);
    expect(sent.some((b) => b.walkId === "walk-2")).toBe(true);
    expect(store.rows.size).toBe(0);
  });

  it("pendingFor returns queued points for a walk", async () => {
    const { outbox } = makeHarness({ online: () => false }); // stay queued
    await outbox.enqueue("walk-1", "op-1", pts(3));
    await outbox.enqueue("walk-2", "op-1", pts(2));
    expect((await outbox.pendingFor("walk-1")).length).toBe(3);
    expect((await outbox.pendingFor("walk-9")).length).toBe(0);
  });
});
