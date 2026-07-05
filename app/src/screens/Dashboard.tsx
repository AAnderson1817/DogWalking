// Operator Dashboard (phase 05): today's walks in time order, live banner,
// low-credit strip, failed payments strip, unread notification count.
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Badge } from "@/components/Badge";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { LiveWalkBanner } from "@/components/LiveWalkBanner";
import { Spinner } from "@/components/Spinner";
import { WalkCard } from "@/components/WalkCard";
import {
  getMyOperator,
  listClients,
  listNotifications,
  listPayments,
  listWalksDetailed,
  walkPetNames,
  type WalkDetailed,
} from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { dateLondon, gbp } from "@/lib/format";
import {
  failedPayments,
  liveWalk,
  lowCreditClients,
  todayLondon,
  todaysWalks,
  unreadCount,
} from "@/lib/selectors";
import type { Clients, Operators, Payments } from "@/lib/types";

export default function Dashboard() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [operator, setOperator] = useState<Operators | null>(null);
  const [walks, setWalks] = useState<WalkDetailed[] | null>(null);
  const [clients, setClients] = useState<Clients[]>([]);
  const [payments, setPayments] = useState<Payments[]>([]);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const today = todayLondon();
        const [op, todayWalks, allClients, pays, notifs] = await Promise.all([
          getMyOperator(),
          listWalksDetailed({ date: today }),
          listClients(),
          listPayments(),
          listNotifications(true),
        ]);
        if (cancelled) return;
        setOperator(op);
        setWalks(todayWalks);
        setClients(allClients);
        setPayments(pays);
        setUnread(unreadCount(notifs));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "failed to load");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="page">
        <h1>Today</h1>
        <Card style={{ marginTop: "var(--s-4)" }}>
          <EmptyState title="Couldn't load the dashboard" hint={error} />
        </Card>
      </div>
    );
  }
  if (walks === null) {
    return (
      <div className="page" style={{ display: "grid", placeItems: "center" }}>
        <Spinner />
      </div>
    );
  }

  const today = todayLondon();
  const ordered = todaysWalks(walks, today);
  const live = liveWalk(walks) as WalkDetailed | null;
  const low = lowCreditClients(clients, operator?.low_credit_threshold ?? 2) as Clients[];
  const failed = failedPayments(payments).slice(0, 5) as Payments[];
  const clientName = (id: string) => clients.find((c) => c.id === id)?.full_name ?? "";

  return (
    <div className="page" style={live ? { paddingTop: 72 } : undefined}>
      {live && (
        <LiveWalkBanner
          walkId={live.id}
          startedAt={live.started_at!}
          label={`Walking ${walkPetNames(live).join(" & ") || "now"}`}
        />
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <span className="section-label">{dateLondon(new Date())}</span>
          <h1>Today</h1>
        </div>
        <span
          className="badge badge--neutral"
          aria-label={`${unread} unread notifications`}
          title="Unread notifications"
        >
          🔔 {unread}
        </span>
      </div>

      <section style={{ marginTop: "var(--s-4)", display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
        {ordered.length === 0 ? (
          <Card>
            <EmptyState title="No walks today" hint="Scheduled walks appear here in route order." />
          </Card>
        ) : (
          ordered.map((w) => (
            <WalkCard
              key={w.id}
              walk={{
                windowStart: w.window_start,
                windowEnd: w.window_end,
                petNames: walkPetNames(w),
                propertyLabel: w.property?.label ?? "",
                status: w.status,
                isOverage: w.is_overage,
                clientName: w.client?.full_name,
              }}
              onClick={() => navigate(`/walks/${w.id}/live`)}
            />
          ))
        )}
      </section>

      {low.length > 0 && (
        <section style={{ marginTop: "var(--s-6)" }}>
          <span className="section-label">Low credits</span>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)", marginTop: "var(--s-2)" }}>
            {low.map((c) => (
              <Link key={c.id} to={`/clients/${c.id}`} style={{ textDecoration: "none" }}>
                <Card style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 600 }}>{c.full_name}</span>
                  <span
                    className="numeral"
                    style={{ color: "var(--warn)", fontWeight: 700, fontSize: "var(--fs-20)" }}
                  >
                    {c.credit_balance}
                  </span>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      )}

      {failed.length > 0 && (
        <section style={{ marginTop: "var(--s-6)" }}>
          <span className="section-label">Failed payments</span>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)", marginTop: "var(--s-2)" }}>
            {failed.map((p) => (
              <Card
                key={p.id}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
              >
                <div>
                  <span style={{ fontWeight: 600 }}>{clientName(p.client_id)}</span>
                  <span style={{ color: "var(--text-2)", marginLeft: "var(--s-2)", fontSize: "var(--fs-14)" }}>
                    {p.type} · {dateLondon(p.created_at)}
                  </span>
                </div>
                <div style={{ display: "flex", gap: "var(--s-2)", alignItems: "center" }}>
                  <span className="numeral" style={{ fontWeight: 600 }}>{gbp(p.amount_pence)}</span>
                  <Badge status="warn">failed</Badge>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}

      <p style={{ marginTop: "var(--s-8)", color: "var(--text-2)", fontSize: "var(--fs-14)" }}>
        Signed in as {operator?.display_name ?? auth.session?.user.email}.{" "}
        <button
          style={{
            background: "none",
            border: 0,
            color: "var(--pine-600)",
            padding: 0,
            font: "inherit",
            textDecoration: "underline",
            cursor: "pointer",
          }}
          onClick={() => void auth.signOut()}
        >
          Sign out
        </button>
      </p>
    </div>
  );
}
