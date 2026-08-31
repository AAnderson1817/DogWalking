import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
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
  listAbandonedWalks,
  listAttentionPayments,
  listLowCreditClients,
  listWalksDetailed,
  walkPetNames,
  type AttentionPayment,
  type ClientRecord,
} from "@/lib/api";
import type { WalkDetailed } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { dateLocal, distanceMi, money, time12 } from "@/lib/format";
import { liveWalk, todayLocal, todaysWalks } from "@/lib/selectors";
import type { Operators } from "@/lib/types";
import { useDocumentTitle } from "@/lib/use-document-title";

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
  useDocumentTitle("Today");
  const auth = useAuth();
  const [operator, setOperator] = useState<Operators | null>(null);
  const [walks, setWalks] = useState<WalkDetailed[] | null>(null);
  const [stale, setStale] = useState<WalkDetailed[]>([]);
  const [lowCredit, setLowCredit] = useState<ClientRecord[]>([]);
  const [attention, setAttention] = useState<AttentionPayment[]>([]);
  const [error, setError] = useState<string | null>(null);

  // `background` refreshes never surface an error. A walker between visits is
  // regularly on no signal at all, and swapping a screen they are reading for
  // a retry prompt because one poll timed out is worse than showing data that
  // is a minute stale — the next tick, or their next action, recovers it.
  const load = useCallback(async ({ background = false } = {}) => {
    if (!background) setError(null);
    const today = todayLocal();
    try {
      // Review M9. This used to fetch EVERY client and EVERY payment to
      // render at most five rows of each. Past PostgREST's 1000-row cap that
      // was not merely wasteful: the payment list is ordered newest-first, so
      // truncation silently dropped the newest failures from the strip whose
      // whole job is to surface them. Both predicates are Postgres's now.
      //
      // The operator is fetched first because the low-credit threshold is a
      // query INPUT — it cannot be applied server-side without knowing it.
      const op = await getMyOperator(auth.session?.user.id);
      const [todayWalks, abandoned, low, attention] = await Promise.all([
        listWalksDetailed({ date: today }),
        listAbandonedWalks(),
        listLowCreditClients(op?.low_credit_threshold ?? 2),
        listAttentionPayments(5),
      ]);
      setOperator(op);
      setWalks(todayWalks);
      setStale(abandoned);
      setLowCredit(low);
      setAttention(attention);
      setError(null);
    } catch (caught) {
      if (!background) setError(loadErrorMessage(caught));
    }
  }, [auth.session?.user.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Nothing on this screen was live: no interval, no refetch. Everything froze
  // at mount — the elapsed counter ("18 min" an hour in), walk statuses, which
  // walk is current, the low-credit and failed-payment strips, and the date, so
  // a PWA left open past midnight showed yesterday's walks. The same counter
  // ticks correctly in Walk Mode, so the product contradicted itself (M10).
  //
  // A 60 s poll rather than a Realtime subscription: minute resolution is what
  // the screen displays, and the operator's own actions already reload. The
  // visibility refetch is the one that matters in practice — a phone in a
  // pocket between visits is backgrounded, where timers are throttled or
  // suspended entirely.
  useEffect(() => {
    const tick = setInterval(() => void load({ background: true }), 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load({ background: true });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  if (error) {
    return <LoadError title="Couldn't load Today" message={error} onRetry={() => load()} />;
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
  // Already filtered, ordered and bounded by the queries above; the selectors
  // are no longer given a haystack to search.
  const low = lowCredit;
  const failed = attention;
  const completedDistance = ordered.reduce((total, walk) => total + (walk.distance_m ?? 0), 0);
  // Through the shared formatter, not an inline conversion: the inline one is
  // how Today and the client's report came to disagree about units (M36).
  const distanceLabel = completedDistance > 0 ? distanceMi(completedDistance) : undefined;
  const currentIndex = live ? ordered.findIndex((walk) => walk.id === live.id) : -1;
  const next = ordered.slice(currentIndex + 1).find((walk) => walk.status === "scheduled");

  const visits: TodayIllustratedVisit[] = ordered.map((walk) => ({
    id: walk.id,
    time: shortTime(walk.window_start),
    petName: walkPetNames(walk).join(" & ") || "Pet",
    route: walk.property?.label || "Route not set",
    duration: walk.status === "in_progress" ? elapsedMinutes(walk.started_at) : undefined,
    state: visitState(walk.status),
    // The client record: door codes, pets, property notes, contact. This is
    // what the operator is actually looking for when they tap a row on a
    // doorstep, and until now Today was a poster with nothing to tap.
    href: `/clients/${walk.client_id}`,
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
        dateLabel={todayDateLabel()}
        visits={visits}
        distanceLabel={distanceLabel}
        paceLabel={paceLabel}
        nextVisitLabel={nextVisitLabel}
        inbox={<NotificationBell persona="operator" />}
        currentAction={live ? <TodayCurrentAction walkId={live.id} /> : undefined}
        emptyAction={
          <Link className="btn btn--ghost" to="/calendar">
            Add a walk
          </Link>
        }
      />

      {(stale.length > 0 || low.length > 0 || failed.length > 0) && (
        <aside className="today-emaki-followups" aria-label="Items needing attention">
          {/*
            Review M28. First in the list because it is the only entry that is
            costing money right now: an unfinished walk has never debited a
            credit, never charged an overage and never sent the client their
            report. It is listed here rather than in the schedule because the
            schedule is today's, and the whole failure was that a walk started
            yesterday appeared nowhere at all.

            The link goes to Walk Mode, not the client record — the operator
            needs to END WALK with the real numbers, which is the one action
            that finishes it. The sweep deliberately did not do that for them.
          */}
          {stale.length > 0 && (
            <section>
              <span className="section-label">Unfinished walks</span>
              <div className="today-emaki-followups__list">
                {stale.map((walk) => (
                  <Link
                    key={walk.id}
                    to={`/walks/${walk.id}/live`}
                    className="today-emaki-followups__link"
                  >
                    <Card className="today-emaki-followups__item">
                      <span>
                        {walkPetNames(walk).join(" & ") || "Walk"} ·{" "}
                        {dateLocal(walk.scheduled_date)}
                      </span>
                      <span className="today-emaki-followups__value">
                        <Badge status="attention">Never ended</Badge>
                      </span>
                    </Card>
                  </Link>
                ))}
              </div>
            </section>
          )}

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
                    <span>{payment.client?.full_name ?? ""} · {dateLocal(payment.created_at)}</span>
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
