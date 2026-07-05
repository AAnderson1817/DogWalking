// Walk report card (spec 05): photo grid, route map, potty/fed facts, notes.
import { Card } from "./Card";
import { MapView, type MapPoint } from "./MapView";
import { distanceKm } from "@/lib/format";

export interface ReportCardData {
  photoUrls: string[];
  routePoints: MapPoint[];
  distanceM: number | null;
  pottyPee: boolean | null;
  pottyPoo: boolean | null;
  fed: boolean | null;
  watered: boolean | null;
  notes: string | null;
  petNames: string[];
}

function Fact({ label, value }: { label: string; value: boolean | null }) {
  if (value === null) return null;
  return (
    <span className={`report-fact${value ? " report-fact--yes" : ""}`}>
      <span aria-hidden>{value ? "✓" : "—"}</span> {label}
    </span>
  );
}

export function ReportCard({ report }: { report: ReportCardData }) {
  return (
    <Card className="report-card">
      <div>
        <span className="section-label">Report card</span>
        <h2 style={{ fontSize: "var(--fs-20)", marginTop: "var(--s-1)" }}>
          {report.petNames.join(" & ")}
        </h2>
      </div>

      {report.photoUrls.length > 0 && (
        <div className="report-card__photos">
          {report.photoUrls.map((url) => (
            <img key={url} className="report-card__photo" src={url} alt="Walk photo" />
          ))}
        </div>
      )}

      <MapView points={report.routePoints} />

      <div className="report-card__facts">
        <span className="report-fact numeral" style={{ fontWeight: 600, color: "var(--text)" }}>
          {distanceKm(report.distanceM)}
        </span>
        <Fact label="Pee" value={report.pottyPee} />
        <Fact label="Poo" value={report.pottyPoo} />
        <Fact label="Fed" value={report.fed} />
        <Fact label="Water" value={report.watered} />
      </div>

      {report.notes && <p style={{ color: "var(--text-2)" }}>{report.notes}</p>}
    </Card>
  );
}
