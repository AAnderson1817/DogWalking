// PortalHome (phase 07): next walk, credit meter, latest report cards,
// unread notifications with mark-read.
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Card } from "@/components/Card";
import { CreditMeter } from "@/components/CreditMeter";
import { EmptyState } from "@/components/EmptyState";
import { LoadError, loadErrorMessage } from "@/components/LoadError";
import { AccessTrail } from "@/components/AccessTrail";
import { NotificationBell, NotificationList } from "@/components/NotificationInbox";
import { LoadingState } from "@/components/StateField";
import { WalkCard } from "@/components/WalkCard";
import { YourDataPanel } from "@/components/YourDataPanel";
import {
  getMyClient,
  getMyOperatorView,
  getPlan,
  listNotifications,
  listMyCredentialLog,
  listWalksDetailed,
  markNotificationRead,
  type CredentialLogRow,
  walkPetNames,
  type MyOperatorView,
  type WalkDetailed,
} from "@/lib/api";
import { dateLocal } from "@/lib/format";
import { todayLocal } from "@/lib/selectors";
import type { Clients, Notifications, Plans } from "@/lib/types";
import { useDocumentTitle } from "@/lib/use-document-title";

export default function PortalHome() {
  useDocumentTitle("Your walks");
  const navigate = useNavigate();
  const [client, setClient] = useState<Clients | null>(null);
  const [operator, setOperator] = useState<MyOperatorView | null>(null);
  const [plan, setPlan] = useState<Plans | null>(null);
  const [upcomingWalks, setUpcoming] = useState<WalkDetailed[]>([]);
  const [reports, setReports] = useState<WalkDetailed[]>([]);
  const [notifications, setNotifications] = useState<Notifications[]>([]);
  const [accessTrail, setAccessTrail] = useState<CredentialLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const me = await getMyClient();
    if (!me) throw new Error("We couldn't load your account. Please try again.");
    const [op, upcomingWalks, recentReports, ns, p, trail] = await Promise.all([
      getMyOperatorView(),
      // Review M9. This was `listWalksDetailed({})` — every walk this client
      // has ever had, to render one "next walk" card and three reports. About
      // 470 rows for a client three years into a 3x/week plan, and past
      // PostgREST's 1000-row cap it was worse than wasteful: the default order
      // is ASCENDING, so a long-tenured client kept their first year and lost
      // every recent walk, including the next one this screen exists to show.
      listWalksDetailed({ from: todayLocal(), limit: 30 }),
      listWalksDetailed({ status: "completed", newestFirst: true, limit: 3 }),
      listNotifications(true),
      me.plan_id ? getPlan(me.plan_id) : Promise.resolve(null),
      // Advisory. A client with no credential on file has an empty trail, and
      // a failure to read it must not cost them their whole portal — the
      // walks and the credit balance are what they came for.
      listMyCredentialLog(20).catch(() => []),
    ]);
    setClient(me);
    setOperator(op);
    setUpcoming(upcomingWalks);
    setReports(recentReports);
    setNotifications(ns);
    setPlan(p);
    setAccessTrail(trail);
  }, []);

  useEffect(() => {
    setError(null);
    setLoading(true);
    void load()
      .catch((e) => setError(e instanceof Error ? e.message : "failed to load"))
      .finally(() => setLoading(false));
  }, [load]);

  if (error && !client) {
    return (
      <LoadError
        title="Couldn't load your portal"
        message={error}
        onRetry={() => {
          setError(null);
          setLoading(true);
          return load()
            .catch((e) => setError(loadErrorMessage(e)))
            .finally(() => setLoading(false));
        }}
      />
    );
  }
  if (loading || !client) {
    return (
      <div className="page">
        <LoadingState label="Loading your home" />
      </div>
    );
  }

  // `from` bounds the fetch to today onward; the status filter is the one part
  // the query cannot express, since two statuses are wanted and PostgREST's
  // `in` would need the pair spelled out in a second place. Already ordered.
  const upcoming = upcomingWalks.filter(
    (w) => w.status === "scheduled" || w.status === "in_progress",
  );
  const next = upcoming[0];

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <span className="section-label">{operator?.business_name ?? "Your walker"}</span>
          <h1>Hi, {client.full_name.split(" ")[0]}</h1>
          {/* `/portal/pets` is routed (App.tsx) and specified (06:63), and
              NOTHING in the app linked to it — a 241-line screen reachable
              only by typing the URL. Same class as `fn_book_walk`'s phantom
              `active` column: shipped, spec'd, never exercised, invisible
              because nothing covered the client half. Deliberately not a fifth
              nav tab; the operator precedent that a screen does not add a tab
              as a side effect of shipping is written down twice. */}
          <Link className="secondary-link" to="/portal/pets">
            Your pets
          </Link>
        </div>
        <NotificationBell persona="client" />
      </div>

      <section style={{ marginTop: "var(--s-4)" }}>
        <span className="section-label">Next walk</span>
        <div style={{ marginTop: "var(--s-2)" }}>
          {next ? (
            <>
              <div>
                <span className="section-label">{dateLocal(`${next.scheduled_date}T12:00:00Z`)}</span>
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
                action={<Link className="secondary-link" to="/portal/book">Book a walk</Link>}
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
          <div className="notification-inbox" style={{ marginTop: "var(--s-2)" }}>
            <NotificationList
              items={notifications.slice(0, 5)}
              onOpen={(notification) => void markNotificationRead(notification.id).then(load)}
              onMarkRead={(notification) => void markNotificationRead(notification.id).then(load)}
            />
          </div>
        </section>
      )}

      {accessTrail.length > 0 && (
        <section style={{ marginTop: "var(--s-6)" }}>
          <span className="section-label">Entry code activity</span>
          <p style={{ color: "var(--text-2)", fontSize: "var(--fs-12)", marginTop: "var(--s-1)" }}>
            Every time your walker views or changes an entry code for your home,
            it is recorded here. You cannot see the codes themselves — nor can
            anyone without a fresh password check.
          </p>
          <Card style={{ marginTop: "var(--s-2)" }}>
            <AccessTrail rows={accessTrail} />
          </Card>
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
      <YourDataPanel
        businessName={operator?.business_name ?? null}
        noticeAcceptedAt={client.notice_accepted_at}
        noticeVersion={client.notice_version}
        gpsRetentionDays={operator?.gps_retention_days ?? null}
      />
    </div>
  );
}
