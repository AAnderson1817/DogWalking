import { BottomNav } from "@/components/BottomNav";

/**
 * DEV-only fixture for the Calendar week grid (review M20).
 *
 * The week is the only production surface that is a grid rather than a reading
 * measure, and two things about it can only be checked by rendering: whether a
 * day column gains anything from a wider screen, and whether a long pet name
 * stays inside its own column. Calendar itself needs a backend, so it cannot
 * join the backend-free e2e suite; this renders the same markup and the same
 * classes against fixed fixtures.
 *
 * The names are chosen to be the problem: "Bartholomew" measured 6.16px past
 * its chip border and 2.16px into the neighbouring day at 1440x900 before
 * `overflow-wrap` was added, and 13px / 9px at 390x844. They are ordinary dog
 * names, which is the point — this needed no unusual data to reproduce.
 *
 * Excluded from the production bundle by the `import.meta.env.DEV` gate in
 * `App.tsx`, which CI asserts against `dist/`.
 */

const DAYS = [
  { label: "Mon", date: "2026-09-07", walks: [{ time: "11:30 AM", pet: "Bartholomew", state: "scheduled" }] },
  { label: "Tue", date: "2026-09-08", walks: [{ time: "9:00 AM", pet: "Marshmallow", state: "completed" }] },
  { label: "Wed", date: "2026-09-09", walks: [{ time: "2:15 PM", pet: "Persephone", state: "in_progress" }] },
  { label: "Thu", date: "2026-09-10", walks: [{ time: "8:00 AM", pet: "Wellington", state: "overage" }] },
  { label: "Fri", date: "2026-09-11", walks: [{ time: "4:45 PM", pet: "Juniper", state: "scheduled" }] },
  { label: "Sat", date: "2026-09-12", walks: [] },
  { label: "Sun", date: "2026-09-13", walks: [{ time: "10:00 AM", pet: "Mochi", state: "cancelled" }] },
];

export default function CalendarWeekPreview() {
  return (
    <>
      <div className="page page--wide">
        <h1>Calendar</h1>
        <div className="calendar-week" data-testid="calendar-week">
          {DAYS.map((day) => (
            <div className="calendar-week__day" key={day.date} data-testid={`day-${day.label}`}>
              <div className="calendar-week__header">
                <div className="section-label">{day.label}</div>
                <div className="numeral" style={{ fontSize: "var(--fs-12)" }}>{day.date.slice(8)}</div>
              </div>
              {day.walks.map((walk) => (
                <button
                  type="button"
                  key={walk.pet}
                  className={`calendar-walk calendar-walk--${walk.state}`}
                  data-testid={`chip-${walk.pet}`}
                >
                  <span className="calendar-walk__summary">
                    {walk.time} {walk.pet}
                  </span>
                  <span className="calendar-walk__status">{walk.state}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
      <BottomNav persona="operator" activePath="/calendar" />
    </>
  );
}
