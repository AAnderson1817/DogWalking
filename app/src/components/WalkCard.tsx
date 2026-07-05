// Walk summary card (spec 05): time window, pet avatars, property label,
// status badge (overage shown in place of completed when flagged).
import { Badge, type BadgeStatus } from "./Badge";
import { Card } from "./Card";

export interface WalkCardData {
  windowStart: string; // "12:00:00"
  windowEnd: string;
  petNames: string[];
  propertyLabel: string;
  status: BadgeStatus;
  isOverage?: boolean;
  clientName?: string;
}

function hhmm(t: string): string {
  return t.slice(0, 5);
}

export function WalkCard({ walk, onClick }: { walk: WalkCardData; onClick?: () => void }) {
  return (
    <Card
      className="walk-card"
      onClick={onClick}
      style={onClick ? { cursor: "pointer" } : undefined}
    >
      <div className="walk-card__top">
        <span className="walk-card__time">
          {hhmm(walk.windowStart)}–{hhmm(walk.windowEnd)}
        </span>
        <Badge status={walk.isOverage ? "overage" : walk.status} />
      </div>
      <div className="walk-card__meta">
        <span className="pet-avatars" aria-label={walk.petNames.join(", ")}>
          {walk.petNames.slice(0, 3).map((name) => (
            <span key={name} className="pet-avatar">
              {name.charAt(0).toUpperCase()}
            </span>
          ))}
        </span>
        <span>{walk.petNames.join(" · ")}</span>
        <span aria-hidden>•</span>
        <span>{walk.propertyLabel}</span>
        {walk.clientName && (
          <>
            <span aria-hidden>•</span>
            <span>{walk.clientName}</span>
          </>
        )}
      </div>
    </Card>
  );
}
