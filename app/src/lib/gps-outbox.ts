// Offline GPS outbox (phase 08): a persistent queue in front of the
// walk_gps_points flush. Batches enqueue durably (IndexedDB), a drain loop
// pushes them with exponential backoff, survives reload mid-walk, and
// backfills on reconnect. Storage is injectable so the queue logic is
// unit-testable without IndexedDB.
import type { GeoPoint } from "./geo";

export interface OutboxBatch {
  id: string;
  walkId: string;
  operatorId: string;
  points: GeoPoint[];
  /**
   * Failed sends that the SERVER answered. Transport failures do not count —
   * see `isTransient` below, and review M7.
   */
  attempts: number;
  /**
   * Set when the batch has been given up on. Dead batches are skipped by the
   * drain and never deleted: the points are real observations that never
   * reached the database, so destroying them removes the only remaining record
   * that the route has a hole in it.
   */
  dead?: true;
  /** Why it was given up on — surfaced to the operator, not just logged. */
  deadReason?: "rejected" | "not_yours";
}

export interface OutboxStore {
  put(batch: OutboxBatch): Promise<void>;
  all(): Promise<OutboxBatch[]>;
  delete(id: string): Promise<void>;
}

export interface OutboxOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  /**
   * Give up on a batch after this many SERVER-ANSWERED failures. It bounds a
   * poison batch — one the server will never accept — so it cannot
   * head-of-line-block the rest of the queue forever. It deliberately does not
   * bound bad connectivity: see `isTransient`.
   */
  maxAttempts?: number;
  /**
   * True when the failure is the network rather than the payload.
   *
   * This is the whole of review M7. `attempts` used to increment on ANY
   * failure while `navigator.onLine` was true — and `onLine` is true on a
   * captive portal, on one bar with no throughput, and on a hotel wifi that
   * resolves DNS and nothing else. Twelve attempts of exponential backoff is
   * about nine minutes, so a walk through a patch of bad signal silently
   * destroyed its own route data, with no log, no counter and no flag, while
   * the screen said the walk was recording.
   *
   * A transport failure is not evidence the batch is bad, so it must not count
   * against a limit whose purpose is to identify a bad batch.
   */
  isTransient?: (err: unknown) => boolean;
  /**
   * The operator this device is currently signed in as. A batch belonging to
   * anyone else is marked dead rather than sent (review M8): after a sign-out
   * that did not get to clean up — a crash, a force-quit — the next operator's
   * session must not POST the previous one's coordinates. RLS refuses the
   * write anyway; without this the refusal is what burns the attempts.
   *
   * A function, not a value, because the outbox outlives the moment the
   * operator id becomes known. Returning null or "" disables the check, which
   * is the correct behaviour before sign-in has resolved.
   */
  owner?: () => string | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  online?: () => boolean;
}

/**
 * Default transport-failure test. Deliberately the same shape as
 * `isNetworkError` in walk-snapshot, and deliberately a separate copy: this
 * module is the offline layer and must not import a screen's helpers.
 *
 * A `fetch` that never reached a server rejects with a TypeError whose message
 * is one of these, per platform. Anything else — a PostgREST error, an RLS
 * refusal, a malformed row — reached a server and is the batch's own fault.
 */
export function isTransientSendError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /failed to fetch|networkerror|load failed|network request failed|timeout|aborted/i.test(msg);
}

/**
 * Batches in the order they were recorded.
 *
 * NOT insertion order, which is what the store used to be assumed to give:
 * `makeIdbOutboxStore` keys on a random uuid, so `getAll()` returns them
 * sorted by that key — i.e. arbitrarily. The existing "preserves enqueue
 * order" test passed only because its fake store is a `Map`, which does
 * preserve it. Ordering by the first point's own timestamp is both correct and
 * independent of the store, and it is what stops a mid-walk resume with
 * several queued batches drawing a scrambled polyline and inflating
 * `distance_m` — the number printed as proof of service.
 */
function inRecordedOrder(batches: readonly OutboxBatch[]): OutboxBatch[] {
  return [...batches].sort((a, b) => (a.points[0]?.t ?? 0) - (b.points[0]?.t ?? 0));
}

export class GpsOutbox {
  private drainPromise: Promise<void> | null = null;
  private queuedDrain: Promise<void> | null = null;
  private timer: unknown = null;
  private readonly store: OutboxStore;
  private readonly send: (batch: OutboxBatch) => Promise<void>;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxAttempts: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly online: () => boolean;
  private readonly isTransient: (err: unknown) => boolean;
  private readonly owner: () => string | null;
  /**
   * Backoff pressure, in-memory and per instance. Separate from a batch's
   * durable `attempts` on purpose: the delay should grow while the network is
   * bad, but a bad network must never march a batch toward being given up on.
   */
  private backoffStep = 0;

