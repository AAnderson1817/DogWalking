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
  attempts: number;
}

export interface OutboxStore {
  put(batch: OutboxBatch): Promise<void>;
  all(): Promise<OutboxBatch[]>;
  delete(id: string): Promise<void>;
}

export interface OutboxOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Drop a batch after this many failed sends so one poison batch can't
   * head-of-line-block all GPS sync forever (points are best-effort). */
  maxAttempts?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  online?: () => boolean;
}

export class GpsOutbox {
  private draining = false;
  private timer: unknown = null;
  private readonly store: OutboxStore;
  private readonly send: (batch: OutboxBatch) => Promise<void>;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxAttempts: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly online: () => boolean;

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

  async pending(): Promise<number> {
    return (await this.store.all()).length;
  }

  /** Push everything queued; on failure reschedule with backoff. */
  async drain(): Promise<void> {
    if (this.draining) return;
    if (!this.online()) {
      this.schedule(this.baseDelayMs);
      return;
    }
    this.draining = true;
    try {
      const batches = await this.store.all();
      for (const batch of batches) {
        try {
          await this.send(batch);
          await this.store.delete(batch.id);
        } catch {
          const attempts = batch.attempts + 1;
          if (attempts >= this.maxAttempts) {
            // Poison batch: drop it and keep draining so it can't block the
            // rest of the queue (and this walk's later points) forever.
            await this.store.delete(batch.id);
            continue;
          }
          await this.store.put({ ...batch, attempts });
          this.schedule(Math.min(this.baseDelayMs * 2 ** attempts, this.maxDelayMs));
          return; // stop the pass; retry later in order
        }
      }
    } finally {
      this.draining = false;
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
