// Portal WalkDetail (phase 07): live map + pulse header while in_progress
// (useWalkChannel subscribe); full ReportCard once completed (signed photo
// URLs, route, notes, flags).
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Badge } from "@/components/Badge";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { LoadError, loadErrorMessage } from "@/components/LoadError";
import { MapView } from "@/components/MapView";
import { ReportCard } from "@/components/ReportCard";
import { LoadingState } from "@/components/StateField";
import { walkStatusTreatment } from "@/components/status-treatment";
import {
  getWalk,
  getWalkOverageCents,
  listWalkGpsPoints,
  listWalkPets,
  listWalkPhotos,
  signedPhotoUrl,
} from "@/lib/api";
import { useWalkChannel } from "@/hooks/useWalkChannel";
import { walkTime } from "@/lib/format";
import type { Pets, Walks } from "@/lib/types";
import { useDocumentTitle } from "@/lib/use-document-title";

export default function WalkDetail() {
  useDocumentTitle("Walk report");
  const { id } = useParams<{ id: string }>();
  if (!id) return null;
  return <WalkDetailInner walkId={id} />;
}

function WalkDetailInner({ walkId }: { walkId: string }) {
  const [walk, setWalk] = useState<Walks | null>(null);
  const [pets, setPets] = useState<Pets[]>([]);
  const [photoUrls, setPhotoUrls] = useState<string[]>([]);
  const [storedPoints, setStoredPoints] = useState<Array<{ lat: number; lng: number }>>([]);
  // Review H12: what this walk cost, if credits did not cover it.
  const [overageCents, setOverageCents] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const channel = useWalkChannel(walkId, "subscribe");
  const live = walk?.status === "in_progress" && !channel.ended;

  const load = useCallback(async () => {
    setError(null);
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
        // Best-effort: a missing charge lookup must not blank the report card
        // the client came here to read.
        setOverageCents(await getWalkOverageCents(walkId).catch(() => null));
      }
    } catch (loadError) {
      setError(loadErrorMessage(loadError));
    }
  }, [walkId]);

  useEffect(() => {
    void load();
  }, [load, channel.ended]);

  const mapPoints = useMemo(
    () => [...storedPoints, ...channel.livePoints.map((p) => ({ lat: p.lat, lng: p.lng }))],
    [storedPoints, channel.livePoints],
  );

  if (error) {
    return <LoadError title="Couldn't load walk details" message={error} onRetry={load} />;
  }
  if (!walk) {
    return (
      <div className="page">
        <LoadingState label="Loading walk details" />
      </div>
    );
  }

  const names = pets.map((p) => p.name);
  const treatment = walkStatusTreatment(walk.status, walk.is_overage);

  return (
    <div className="page">
      {/* Review M10. `subscribe()` took no status callback, so a rejected
          join was silent — and since 0020 made the topic private and
          authorization real, a rejection looks exactly like a walk where
          nothing has happened yet: a map that will never move, with the word
          "Live" above it. The stored route is unaffected, so the copy says
          what to do rather than implying the walk has gone wrong. */}
      {live && channel.status === "error" ? (
        <div className="walk-live-state walk-live-state--offline" style={{ marginBottom: "var(--s-2)" }}>
          <span className="walk-live-state__label walk-live-state__label--offline">LIVE UNAVAILABLE</span>
          <span className="walk-live-state__pet">The walk is under way</span>
          <span className="walk-live-state__detail">
            We can't show it moving right now. Refresh to see the route so far.
          </span>
        </div>
      ) : live && (
        <div className="walk-live-state" style={{ marginBottom: "var(--s-2)" }}>
          <span className="walk-live-state__label">CURRENT</span>
          <span className="walk-live-state__pet">Live — on the trail now</span>
        </div>
      )}
      <span className="section-label">
        {walkTime(walk.scheduled_date, walk.window_start, walk.window_end)}
      </span>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1>{names.join(" & ") || "Walk"}</h1>
        <Badge status={treatment.badge}>{treatment.label}</Badge>
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
              overageCents,
            }}
          />
        </div>
      ) : (
        <Card style={{ marginTop: "var(--s-4)" }}>
          <EmptyState
            title={walk.status === "scheduled" ? "Booked and waiting" : `Walk ${treatment.label.toLowerCase()}`}
            hint={walk.status === "scheduled" ? "Live tracking appears here once the walk starts." : undefined}
          />
        </Card>
      )}
    </div>
  );
}
