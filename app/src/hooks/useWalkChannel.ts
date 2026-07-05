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
    })),
  );
}

export interface WalkChannelBroadcast {
  mode: "broadcast";
  /** Broadcast a point to live subscribers and enqueue its DB insert. */
  sendPoint: (point: GeoPoint) => void;
  /** Flush remaining queued inserts + announce the walk ended. */
  end: () => Promise<void>;
}

export interface WalkChannelSubscribe {
  mode: "subscribe";
  /** Live points received since mount. */
  livePoints: GeoPoint[];
  ended: boolean;
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

  // Phase 08: flushes land in a durable IndexedDB outbox that drains with
  // backoff and backfills after reloads/reconnects.
  const outbox = useMemo(
    () => (mode === "broadcast" ? new GpsOutbox(makeIdbOutboxStore(), sendBatch) : null),
    [mode],
  );

  const batcher = useMemo(
    () =>
      new GpsBatcher((points) => {
        void outbox?.enqueue(walkId, operatorId ?? "", points);
      }),
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

  useEffect(() => {
    const channel = supabase.channel(`walk:${walkId}`);
    if (mode === "subscribe") {
      channel
        .on("broadcast", { event: "gps" }, ({ payload }) => {
          const p = payload as GeoPoint;
          setLivePoints((prev) => [...prev, p]);
        })
        .on("broadcast", { event: "ended" }, () => setEnded(true));
    }
    channel.subscribe();
    channelRef.current = channel;
    return () => {
      if (mode === "broadcast") batcher.end();
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
    batcher.end();
    await channelRef.current?.send({ type: "broadcast", event: "ended", payload: { walkId } });
  }, [batcher, walkId]);

  if (mode === "broadcast") {
    return { mode, sendPoint, end };
  }
  return { mode, livePoints, ended };
}
