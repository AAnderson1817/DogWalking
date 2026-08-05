import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import todayBackground from "@/assets/illustrations/sanpo-today-indigo-emaki-background-approved-v1.png";
import { Badge } from "@/components/Badge";
import { Card } from "@/components/Card";
import { LoadError, loadErrorMessage } from "@/components/LoadError";
import { NotificationBell } from "@/components/NotificationInbox";
import { LoadingState } from "@/components/StateField";
import {
  TodayCurrentAction,
  TodayIllustratedSchedule,
  type TodayIllustratedVisit,
  type TodayVisitState,
} from "@/components/TodayIllustratedSchedule";
import {
  getMyOperator,
  listClients,
  listPayments,
  listWalksDetailed,
  walkPetNames,
  type WalkDetailed,
} from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { dateLocal, money, time12 } from "@/lib/format";
import {
  failedPayments,
  liveWalk,
  lowCreditClients,
  todayLocal,
  todaysWalks,
} from "@/lib/selectors";
import type { Clients, Operators, Payments } from "@/lib/types";

const DISPLAY_TZ = "America/Chicago";

function todayDateLabel(at: Date = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: DISPLAY_TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(at);
}

function visitState(status: WalkDetailed["status"]): TodayVisitState {
  if (status === "completed") return "completed";
  if (status === "in_progress") return "current";
  if (status === "cancelled") return "cancelled";
  if (status === "no_show") return "no_show";
  return "upcoming";
}

function shortTime(value: string) {
  return time12(value).replace(/\s[AP]M$/, "");
}

function elapsedMinutes(startedAt: string | null) {
  if (!startedAt) return undefined;
  return `${Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 60_000))} min`;
}

export default function Dashboard() {
  const auth = useAuth();
  const [operator, setOperator] = useState<Operators | null>(null);
  const [walks, setWalks] = useState<WalkDetailed[] | null>(null);
  const [clients, setClients] = useState<Clients[]>([]);
  const [payments, setPayments] = useState<Payments[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const today = todayLocal();
    try {
      const [op, todayWalks, allClients, pays] = await Promise.all([
        getMyOperator(),
        listWalksDetailed({ date: today }),
        listClients(),
        listPayments(),
      ]);
      setOperator(op);
      setWalks(todayWalks);
      setClients(allClients);
      setPayments(pays);
    } catch (caught) {
      setError(loadErrorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return <LoadError title="Couldn't load Today" message={error} onRetry={load} />;
  }
  if (walks === null) {
    return (
      <div className="page">
        <LoadingState label="Loading today's schedule" />
      </div>
    );
  }

  const ordered = todaysWalks(walks, todayLocal());
  const live = liveWalk(walks) as WalkDetailed | null;
  const low = lowCreditClients(clients, operator?.low_credit_threshold ?? 2) as Clients[];
  const failed = failedPayments(payments).slice(0, 5) as Payments[];
  const clientName = (id: string) => clients.find((client) => client.id === id)?.full_name ?? "";
  const completedDistance = ordered.reduce((total, walk) => total + (walk.distance_m ?? 0), 0);
  const distanceLabel = completedDistance > 0 ? `${(completedDistance / 1609.344).toFixed(1)} mi` : undefined;
  const currentIndex = live ? ordered.findIndex((walk) => walk.id === live.id) : -1;
  const next = ordered.slice(currentIndex + 1).find((walk) => walk.status === "scheduled");

  const visits: TodayIllustratedVisit[] = ordered.map((walk) => ({
    id: walk.id,
    time: shortTime(walk.window_start),
    petName: walkPetNames(walk).join(" & ") || "Pet",
    route: walk.property?.label || "Route not set",
    duration: walk.status === "in_progress" ? elapsedMinutes(walk.started_at) : undefined,
    state: visitState(walk.status),
  }));

  const paceLabel = live?.is_overage ? "Over time" : live ? "On time" : "Schedule ready";
  const nextVisitLabel = live && next
    ? `${walkPetNames(next).join(" & ") || "Next visit"} at ${time12(next.window_start)} after this walk`
    : next
      ? `Next: ${walkPetNames(next).join(" & ") || "visit"} at ${time12(next.window_start)}`
      : ordered.length > 0
        ? "Today's route is complete"
        : "Your day is clear";

  return (
    <div className="page today-emaki-page">
      <TodayIllustratedSchedule
        backgroundSrc={todayBackground}
        dateLabel={todayDateLabel()}
        visits={visits}
        distanceLabel={distanceLabel}
        paceLabel={paceLabel}
        nextVisitLabel={nextVisitLabel}
        inbox={<NotificationBell persona="operator" />}
        currentAction={live ? <TodayCurrentAction walkId={live.id} /> : undefined}
      />

      {(low.length > 0 || failed.length > 0) && (
        <aside className="today-emaki-followups" aria-label="Items needing attention">
          {low.length > 0 && (
            <section>
              <span className="section-label">Low credits</span>
              <div className="today-emaki-followups__list">
                {low.map((client) => (
                  <Link key={client.id} to={`/clients/${client.id}`} className="today-emaki-followups__link">
                    <Card className="today-emaki-followups__item">
                      <span>{client.full_name}</span>
                      <span className="numeral">{client.credit_balance}</span>
                    </Card>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {failed.length > 0 && (
            <section>
              <span className="section-label">Failed payments</span>
              <div className="today-emaki-followups__list">
                {failed.map((payment) => (
                  <Card key={payment.id} className="today-emaki-followups__item">
                    <span>{clientName(payment.client_id)} · {dateLocal(payment.created_at)}</span>
                    <span className="today-emaki-followups__value">
                      <span className="numeral">{money(payment.amount_pence)}</span>
                      <Badge status="attention">Needs attention</Badge>
                    </span>
                  </Card>
                ))}
              </div>
            </section>
          )}
        </aside>
      )}

      <p className="today-emaki-account">
        Signed in as {operator?.display_name ?? auth.session?.user.email}.{" "}
        <button className="text-button" onClick={() => void auth.signOut()}>Sign out</button>
      </p>
    </div>
  );
}
