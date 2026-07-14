// Fixed-top live walk banner (spec 05): pulse-live dot + elapsed timer.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
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
    <Link to={`/walks/${walkId}/live`} style={{ textDecoration: "none" }}>
      <div className="live-banner">
        <span className="pulse-live" aria-hidden />
        <span style={{ fontWeight: 800 }}>{label}</span>
        <span className="live-banner__timer numeral">{elapsed(startedAt, now)}</span>
      </div>
    </Link>
  );
}
