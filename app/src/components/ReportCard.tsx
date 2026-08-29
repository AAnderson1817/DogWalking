// Walk report card (spec 05): photo grid, route map, potty/fed facts, notes.
import { Card } from "./Card";
import { MapView, type MapPoint } from "./MapView";
import { distanceMi, money } from "@/lib/format";
import { ApprovedIcon } from "./ApprovedIcon";

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
  /**
   * Review H12. What this walk cost, when it was not covered by credits.
   *
   * The charge is off-session — it happens at completion, with nobody
   * present — so the report card is the first place the client sees the walk
   * at all. Leaving the amount off it meant the only record was a line in
   * billing history they had no reason to open and a figure on their card
   * statement. Null for a credit-funded walk, which is most of them.
   */
  overageCents?: number | null;
}

function Fact({ label, value }: { label: string; value: boolean | null }) {
  if (value === null) return null;
  return (
    <span className={`report-fact${value ? " report-fact--yes" : ""}`}>
      {value ? <ApprovedIcon name="check" size={14} /> : <span aria-hidden>—</span>} {label}
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

      {report.overageCents != null && report.overageCents > 0 && (
        <p className="report-card__charge">
          Not covered by your credits — <strong>{money(report.overageCents)}</strong> was
          charged to the card on file.
        </p>
      )}

      <div className="report-card__facts">
        <span className="report-fact numeral" style={{ fontWeight: 600, color: "var(--text)" }}>
          {distanceMi(report.distanceM)}
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
