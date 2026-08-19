// Realtime walk channel (spec 06). Channel `walk:{id}`:
// - broadcast mode (operator/Walk Mode): sendPoint() broadcasts each gps
//   event and batches DB inserts via GpsBatcher (10 points / 60 s /
//   whichever first, plus on end — batching tested in lib/gps-batcher).
// - subscribe mode (portal): yields the live point stream + ended signal.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { insertGpsPoints } from "@/lib/api";
import { GpsBatcher } from "@/lib/gps-batcher";
import { GpsOutbox, makeIdbOutboxStore, type OutboxBatch } from "@/lib/gps-outbox";
import type { GeoPoint } from "@/lib/geo";

function sendBatch(batch: OutboxBatch): Promise<void> {
  return insertGpsPoints(
    batch.points.map((p) => ({
      walk_id: batch.walkId,
      operator_id: batch.operatorId,
      recorded_at: new Date(p.t).toISOString(),
      lat: p.lat,
      lng: p.lng,
      accuracy_m: p.acc ?? null,
      // Carried, not derived (0027). Only the device that watched the fixes
      // arrive knows the watch had stopped; the stored timestamps cannot tell
      // a suspension apart from an operator standing still, because the emit
      // throttle needs ≥10 m as well as ≥5 s.
      gap_before: p.gapBefore ?? false,
    })),
  );
}

/**
 * Whether the Realtime join succeeded (review M10).
 *
 * `channel.subscribe()` took no status callback, so a failed join was MUTE.
 * That matters more since 0020 made the topic private and authorization real:
 * a rejected join now looks exactly like a walk where nothing has happened
 * yet. The operator's screen says it is broadcasting and the client's portal
 * shows a map that will never move, and neither is told.
 */
export type ChannelState = "joining" | "live" | "error";

/**
 * supabase-js reports `SUBSCRIBED`, `CHANNEL_ERROR`, `TIMED_OUT` or `CLOSED`.
 * Pure so the mapping is testable without a socket — and so "anything I do not
 * recognise is an error" is a stated rule rather than an accident. Reading an
 * unknown status as healthy is the direction that makes this defect come back.
 */
export function channelState(status: string): ChannelState {
  if (status === "SUBSCRIBED") return "live";
  if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") return "error";
  return "joining";
}

/** What the outbox is holding for this walk, for the screen to say out loud. */
export interface OutboxStatus {
  /** Batches still waiting to be sent. */
  pending: number;
  /** Points the server refused often enough that we stopped trying. */
  lostPoints: number;
}

export interface WalkChannelBroadcast {
  mode: "broadcast";
  /** Broadcast a point to live subscribers and enqueue its DB insert. */
  sendPoint: (point: GeoPoint) => void;
  /** Flush remaining queued inserts (awaiting a drain so the final batch
   * isn't stranded) + announce the walk ended. */
  end: () => Promise<void>;
  /** Points for this walk still queued in the outbox (for resume seeding). */
  pendingPoints: () => Promise<GeoPoint[]>;
  /**
   * Live outbox depth and lost-point count (review M7). Before this the
   * banner was driven purely by `navigator.onLine`, so a walk whose batches
   * were piling up — or being given up on — looked identical to one syncing
   * perfectly.
   */
  outboxStatus: OutboxStatus;
  /** Whether the live stream is actually connected (review M10). */
  status: ChannelState;
}

export interface WalkChannelSubscribe {
  mode: "subscribe";
  /** Live points received since mount. */
  livePoints: GeoPoint[];
  ended: boolean;
  /** Whether the live stream is actually connected (review M10). */
  status: ChannelState;
}

