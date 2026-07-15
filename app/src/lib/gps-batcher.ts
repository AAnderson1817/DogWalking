// Batched GPS persistence (spec 06: useWalkChannel flushes inserts every
// 10 points or 60 s, whichever first, plus on end). Pure and injectable —
// unit-tested with fake timers; phase 08 puts the IndexedDB outbox in
// front of `flush`.
import type { GeoPoint } from "./geo";

export interface GpsBatcherOptions {
  maxPoints?: number;
  maxIntervalMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class GpsBatcher {
  private buffer: GeoPoint[] = [];
  private timer: unknown = null;
  private inFlightFlushes: Promise<void>[] = [];
  private readonly flushFn: (points: GeoPoint[]) => void | Promise<void>;
  private readonly maxPoints: number;
  private readonly maxIntervalMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    flushFn: (points: GeoPoint[]) => void | Promise<void>,
    options: GpsBatcherOptions = {},
  ) {
    this.flushFn = flushFn;
    this.maxPoints = options.maxPoints ?? 10;
    this.maxIntervalMs = options.maxIntervalMs ?? 60_000;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as number));
  }

  get pending(): number {
    return this.buffer.length;
  }

  add(point: GeoPoint): void {
    this.buffer.push(point);
    if (this.buffer.length >= this.maxPoints) {
      void this.flush();
      return;
    }
    if (this.timer === null) {
      this.timer = this.setTimer(() => {
        this.timer = null;
        void this.flush();
      }, this.maxIntervalMs);
    }
  }

  /** Flush whatever is buffered and await all outstanding flush work. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.buffer.length > 0) {
      const batch = this.buffer;
      this.buffer = [];
      let pending: Promise<void>;
      try {
        pending = Promise.resolve(this.flushFn(batch));
      } catch (err) {
        pending = Promise.reject(err);
      }
      this.inFlightFlushes.push(pending);
      pending.then(
        () => {
          this.inFlightFlushes = this.inFlightFlushes.filter((p) => p !== pending);
        },
        () => {
          this.inFlightFlushes = this.inFlightFlushes.filter((p) => p !== pending);
        },
      );
    }
    if (this.inFlightFlushes.length > 0) {
      await Promise.all(this.inFlightFlushes);
    }
  }

  /** End of walk: flush the remainder and stop the interval timer. */
  async end(): Promise<void> {
    await this.flush();
  }
}
