import todayBackground from "@/assets/illustrations/sanpo-today-indigo-emaki-background-approved-v1.png";
import { ApprovedIcon } from "@/components/ApprovedIcon";
import { BottomNav } from "@/components/BottomNav";
import { TodayCurrentAction, TodayIllustratedSchedule } from "@/components/TodayIllustratedSchedule";

const VISITS = [
  {
    id: "walk-juniper",
    time: "9:00",
    petName: "Juniper",
    route: "Maple Walk",
    state: "completed" as const,
  },
  {
    id: "walk-mochi",
    time: "11:30",
    petName: "Mochi",
    route: "Lakeside Loop",
    duration: "18 min",
    state: "current" as const,
  },
  {
    id: "walk-luna",
    time: "2:00",
    petName: "Luna",
    route: "Oak Trail",
    state: "upcoming" as const,
  },
];

export default function TodayPreview() {
  return (
    <>
      <div className="page today-emaki-page">
        <TodayIllustratedSchedule
          backgroundSrc={todayBackground}
          dateLabel="Wednesday, July 22"
          visits={VISITS}
          distanceLabel="7.2 mi"
          paceLabel="On time"
          nextVisitLabel="22 min to Luna after this walk"
          inbox={
            <button className="today-emaki__preview-inbox" type="button" aria-label="Inbox, 1 unread">
              <ApprovedIcon name="inbox" />
              <span aria-hidden="true" />
            </button>
          }
          currentAction={<TodayCurrentAction walkId="walk-mochi" />}
        />
      </div>
      <BottomNav persona="operator" activePath="/" />
    </>
  );
}
