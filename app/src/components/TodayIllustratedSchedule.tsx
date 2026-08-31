import { useId, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  TODAY_PLATE_HEIGHT,
  TODAY_PLATE_SIZES,
  TODAY_PLATE_SRC,
  TODAY_PLATE_SRCSET,
  TODAY_PLATE_WIDTH,
} from "@/lib/today-plate";
import { ApprovedIcon } from "./ApprovedIcon";

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
      {/* One <img>, four candidates. `sizes` mirrors `--page-max`; the plate
          is `width: 100%` of the field, so that variable is what decides the
          rendered width. Review M17: a DPR-1 laptop was downloading the full
          875px plate to paint it 438px wide.

          Deliberately NO `fetchPriority` hint. A first draft carried
          `fetchPriority="high"` on the reasoning that this is the largest
          contentful paint — which is probably true and is still not a reason
          to ship it here. Raising the plate's priority trades against the JS
          that renders the schedule, and the schedule is the part the operator
          needs at a doorstep; that trade is a measurement nobody has taken,
          in a change about transfer size. It belongs in its own commit with
          its own numbers. */}
      <img
        src={TODAY_PLATE_SRC}
        srcSet={TODAY_PLATE_SRCSET}
        sizes={TODAY_PLATE_SIZES}
        alt=""
        width={TODAY_PLATE_WIDTH}
        height={TODAY_PLATE_HEIGHT}
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

        {/* Review L15. `role="img"` used to sit on this DIV, which also
            contains the pace and next-visit copy below — and `img` is
            children-presentational in ARIA, so conforming assistive technology
            prunes its subtree. That silently deleted two of the three things
            this screen exists to say, and the only two not repeated in the
            visit list. Chromium happens not to prune them, which is exactly
            why it survived: relying on one browser's leniency about a
            spec-defined behaviour is not support.

            The role belongs on the SVG, which genuinely IS an image and has no
            text of its own. */}
        <div className="today-emaki-progress">
          <svg
            viewBox="0 0 1000 54"
            preserveAspectRatio="none"
            role="img"
            aria-label={`${completed} of ${visits.length} visits complete. ${current ? `${current.petName} is in progress.` : "No walk is currently active."}`}
          >
            <defs>
              {/* `today-emaki-progress__clip` carries the L17 transition. A
                  class rather than a `clipPath rect` type selector: SVG type
                  selectors are case-sensitive inside an HTML document, and a
                  silently-non-matching selector is exactly the kind of thing
                  that would leave this looking finished and doing nothing. */}
              <clipPath id={`${clipId}-complete`}><rect className="today-emaki-progress__clip" x="0" y="0" width={completeEnd * 10} height="54" /></clipPath>
              <clipPath id={`${clipId}-current`}><rect className="today-emaki-progress__clip" x={completeEnd * 10} y="0" width={(currentEnd - completeEnd) * 10} height="54" /></clipPath>
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
                    <ApprovedIcon name="check" size={14} className="today-emaki-visit__check" />
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
