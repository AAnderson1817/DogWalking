// Offline GPS outbox (phase 08): durable queue, ordered drain, backoff
// retries, reconnect backfill — with injected store/timers/connectivity.
import { describe, expect, it } from "vitest";
import { GpsOutbox, type OutboxBatch, type OutboxStore } from "./gps-outbox";
import type { GeoPoint } from "./geo";

/**
 * `startT` matters. Every batch used to start at t=0, so the ordering test
 * below could not tell a working sort from a store that merely happened to
 * return rows in insertion order — which is exactly the gap that let the real
 * `getAll()` ordering bug go unnoticed (review M7 work).
 */
const pts = (n: number, startT = 0): GeoPoint[] =>
  Array.from({ length: n }, (_, i) => ({ lat: 51.5, lng: -0.1 + i * 1e-4, t: startT + i * 6000 }));

/**
 * `scramble` models the real store. `makeIdbOutboxStore` keys on
 * `crypto.randomUUID()`, so `getAll()` returns rows sorted by that random key
 * — NOT in insertion order. A `Map`-backed fake preserves insertion order and
 * therefore cannot see an ordering bug at all.
 */
function makeStore(scramble = false): OutboxStore & { rows: Map<string, OutboxBatch> } {
  const rows = new Map<string, OutboxBatch>();
  return {
    rows,
    put: (b) => {
      rows.set(b.id, b);
      return Promise.resolve();
    },
    all: () => Promise.resolve(scramble ? [...rows.values()].reverse() : [...rows.values()]),
    delete: (id) => {
      rows.delete(id);
      return Promise.resolve();
    },
  };
}

