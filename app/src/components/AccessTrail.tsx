// The client's read-only view of who touched their door (review H3).
//
// The audit trail was operator-only, which is what made it unable to answer the
// question it exists for. In the scenario the product implicitly promises to
// handle — a client is burgled and the walker is a suspect — a log only the
// suspect can read exonerates nobody. And when a client asked "who changed my
// garage code on the 14th", nothing in the product could tell them.
//
// Deliberately shows no IP or user agent. Those describe the operator's device;
// a client does not need their walker's IP address to know their door was
// opened, and putting it on screen would make the trail feel like surveillance
// of the walker rather than a record for the homeowner.
import { dateTimeLocal } from "@/lib/format";
import type { CredentialLogRow } from "@/lib/api";
import { accessActionLabel, accessActionTone } from "./access-trail-treatment";
import { EmptyState } from "./EmptyState";

export function AccessTrail({ rows }: { rows: CredentialLogRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No access yet"
        hint="When your walker views or changes an entry code, it appears here."
      />
    );
  }
  return (
    <ul className="access-trail" aria-label="Entry code activity">
      {rows.map((row) => {
        const tone = accessActionTone(row.action);
        return (
          <li key={row.id} className={`access-trail__row access-trail__row--${tone}`}>
            <div className="access-trail__head">
              <span className="access-trail__action">{accessActionLabel(row.action)}</span>
              <time className="access-trail__when numeral" dateTime={row.accessed_at}>
                {dateTimeLocal(row.accessed_at)}
              </time>
            </div>
            {row.purpose && <span className="access-trail__purpose">{row.purpose}</span>}
          </li>
        );
      })}
    </ul>
  );
}
