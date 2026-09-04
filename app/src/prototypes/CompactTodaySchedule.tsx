import {
  TodayIllustratedSchedule,
  type TodayIllustratedScheduleProps,
} from "@/components/TodayIllustratedSchedule";
import "./compact-today.css";

/** Review candidate, rendered only by the DEV Today preview. Shared markup,
 * links and walk controls make this a layout comparison, not a second app. */
export function CompactTodaySchedule(props: TodayIllustratedScheduleProps) {
  return (
    <div className="today-compact">
      <TodayIllustratedSchedule {...props} />
    </div>
  );
}
