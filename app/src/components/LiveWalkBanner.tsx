// Inline Current Moment: one explicit live state, route cue, elapsed time,
// and truthful action without duplicating the schedule row.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApprovedIcon } from "./ApprovedIcon";
import { elapsed } from "@/lib/format";

export function LiveWalkBanner({
  walkId,
  startedAt,
  label,
}: {
  walkId: string;
  startedAt: string;
  label: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    // The elapsed time is deliberately NOT in the link's accessible name: a
    // 1 s interval re-renders this, so the name changed every second while
    // the link was focused. The name is now stable, and the clock is exposed
    // separately as a non-interrupting timer.
    <Link
      to={`/walks/${walkId}/live`}
      className="live-banner-link"
      aria-label={`Current walk: ${label}. Open walk.`}
    >
      <div className="live-banner">
        <ApprovedIcon name="route" className="live-banner__route-icon" />
        <span className="live-banner__state">CURRENT</span>
        <span className="live-banner__label">{label}</span>
        <span className="live-banner__action">Open walk</span>
        <span
          className="live-banner__timer numeral"
          role="timer"
          aria-live="off"
          aria-label={`Elapsed ${elapsed(startedAt, now)}`}
        >
          {elapsed(startedAt, now)}
        </span>
      </div>
    </Link>
  );
}