  constructor(
    store: OutboxStore,
    send: (batch: OutboxBatch) => Promise<void>,
    options: OutboxOptions = {},
  ) {
    this.store = store;
    this.send = send;
    this.baseDelayMs = options.baseDelayMs ?? 2000;
    this.maxDelayMs = options.maxDelayMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 12;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as number));
    this.online = options.online ?? (() => (typeof navigator === "undefined" ? true : navigator.onLine));
    this.isTransient = options.isTransient ?? isTransientSendError;
    this.owner = options.owner ?? (() => null);
  }

  /** Durably queue a batch, then drain (resolves after the drain pass). */
  async enqueue(walkId: string, operatorId: string, points: GeoPoint[]): Promise<void> {
    if (points.length === 0) return;
    await this.store.put({
      id: crypto.randomUUID(),
      walkId,
      operatorId,
      points,
      attempts: 0,
    });
    await this.drain();
  }

  /** Batches still waiting to be sent. Dead ones are not waiting for anything. */
  async pending(): Promise<number> {
    return (await this.store.all()).filter((b) => !b.dead).length;
  }

  /**
   * Batches given up on, per walk. This is the number that has to reach the
   * screen: a walk with any of these has a hole in its route and a distance
   * that under-reports, and before M7 the operator was told nothing at all.
   */
  async deadFor(walkId: string): Promise<OutboxBatch[]> {
    const all = await this.store.all();
    return inRecordedOrder(all.filter((b) => b.dead && b.walkId === walkId));
  }

  /** Points for a walk still queued (not yet inserted) — used to seed the
   * distance/route baseline on a mid-walk resume so queued batches aren't
   * missed from the total.
   *
   * Ordered by the fix timestamps themselves, and excluding dead batches:
   * those points are not going to reach the database, so counting them in the
   * operator's route would show them a distance the client's report will never
   * agree with. The screen says so instead. */
  async pendingFor(walkId: string): Promise<GeoPoint[]> {
    const all = await this.store.all();
    return inRecordedOrder(all.filter((b) => !b.dead && b.walkId === walkId))
      .flatMap((b) => b.points)
      .sort((a, b) => a.t - b.t);
  }

  /** Push everything queued; on failure reschedule with backoff.
   * A call that lands while a pass is already in flight queues exactly one
   * follow-up pass: the in-flight pass snapshotted the store before this
   * caller's batch may have been written, so returning the stale promise
   * alone would let end() resolve with the final batch still queued. */
  async drain(): Promise<void> {
    if (this.drainPromise) {
      this.queuedDrain ??= this.drainPromise
        .catch(() => {})
        .then(() => {
          this.queuedDrain = null;
          return this.drain();
        });
      return this.queuedDrain;
    }
    this.drainPromise = this.drainOnce().finally(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  private async drainOnce(): Promise<void> {
    if (!this.online()) {
      this.schedule(this.baseDelayMs);
      return;
    }
    const owner = this.owner();
    const batches = inRecordedOrder(await this.store.all());
    for (const batch of batches) {
      if (batch.dead) continue;

      // Review M8. Never send another account's coordinates from this device,
      // even though RLS would refuse them: the refusal is a server answer, so
      // it counts as an attempt and the batch marches toward being given up
      // on — the previous operator's route destroyed by the next operator
      // merely opening the app.
      if (owner && batch.operatorId && batch.operatorId !== owner) {
        await this.store.put({ ...batch, dead: true, deadReason: "not_yours" });
        continue;
      }

      try {
        await this.send(batch);
        await this.store.delete(batch.id);
        this.backoffStep = 0;
      } catch (err) {
        // Transport failure: the batch is fine, the network is not. Back off
        // and retry, but do NOT count it — counting is what destroyed route
        // data after ~9 minutes of bad signal (review M7).
        if (this.isTransient(err)) {
          this.backoffStep += 1;
          this.schedule(Math.min(this.baseDelayMs * 2 ** this.backoffStep, this.maxDelayMs));
          return; // stop the pass; retry later, in order
        }

        const attempts = batch.attempts + 1;
        if (attempts >= this.maxAttempts) {
          // The server has refused this batch `maxAttempts` times, so it is
          // never going to take it. Mark it dead and keep draining, so one
          // bad batch cannot block this walk's later points forever.
          //
          // Marked, NOT deleted. These are real observations that never
          // reached the database; deleting them destroys the only remaining
          // evidence that the route has a hole in it, which is exactly what
          // made this silent before.
          await this.store.put({ ...batch, attempts, dead: true, deadReason: "rejected" });
          continue;
        }
        await this.store.put({ ...batch, attempts });
        this.backoffStep += 1;
        this.schedule(Math.min(this.baseDelayMs * 2 ** this.backoffStep, this.maxDelayMs));
        return; // stop the pass; retry later, in order
      }
    }
  }

  private schedule(ms: number): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.drain();
    }, ms);
  }

  dispose(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
}

// ── IndexedDB adapter ──────────────────────────────────────────────────────
const DB_NAME = "pawtrail-outbox";
const STORE = "gps-batches";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexeddb open failed"));
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexeddb request failed"));
  });
}

/**
 * Destroy the whole outbox database (review M8).
 *
 * Sign-out used to clear the session and three pieces of React state and
 * nothing else, so raw GPS coordinates for another person's client stayed on a
 * shared device indefinitely — and because the outbox is only constructed
 * inside Walk Mode, no drain loop even existed to clear them, until the NEXT
 * operator opened Walk Mode and the batches were POSTed under their session.
 *
 * Resolves rather than rejects on failure. This runs during sign-out, and an
 * IndexedDB error must not leave a user still signed in.
 */
export function deleteOutboxDatabase(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve();
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.deleteDatabase(DB_NAME);
    } catch {
      return resolve();
    }
    // `onblocked` fires when another tab still holds the database open. It is
    // resolved rather than awaited: the other tab is signing out too, and
    // hanging sign-out on a tab nobody is looking at would be worse than a
    // delete that completes when that tab closes.
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

export function makeIdbOutboxStore(): OutboxStore {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const db = () => (dbPromise ??= openDb());
  return {
    async put(batch) {
      await tx(await db(), "readwrite", (s) => s.put(batch));
    },
    async all() {
      return await tx<OutboxBatch[]>(await db(), "readonly", (s) => s.getAll() as IDBRequest<OutboxBatch[]>);
    },
    async delete(id) {
      await tx(await db(), "readwrite", (s) => s.delete(id));
    },
  };
}