function makeHarness(
  opts: {
    failTimes?: number;
    online?: () => boolean;
    maxAttempts?: number;
    poisonFirst?: boolean;
    scramble?: boolean;
    owner?: () => string | null;
    /** Fail with a message the default classifier reads as a dead network. */
    transient?: boolean;
  } = {},
) {
  const store = makeStore(opts.scramble);
  const sent: OutboxBatch[] = [];
  let failures = opts.failTimes ?? 0;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const outbox = new GpsOutbox(
    store,
    (batch) => {
      // Poison mode: the first-enqueued batch always fails; others succeed.
      if (opts.poisonFirst) {
        if (batch.walkId === "poison") {
          // A server ANSWER, not a transport failure: the row is bad and no
          // amount of retrying will change that.
          return Promise.reject(new Error("new row violates row-level security policy"));
        }
        sent.push(batch);
        return Promise.resolve();
      }
      if (failures > 0) {
        failures--;
        return Promise.reject(
          new Error(opts.transient ? "Failed to fetch" : "duplicate key value violates unique constraint"),
        );
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
      owner: opts.owner,
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

  it("a drain during an in-flight pass runs exactly one follow-up pass that sees late batches", async () => {
    // Pass 1 snapshots the store BEFORE the late batch is written. If drain()
    // merely returned the in-flight promise, end() could resolve with the
    // final batch still queued — the follow-up pass is the guarantee.
    let releaseFirstAll: ((rows: OutboxBatch[]) => void) | null = null;
    const rows = new Map<string, OutboxBatch>();
    let allCalls = 0;
    const store: OutboxStore & { deleted: string[] } = {
      deleted: [],
      put: (b) => {
        rows.set(b.id, b);
        return Promise.resolve();
      },
      all: () => {
        allCalls++;
        if (allCalls === 1) {
          return new Promise<OutboxBatch[]>((resolve) => {
            releaseFirstAll = resolve;
          });
        }
        return Promise.resolve([...rows.values()]);
      },
      delete(id) {
        this.deleted.push(id);
        rows.delete(id);
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

    const first = outbox.drain(); // pass 1 blocked inside store.all()
    await store.put({ id: "late", walkId: "walk-1", operatorId: "op-1", points: pts(1), attempts: 0 });
    const second = outbox.drain(); // must not resolve off pass 1's stale snapshot
    const third = outbox.drain(); // shares the single queued follow-up
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();

    expect(secondSettled).toBe(false);
    expect(releaseFirstAll).toBeTypeOf("function");
    releaseFirstAll!([]); // pass 1 saw nothing — "late" arrived after its snapshot
    await first;
    await second;
    await third;
    expect(sent.map((b) => b.id)).toEqual(["late"]); // follow-up delivered it
    expect(store.deleted).toEqual(["late"]);
    expect(allCalls).toBe(2); // exactly one follow-up pass, shared by callers 2+3
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
    await outbox.enqueue("walk-1", "op-1", pts(1, 0));
    await outbox.enqueue("walk-1", "op-1", pts(2, 100_000));
    await outbox.enqueue("walk-1", "op-1", pts(3, 200_000));
    await outbox.drain();
    expect(sent.map((b) => b.points.length)).toEqual([1, 2, 3]);
  });

  it("sends in RECORDED order even when the store returns rows arbitrarily", async () => {
    // The real store keys on a random uuid, so `getAll()` order is arbitrary.
    // The `Map`-backed fake preserves insertion order and so could never have
    // caught this; `scramble` reverses it.
    let online = false; // queue everything first, then drain in one pass
    const { outbox, sent } = makeHarness({ scramble: true, online: () => online });
    await outbox.enqueue("walk-1", "op-1", pts(1, 0));
    await outbox.enqueue("walk-1", "op-1", pts(2, 100_000));
    await outbox.enqueue("walk-1", "op-1", pts(3, 200_000));
    expect(sent).toHaveLength(0);
    online = true;
    await outbox.drain();
    expect(sent.map((b) => b.points.length)).toEqual([1, 2, 3]);
  });

  it("pendingFor returns a walk's points in time order, not store order", async () => {
    // This is the one that mattered on screen: a mid-walk resume seeds the
    // route from these points, so out-of-order points draw a zigzag polyline
    // and inflate `distance_m` — the number sold as proof of service.
    const { outbox } = makeHarness({ scramble: true, online: () => false });
    await outbox.enqueue("walk-1", "op-1", pts(2, 0));
    await outbox.enqueue("walk-1", "op-1", pts(2, 100_000));
    await outbox.enqueue("walk-1", "op-1", pts(2, 200_000));
    const times = (await outbox.pendingFor("walk-1")).map((p) => p.t);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times[0]).toBe(0);
    expect(times[times.length - 1]).toBe(206_000);
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
    // The 3rd failed send hits maxAttempts → given up on → the queue drains.
    await outbox.drain();
    expect(sent.some((b) => b.walkId === "walk-2")).toBe(true);

    // Marked dead, NOT deleted (review M7). These points are real
    // observations that never reached the database; destroying them removes
    // the only remaining evidence that the route has a hole in it, which is
    // what made the loss silent.
    const poison = [...store.rows.values()].find((b) => b.walkId === "poison");
    expect(poison).toBeDefined();
    expect(poison!.dead).toBe(true);
    expect(poison!.deadReason).toBe("rejected");
    expect(await outbox.pending()).toBe(0); // dead is not "waiting"
    expect(await outbox.deadFor("poison")).toHaveLength(1);
  });

  // ── Review M7: bad signal must not destroy route data ────────────────────
  //
  // `attempts` used to increment on ANY failure while `navigator.onLine` was
  // true — and `onLine` is true on a captive portal, on one bar with no
  // throughput, and on hotel wifi that resolves DNS and nothing else. Twelve
  // attempts of exponential backoff is about nine minutes, so a walk through a
  // patch of bad signal silently deleted its own route while the screen said
  // it was recording.
  it("does not count an attempt when the send never reached a server", async () => {
    const { outbox, store } = makeHarness({ failTimes: 5, transient: true });
    await outbox.enqueue("walk-1", "op-1", pts(2));
    for (let i = 0; i < 4; i++) await outbox.drain();
    const batch = [...store.rows.values()][0]!;
    expect(batch).toBeDefined();
    expect(batch.attempts).toBe(0);
    expect(batch.dead).toBeUndefined();
  });

  it("survives far more transient failures than maxAttempts", async () => {
    // The concrete regression: with maxAttempts 3 and the old counting rule,
    // three failed fetches destroyed the batch.
    const { outbox, store, sent } = makeHarness({ failTimes: 10, transient: true, maxAttempts: 3 });
    await outbox.enqueue("walk-1", "op-1", pts(4));
    for (let i = 0; i < 10; i++) await outbox.drain();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.points).toHaveLength(4);
    expect(store.rows.size).toBe(0);
  });

  it("still counts an attempt when the server answered", async () => {
    // The limit exists to bound a batch the server will never take. A
    // transport-only rule would make it unbounded and let one bad batch block
    // the walk's later points forever.
    const { outbox, store } = makeHarness({ failTimes: 5, transient: false });
    // `enqueue` drains, so this IS the first attempt — no extra drain here.
    await outbox.enqueue("walk-1", "op-1", pts(2));
    expect([...store.rows.values()][0]!.attempts).toBe(1);
    await outbox.drain();
    expect([...store.rows.values()][0]!.attempts).toBe(2);
  });

  it("backs off further on each transient failure without counting them", async () => {
    const { outbox, timers } = makeHarness({ failTimes: 3, transient: true });
    await outbox.enqueue("walk-1", "op-1", pts(2));
    await outbox.drain();
    await outbox.drain();
    const delays = timers.map((t) => t.ms);
    expect(delays.length).toBeGreaterThanOrEqual(2);
    expect(delays[1]!).toBeGreaterThan(delays[0]!);
  });

  // ── Review M8: another account's coordinates never leave this device ─────
  it("gives up on a batch belonging to a different operator instead of sending it", async () => {
    const { outbox, store, sent } = makeHarness({ owner: () => "op-2" });
    await outbox.enqueue("walk-1", "op-1", pts(3));
    await outbox.drain();
    expect(sent).toHaveLength(0);
    const batch = [...store.rows.values()][0]!;
    expect(batch.dead).toBe(true);
    expect(batch.deadReason).toBe("not_yours");
  });

  it("sends the current operator's own batches normally", async () => {
    const { outbox, sent } = makeHarness({ owner: () => "op-1" });
    await outbox.enqueue("walk-1", "op-1", pts(3));
    await outbox.drain();
    expect(sent).toHaveLength(1);
  });

  it("does not refuse anything before the operator id is known", async () => {
    // `operatorId` resolves asynchronously. A guard that treated "not yet
    // known" as "not yours" would destroy the operator's own route data on
    // every cold start.
    const { outbox, sent } = makeHarness({ owner: () => null });
    await outbox.enqueue("walk-1", "op-1", pts(3));
    await outbox.drain();
    expect(sent).toHaveLength(1);
  });

  it("pendingFor returns queued points for a walk", async () => {
    const { outbox } = makeHarness({ online: () => false }); // stay queued
    await outbox.enqueue("walk-1", "op-1", pts(3));
    await outbox.enqueue("walk-2", "op-1", pts(2));
    expect((await outbox.pendingFor("walk-1")).length).toBe(3);
    expect((await outbox.pendingFor("walk-9")).length).toBe(0);
  });
});
