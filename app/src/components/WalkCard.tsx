// Compact schedule row: explicit sequence state, time, pet, route, and
// duration. State is conveyed by text and placement first, CT-1 color second.
import type { ReactNode } from "react";
import { ApprovedIcon } from "./ApprovedIcon";
import { walkStatusTreatment } from "./status-treatment";
import { time12, timeRange12, walkDuration } from "@/lib/format";
import type { WalkStatus } from "@/lib/types";

export interface WalkCardData {
  windowStart: string;
  windowEnd: string;
  petNames: string[];
  propertyLabel: string;
  status: WalkStatus;
  isOverage?: boolean;
  clientName?: string;
}

function sequenceLabel(walk: WalkCardData): string {
  if (walk.isOverage) return "OVERAGE";
  switch (walk.status) {
    case "in_progress":
      return "CURRENT";
    case "scheduled":
      return "UP NEXT";
    case "completed":
      return "✓ DONE";
    case "cancelled":
      return "CANCELLED";
    case "no_show":
      return "NO-SHOW";
  }
}

export function WalkCard({ walk, onClick }: { walk: WalkCardData; onClick?: () => void }) {
  const treatment = walkStatusTreatment(walk.status, walk.isOverage);
  const petLabel = walk.petNames.join(" & ") || "Walk";
  const routeLabel = walk.propertyLabel || "Route not set";
  const duration = walkDuration(walk.windowStart, walk.windowEnd);
  const stateLabel = sequenceLabel(walk);
  const className = `walk-card walk-card--${treatment.badge}`;

  const content: ReactNode = (
    <>
      <div className="walk-card__when">
        <span className="walk-card__state">{stateLabel}</span>
        <span className="walk-card__time">
          {timeRange12(walk.windowStart, walk.windowEnd)}
        </span>
      </div>
      <div className="walk-card__main">
        <span className="walk-card__pets">{petLabel}</span>
        {walk.clientName && <span className="walk-card__client">{walk.clientName}</span>}
        <span className="walk-card__details">
          <ApprovedIcon name="route" size={20} />
          <span className="walk-card__route">{routeLabel}</span>
          <span aria-hidden>·</span>
          <span className="walk-card__duration">{duration}</span>
        </span>
      </div>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={className}
        onClick={onClick}
        aria-label={`${stateLabel}: ${petLabel}, ${time12(walk.windowStart)} to ${time12(walk.windowEnd)}, ${routeLabel}, ${duration}`}
      >
        {content}
      </button>
    );
  }

  return <div className={className}>{content}</div>;
}
