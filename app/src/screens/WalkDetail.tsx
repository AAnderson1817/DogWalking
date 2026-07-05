// Portal WalkDetail (phase 07): live map + pulse header while in_progress
// (useWalkChannel subscribe); full ReportCard once completed (signed photo
// URLs, route, notes, flags).
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Badge } from "@/components/Badge";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { MapView } from "@/components/MapView";
import { ReportCard } from "@/components/ReportCard";
import { Spinner } from "@/components/Spinner";
import {
  getWalk,
  listWalkGpsPoints,
  listWalkPets,
  listWalkPhotos,
  signedPhotoUrl,
} from "@/lib/api";
import { useWalkChannel } from "@/hooks/useWalkChannel";
import { walkTime } from "@/lib/format";
import type { Pets, Walks } from "@/lib/types";

export default function WalkDetail() {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;
  return <WalkDetailInner walkId={id} />;
}

function WalkDetailInner({ walkId }: { walkId: string }) {
  const [walk, setWalk] = useState<Walks | null>(null);
  const [pets, setPets] = useState<Pets[]>([]);
  const [photoUrls, setPhotoUrls] = useState<string[]>([]);
  const [storedPoints, setStoredPoints] = useState<Array<{ lat: number; lng: number }>>([]);
  const [error, setError] = useState<string | null>(null);

  const channel = useWalkChannel(walkId, "subscribe");
  const live = walk?.status === "in_progress" && !channel.ended;

  useEffect(() => {
    async function load() {
      try {
        const w = await getWalk(walkId);
        setWalk(w);
        setPets(await listWalkPets(walkId));
        const points = await listWalkGpsPoints(walkId);
        setStoredPoints(points.map((p) => ({ lat: p.lat, lng: p.lng })));
        if (w.status === "completed") {
          const photos = await listWalkPhotos(walkId);
          const urls = await Promise.all(
            photos.map((p) => signedPhotoUrl(p.storage_path).catch(() => "")),
          );
          setPhotoUrls(urls.filter(Boolean));
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "walk not found");
      }
    }
    void load();
  }, [walkId, channel.ended]);

  const mapPoints = useMemo(
    () => [...storedPoints, ...channel.livePoints.map((p) => ({ lat: p.lat, lng: p.lng }))],
    [storedPoints, channel.livePoints],
  );

  if (error) {
    return (
      <div className="page">
        <Card><EmptyState title="Walk not found" hint={error} /></Card>
      </div>
    );
  }
  if (!walk) {
    return (
      <div className="page" style={{ display: "grid", placeItems: "center" }}>
        <Spinner />
      </div>
    );
  }

  const names = pets.map((p) => p.name);

  return (
    <div className="page">
      {live && (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-2)", marginBottom: "var(--s-2)" }}>
          <span className="pulse-live" aria-hidden />
          <span style={{ fontWeight: 700, color: "var(--teal-dim)" }}>Live — on the trail now</span>
        </div>
      )}
      <span className="section-label">
        {walkTime(walk.scheduled_date, walk.window_start, walk.window_end)}
      </span>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1>{names.join(" & ") || "Walk"}</h1>
        <Badge status={walk.status} />
      </div>

      {walk.status === "in_progress" ? (
        <div style={{ marginTop: "var(--s-4)" }}>
          <MapView points={mapPoints} live />
          <p style={{ color: "var(--text-2)", fontSize: "var(--fs-14)", marginTop: "var(--s-2)" }}>
            The route updates as your walker moves. The full report card
            arrives when the walk ends.
          </p>
        </div>
      ) : walk.status === "completed" ? (
        <div style={{ marginTop: "var(--s-4)" }}>
          <ReportCard
            report={{
              photoUrls,
              routePoints: mapPoints,
              distanceM: walk.distance_m,
              pottyPee: walk.potty_pee,
              pottyPoo: walk.potty_poo,
              fed: walk.fed,
              watered: walk.watered,
              notes: walk.notes,
              petNames: names,
            }}
          />
        </div>
      ) : (
        <Card style={{ marginTop: "var(--s-4)" }}>
          <EmptyState
            title={walk.status === "scheduled" ? "Booked and waiting" : `Walk ${walk.status}`}
            hint={walk.status === "scheduled" ? "Live tracking appears here once the walk starts." : undefined}
          />
        </Card>
      )}
    </div>
  );
}
