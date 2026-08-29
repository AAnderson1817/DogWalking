// Review H6: what the client can see about their own record, in the portal.
//
// The finding's sharpest point is the ORDER of collection: the operator enters
// the client, then the address, then the pets' medical notes, then the door
// code — all before the data subject has an account or has been told anything.
// By the time this panel is visible the collection has already happened, so it
// is not consent; it is the first honest account of what is held, and the two
// things the person can actually ask for.
import { Link } from "react-router-dom";
import { PRIVACY } from "@/lib/legal";
import { dateLocal } from "@/lib/format";

export function YourDataPanel({
  businessName,
  noticeAcceptedAt,
  noticeVersion,
  gpsRetentionDays,
}: {
  businessName: string | null;
  noticeAcceptedAt: string | null;
  noticeVersion: string | null;
  gpsRetentionDays: number | null;
}) {
  return (
    <section className="your-data" aria-labelledby="your-data-heading">
      <h2 id="your-data-heading" className="section-label">Your data</h2>
      <p className="your-data__detail">
        {businessName ?? "Your walker"} holds your contact details, your
        address and how to get in, your pets and their medical notes, a record
        of each visit including its route and photos, and your billing history.
      </p>
      <p className="your-data__detail">
        {gpsRetentionDays && gpsRetentionDays > 0
          ? `Route traces are deleted automatically after ${gpsRetentionDays} days. The visit and its billing record are kept.`
          : "Route traces are kept until your walker deletes them."}
      </p>
      <p className="your-data__detail">
        Ask {businessName ?? "your walker"} for a copy of everything held about
        you, or to erase it. They can do both from within Sanpo.
      </p>
      {noticeAcceptedAt && (
        <p className="your-data__meta">
          You accepted the privacy notice
          {noticeVersion ? ` (version ${noticeVersion})` : ""} on{" "}
          {dateLocal(noticeAcceptedAt)}.
        </p>
      )}
      <p className="your-data__meta">
        <Link to="/legal/privacy">
          Read the privacy notice
        </Link>
        {PRIVACY.version !== noticeVersion && noticeVersion
          ? " — it has been updated since you accepted it."
          : ""}
      </p>
    </section>
  );
}
