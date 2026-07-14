// PortalWalks (phase 07): the Walks tab — upcoming bookings and past
// report cards.
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { LoadError, loadErrorMessage } from "@/components/LoadError";
import { Spinner } from "@/components/Spinner";
import { WalkCard } from "@/components/WalkCard";
import { listWalksDetailed, walkPetNames, type WalkDetailed } from "@/lib/api";
import { todayLocal } from "@/lib/selectors";
import { walkTime } from "@/lib/format";

export default function PortalWalks() {
  const navigate = useNavigate();
  const [walks, setWalks] = useState<WalkDetailed[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setError(null);
    return listWalksDetailed({})
      .then(setWalks)
      .catch((e) => setError(loadErrorMessage(e)));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (error && walks === null) {
    return (
      <LoadError title="Couldn't load your walks" message={error} onRetry={reload} />
    );
  }
  if (walks === null) {
    return (
      <div className="page" style={{ display: "grid", placeItems: "center" }}>
        <Spinner />
      </div>
    );
  }

  const today = todayLocal();
  const upcoming = walks
    .filter((w) => (w.status === "scheduled" || w.status === "in_progress") && w.scheduled_date >= today)
    .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date) || a.window_start.localeCompare(b.window_start));
  const past = walks
    .filter((w) => w.status === "completed")
    .sort((a, b) => b.scheduled_date.localeCompare(a.scheduled_date));

  const renderList = (list: WalkDetailed[]) => (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)", marginTop: "var(--s-2)" }}>
      {list.map((w) => (
        <div key={w.id}>
          <span className="section-label">{walkTime(w.scheduled_date, w.window_start, w.window_end)}</span>
          <WalkCard
            walk={{
              windowStart: w.window_start,
              windowEnd: w.window_end,
              petNames: walkPetNames(w),
              propertyLabel: w.property?.label ?? "",
              status: w.status,
            }}
            onClick={() => navigate(`/portal/walks/${w.id}`)}
          />
        </div>
      ))}
    </div>
  );

  return (
    <div className="page">
      <h1>Walks</h1>

      <section style={{ marginTop: "var(--s-4)" }}>
        <span className="section-label">Upcoming</span>
        {upcoming.length === 0 ? (
          <Card style={{ marginTop: "var(--s-2)" }}><EmptyState title="Nothing booked" /></Card>
        ) : (
          renderList(upcoming)
        )}
      </section>

      <section style={{ marginTop: "var(--s-6)" }}>
        <span className="section-label">Report cards</span>
        {past.length === 0 ? (
          <Card style={{ marginTop: "var(--s-2)" }}><EmptyState title="No walks yet" /></Card>
        ) : (
          renderList(past)
        )}
      </section>
    </div>
  );
}
