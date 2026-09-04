import { useSearchParams } from "react-router-dom";
import { ApprovedIcon } from "@/components/ApprovedIcon";
import { BottomNav } from "@/components/BottomNav";
import { CompactTodaySchedule } from "./CompactTodaySchedule";
import {
  TodayCurrentAction,
  TodayIllustratedSchedule,
  type TodayIllustratedVisit,
} from "@/components/TodayIllustratedSchedule";

const VISITS: TodayIllustratedVisit[] = [
  {
    id: "walk-juniper",
    time: "9:00",
    petName: "Juniper",
    route: "Maple Walk",
    state: "completed",
    href: "/clients/fixture-juniper",
  },
  {
    id: "walk-mochi",
    time: "11:30",
    petName: "Mochi",
    route: "Lakeside Loop",
    duration: "18 min",
    state: "current",
    href: "/clients/fixture-mochi",
  },
  {
    id: "walk-luna",
    time: "2:00",
    petName: "Luna",
    route: "Oak Trail",
    state: "upcoming",
    href: "/clients/fixture-luna",
  },
];

const EXTRA_PETS = ["Pepper", "Waffle", "Cinder", "Bramble", "Poppy", "Tofu", "Sable", "Nutmeg", "Juno"];

/**
 * `?visits=N` extends the locked three-visit fixture to N rows, so the
 * Playwright suite can exercise the day lengths the target customer actually
 * works — six to ten visits — which is where the schedule used to be silently
 * truncated. `?visits=0` renders the empty state. DEV-only, like the route.
 */
function buildVisits(count: number): TodayIllustratedVisit[] {
  if (count <= VISITS.length) return VISITS.slice(0, count);
  const extra = Array.from({ length: count - VISITS.length }, (_, i) => ({
    id: `walk-extra-${i}`,
    time: `${3 + (i % 9)}:15`,
    petName: EXTRA_PETS[i % EXTRA_PETS.length]!,
    route: "Riverside Path",
    state: "upcoming" as const,
    href: `/clients/fixture-extra-${i}`,
  }));
  return [...VISITS, ...extra];
}

export default function TodayPreview() {
  const [params] = useSearchParams();
  const requested = Number(params.get("visits"));
  const visits = Number.isFinite(requested) && params.has("visits")
    ? buildVisits(Math.max(0, Math.min(24, requested)))
    : VISITS;
  const live = visits.some((visit) => visit.state === "current");
  const Schedule = params.get("layout") === "compact"
    ? CompactTodaySchedule
    : TodayIllustratedSchedule;

  return (
    <>
      <div className="page today-emaki-page">
        <Schedule
          dateLabel="Wednesday, July 22"
          visits={visits}
          distanceLabel="7.2 mi"
          paceLabel="On time"
          nextVisitLabel="22 min to Luna after this walk"
          inbox={
            <button className="today-emaki__preview-inbox" type="button" aria-label="Inbox, 1 unread">
              <ApprovedIcon name="inbox" />
              <span aria-hidden="true" />
            </button>
          }
          currentAction={live ? <TodayCurrentAction walkId="walk-mochi" /> : undefined}
          emptyAction={
            <a className="btn btn--ghost" href="/calendar">
              Add a walk
            </a>
          }
        />
      </div>
      <BottomNav persona="operator" activePath="/" />
    </>
  );
}
