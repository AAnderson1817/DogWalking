import { useId, type ReactNode } from "react";
import { Link } from "react-router-dom";

export type TodayVisitState =
  | "completed"
  | "current"
  | "upcoming"
  | "cancelled"
  | "no_show";

export interface TodayIllustratedVisit {
  id: string;
  time: string;
  petName: string;
  route: string;
  duration?: string;
  state: TodayVisitState;
  /**
   * Where the row goes. Spec 05 requires schedule rows to be links with
   * complete accessible labels; the operator's real question at 1:58 on a
   * doorstep is "what is the code for Luna's gate", and the client record is
   * where the vault, the pets and the property notes live.
   */
  href?: string;
}

export interface TodayIllustratedScheduleProps {
  backgroundSrc: string;
  dateLabel: string;
  visits: TodayIllustratedVisit[];
  distanceLabel?: string;
  paceLabel: string;
  nextVisitLabel: string;
  inbox?: ReactNode;
  currentAction?: ReactNode;
  /** Shown with the empty state. A day with no visits is the one day that
      most needs a way to add one. */
  emptyAction?: ReactNode;
}

const STATE_LABELS: Record<Exclude<TodayVisitState, "completed" | "current">, string> = {
  upcoming: "UP NEXT",
  cancelled: "CANCELLED",
  no_show: "NO SHOW",
};

const SPOKEN_STATE: Record<TodayVisitState, string> = {
  completed: "done",
  current: "underway",
  upcoming: "up next",
  cancelled: "cancelled",
  no_show: "no show",
};

/**
 * The tappable part of a schedule row. Falls back to a plain span when the
 * caller has nowhere to send it, so the composition still renders in the DEV
 * fixture and in any future read-only context.
 */
function VisitLink({ visit, children }: { visit: TodayIllustratedVisit; children: ReactNode }) {
  const label = `${visit.petName}, ${visit.time}, ${visit.route}, ${SPOKEN_STATE[visit.state]}`;
  if (!visit.href) {
    return <span className="today-emaki-visit__link">{children}</span>;
  }
  return (
    <Link className="today-emaki-visit__link" to={visit.href} aria-label={label}>
      {children}
    </Link>
  );
}

/**
 * The approved Indigo Emaki Today composition. The background is the locked
 * environmental artwork; schedule text remains live, selectable, and
 * accessible rather than being baked into the image.
 */
export function TodayIllustratedSchedule({
  backgroundSrc,
  dateLabel,
  visits,
  distanceLabel,
  paceLabel,
  nextVisitLabel,
  inbox,
  currentAction,
  emptyAction,
}: TodayIllustratedScheduleProps) {
  const completed = visits.filter((visit) => visit.state === "completed").length;
  const currentIndex = visits.findIndex((visit) => visit.state === "current");
  const current = currentIndex >= 0 ? visits[currentIndex] : undefined;
  const actionableVisits = Math.max(1, visits.filter((visit) => !["cancelled", "no_show"].includes(visit.state)).length);
  const lockedThreeVisitState = actionableVisits === 3 && completed === 1 && current;
  const completeEnd = lockedThreeVisitState ? 27 : Math.min(100, (completed / actionableVisits) * 100);
  const currentEnd = lockedThreeVisitState
    ? 52
    : current
      ? Math.min(100, ((completed + 1) / actionableVisits) * 100)
      : completeEnd;
  const clipId = useId().replace(/:/g, "");

  return (
    // A div, not a main element. This component predates the AppMain
    // landmark and carried its own, so once the shell supplied one the Today
    // screen had two — nested, which is invalid and gives the operator's
    // flagship screen two "main" landmarks to choose between. The landmark
    // belongs to the shell; this is the composition inside it.
    <div className="today-emaki" data-testid="today-illustrated-schedule">
      <img
        src={backgroundSrc}
        alt=""
        width="875"
        height="1798"
        className="today-emaki__backdrop"
        decoding="async"
      />

      <header className="today-emaki__masthead">
        <p className="today-emaki__date">{dateLabel}</p>
        {inbox && <div className="today-emaki__inbox">{inbox}</div>}
      </header>

      <section className="today-emaki__schedule" aria-labelledby="today-emaki-title">
        <h1 id="today-emaki-title">Today</h1>

        <div className="today-emaki__summary">
          <p><strong>{completed} complete</strong><span aria-hidden> · </span>{visits.length} visits</p>
          {distanceLabel && <p className="today-emaki__distance">{distanceLabel}</p>}
        </div>

        <div
          className="today-emaki-progress"
          role="img"
          aria-label={`${completed} of ${visits.length} visits complete. ${current ? `${current.petName} is in progress.` : "No walk is currently active."}`}
        >
          <svg viewBox="0 0 1000 54" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <clipPath id={`${clipId}-complete`}><rect x="0" y="0" width={completeEnd * 10} height="54" /></clipPath>
              <clipPath id={`${clipId}-current`}><rect x={completeEnd * 10} y="0" width={(currentEnd - completeEnd) * 10} height="54" /></clipPath>
            </defs>
            <path className="today-emaki-progress__base" d="M3 29 C105 1 193 52 288 22 S478 5 584 28 S789 47 997 18" pathLength="100" />
            <path
              className="today-emaki-progress__complete"
              d="M3 29 C105 1 193 52 288 22 S478 5 584 28 S789 47 997 18"
              clipPath={`url(#${clipId}-complete)`}
            />
            <path
              className="today-emaki-progress__current"
              d="M3 29 C105 1 193 52 288 22 S478 5 584 28 S789 47 997 18"
              clipPath={`url(#${clipId}-current)`}
            />
            {current && <line className="today-emaki-progress__marker" x1={completeEnd * 10} y1="6" x2={completeEnd * 10} y2="49" />}
          </svg>
          <p className="today-emaki-progress__copy">
            <strong>{paceLabel}</strong>
            <span aria-hidden> · </span>
            <span>{nextVisitLabel}</span>
          </p>
        </div>

        {visits.length === 0 ? (
          <div className="today-emaki__empty">
            <p>No visits scheduled today.</p>
            {emptyAction}
          </div>
        ) : (
          <ol className="today-emaki-visits" aria-label="Today's visits">
            {visits.map((visit) => (
              <li key={visit.id} className={`today-emaki-visit today-emaki-visit--${visit.state}`}>
                <span className="today-emaki-visit__bar" aria-hidden="true" />
                {/* The time and identity are one link, not the whole row: the
                    current row also carries END WALK, and nesting one
                    interactive element inside another is invalid and
                    unreachable by keyboard. The label is complete on its own
                    because a screen-reader user hearing the link list out of
                    context gets no help from the surrounding cells. */}
                <VisitLink visit={visit}>
                  <time className="today-emaki-visit__time">{visit.time}</time>
                  <span className="today-emaki-visit__identity">
                    <strong>{visit.petName}</strong>
                    <span>{visit.route}{visit.duration ? ` · ${visit.duration}` : ""}</span>
                  </span>
                </VisitLink>
                {visit.state === "completed" ? (
                  <span className="today-emaki-visit__completed">
                    <span className="today-emaki-visit__check" aria-hidden="true">✓</span>
                    <span>DONE</span>
                  </span>
                ) : visit.state === "current" && currentAction ? (
                  <span className="today-emaki-visit__action">{currentAction}</span>
                ) : visit.state !== "current" ? (
                  <span className="today-emaki-visit__state">{STATE_LABELS[visit.state]}</span>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

export function TodayCurrentAction({ walkId }: { walkId: string }) {
  return (
    <Link className="today-emaki-current-action" to={`/walks/${walkId}/live`}>
      End walk
    </Link>
  );
}
