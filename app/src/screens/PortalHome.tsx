// PortalHome (phase 07): next walk, credit meter, latest report cards,
// unread notifications with mark-read.
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Card } from "@/components/Card";
import { CreditMeter } from "@/components/CreditMeter";
import { EmptyState } from "@/components/EmptyState";
import { Spinner } from "@/components/Spinner";
import { WalkCard } from "@/components/WalkCard";
import {
  getMyClient,
  getMyOperatorView,
  getPlan,
  listNotifications,
  listWalksDetailed,
  markNotificationRead,
  walkPetNames,
  type MyOperatorView,
  type WalkDetailed,
} from "@/lib/api";
import { dateLondon } from "@/lib/format";
import { todayLondon } from "@/lib/selectors";
import type { Clients, Notifications, Plans } from "@/lib/types";

export default function PortalHome() {
  const navigate = useNavigate();
  const [client, setClient] = useState<Clients | null>(null);
  const [operator, setOperator] = useState<MyOperatorView | null>(null);
  const [plan, setPlan] = useState<Plans | null>(null);
  const [walks, setWalks] = useState<WalkDetailed[]>([]);
  const [notifications, setNotifications] = useState<Notifications[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const me = await getMyClient();
    if (!me) return;
    const [op, ws, ns, p] = await Promise.all([
      getMyOperatorView(),
      listWalksDetailed({}),
      listNotifications(true),
      me.plan_id ? getPlan(me.plan_id) : Promise.resolve(null),
    ]);
    setClient(me);
    setOperator(op);
    setWalks(ws);
    setNotifications(ns);
    setPlan(p);
  }, []);

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, [load]);

  if (loading || !client) {
    return (
      <div className="page" style={{ display: "grid", placeItems: "center" }}>
        <Spinner />
      </div>
    );
  }

  const today = todayLondon();
  const upcoming = walks
    .filter((w) => (w.status === "scheduled" || w.status === "in_progress") && w.scheduled_date >= today)
    .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date) || a.window_start.localeCompare(b.window_start));
  const next = upcoming[0];
  const reports = walks
    .filter((w) => w.status === "completed")
    .sort((a, b) => b.scheduled_date.localeCompare(a.scheduled_date))
    .slice(0, 3);

  return (
    <div className="page">
      <span className="section-label">{operator?.business_name ?? "Your walker"}</span>
      <h1>Hi, {client.full_name.split(" ")[0]}</h1>

      <section style={{ marginTop: "var(--s-4)" }}>
        <span className="section-label">Next walk</span>
        <div style={{ marginTop: "var(--s-2)" }}>
          {next ? (
            <>
              {next.status === "in_progress" && (
                <div style={{ display: "flex", alignItems: "center", gap: "var(--s-2)", marginBottom: "var(--s-2)" }}>
                  <span className="pulse-live" aria-hidden />
                  <span style={{ fontWeight: 600, color: "var(--teal-dim)" }}>Live now — tap to watch</span>
                </div>
              )}
              <div>
                <span className="section-label">{dateLondon(`${next.scheduled_date}T12:00:00Z`)}</span>
                <WalkCard
                  walk={{
                    windowStart: next.window_start,
                    windowEnd: next.window_end,
                    petNames: walkPetNames(next),
                    propertyLabel: next.property?.label ?? "",
                    status: next.status,
                  }}
                  onClick={() => navigate(`/portal/walks/${next.id}`)}
                />
              </div>
            </>
          ) : (
            <Card>
              <EmptyState
                title="Nothing booked"
                hint="Request a walk whenever you need one."
                action={<Link to="/portal/book" style={{ color: "var(--pine-600)", fontWeight: 600 }}>Book a walk</Link>}
              />
            </Card>
          )}
        </div>
      </section>

      <section style={{ marginTop: "var(--s-6)" }}>
        <Card>
          <CreditMeter
            balance={client.credit_balance}
            threshold={0}
            cycleCredits={plan?.credits_per_cycle}
            label={plan ? `${plan.name} credits` : "Credits"}
          />
        </Card>
      </section>

      {notifications.length > 0 && (
        <section style={{ marginTop: "var(--s-6)" }}>
          <span className="section-label">Updates</span>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)", marginTop: "var(--s-2)" }}>
            {notifications.slice(0, 5).map((n) => (
              <Card key={n.id} style={{ display: "flex", justifyContent: "space-between", gap: "var(--s-2)" }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: "var(--fs-14)" }}>{n.title}</div>
                  {n.body && <div style={{ color: "var(--text-2)", fontSize: "var(--fs-14)" }}>{n.body}</div>}
                </div>
                <button
                  onClick={() => void markNotificationRead(n.id).then(load)}
                  aria-label="Mark read"
                  style={{ background: "none", border: 0, color: "var(--pine-600)", cursor: "pointer", fontWeight: 700 }}
                >
                  ✓
                </button>
              </Card>
            ))}
          </div>
        </section>
      )}

      {reports.length > 0 && (
        <section style={{ marginTop: "var(--s-6)" }}>
          <span className="section-label">Latest report cards</span>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)", marginTop: "var(--s-2)" }}>
            {reports.map((w) => (
              <WalkCard
                key={w.id}
                walk={{
                  windowStart: w.window_start,
                  windowEnd: w.window_end,
                  petNames: walkPetNames(w),
                  propertyLabel: w.property?.label ?? "",
                  status: "completed",
                }}
                onClick={() => navigate(`/portal/walks/${w.id}`)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