export function useWalkChannel(walkId: string, mode: "broadcast", operatorId: string): WalkChannelBroadcast;
export function useWalkChannel(walkId: string, mode: "subscribe"): WalkChannelSubscribe;
export function useWalkChannel(
  walkId: string,
  mode: "broadcast" | "subscribe",
  operatorId?: string,
): WalkChannelBroadcast | WalkChannelSubscribe {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const [livePoints, setLivePoints] = useState<GeoPoint[]>([]);
  const [ended, setEnded] = useState(false);
  const [outboxStatus, setOutboxStatus] = useState<OutboxStatus>({ pending: 0, lostPoints: 0 });
  const [status, setStatus] = useState<ChannelState>("joining");

  // Phase 08: flushes land in a durable IndexedDB outbox that drains with
  // backoff and backfills after reloads/reconnects.
  // `operatorId` arrives asynchronously (role resolution), and the outbox
  // deliberately does not rebuild when it does — a rebuilt outbox drops its
  // backoff timer. So ownership is read through a ref at drain time.
  const ownerRef = useRef<string>(operatorId ?? "");
  ownerRef.current = operatorId ?? "";

  const outbox = useMemo(
    () =>
      mode === "broadcast"
        ? new GpsOutbox(makeIdbOutboxStore(), sendBatch, {
            owner: () => ownerRef.current || null,
          })
        : null,
    [mode],
  );

  const batcher = useMemo(
    () =>
      // Return the enqueue promise so batcher.flush()/end() genuinely await
      // IndexedDB persistence — a voided call lets end() race the final batch.
      new GpsBatcher((points) => outbox?.enqueue(walkId, operatorId ?? "", points)),
    [walkId, operatorId, outbox],
  );

  useEffect(() => {
    if (!outbox) return;
    void outbox.drain(); // backfill anything left from a previous session
    const onUp = () => void outbox.drain();
    window.addEventListener("online", onUp);
    return () => {
      window.removeEventListener("online", onUp);
      outbox.dispose();
    };
  }, [outbox]);

  // Poll the outbox rather than have it push: a drain can also be triggered by
  // its own backoff timer, by the `online` event, or by another tab, so a
  // callback on enqueue would miss most of the transitions worth showing.
  useEffect(() => {
    if (!outbox) return;
    let live = true;
    const read = async () => {
      const [pending, dead] = await Promise.all([outbox.pending(), outbox.deadFor(walkId)]);
      if (!live) return;
      setOutboxStatus({
        pending,
        lostPoints: dead.reduce((n, b) => n + b.points.length, 0),
      });
    };
    void read();
    const t = setInterval(() => void read(), 5_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [outbox, walkId]);

  useEffect(() => {
    // `private: true` is what makes Supabase apply authorization at all —
    // without it the topic is public and any holder of the anon key (which is
    // compiled into this bundle) can join it from any origin, read the live
    // position of a named person at a named address, and inject or terminate
    // the stream. The rules live in realtime.messages policies (migration
    // 0020): the walk's operator may send and receive, its client may receive.
    // supabase-js attaches the session JWT to the socket itself, so there is
    // no setAuth() call to keep in sync here.
    const channel = supabase.channel(`walk:${walkId}`, { config: { private: true } });
    if (mode === "subscribe") {
      channel
        .on("broadcast", { event: "gps" }, ({ payload }) => {
          const p = payload as GeoPoint;
          setLivePoints((prev) => [...prev, p]);
        })
        .on("broadcast", { event: "ended" }, () => setEnded(true));
    }
    channel.subscribe((joinStatus) => setStatus(channelState(joinStatus)));
    channelRef.current = channel;
    return () => {
      if (mode === "broadcast") void batcher.end();
      void supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [walkId, mode, batcher]);

  const sendPoint = useCallback(
    (point: GeoPoint) => {
      void channelRef.current?.send({ type: "broadcast", event: "gps", payload: point });
      batcher.add(point);
    },
    [batcher],
  );

  const end = useCallback(async () => {
    // Flush the in-memory batch into the durable outbox first; flush() awaits
    // the outbox enqueue so the immediate drain cannot race ahead of
    // IndexedDB persistence.
    await batcher.end();
    await outbox?.drain();
    await channelRef.current?.send({ type: "broadcast", event: "ended", payload: { walkId } });
  }, [batcher, outbox, walkId]);

  const pendingPoints = useCallback(
    () => outbox?.pendingFor(walkId) ?? Promise.resolve([]),
    [outbox, walkId],
  );

  if (mode === "broadcast") {
    return { mode, sendPoint, end, pendingPoints, outboxStatus, status };
  }
  return { mode, livePoints, ended, status };
}
