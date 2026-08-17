import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { TodayCurrentAction, TodayIllustratedSchedule } from "./TodayIllustratedSchedule";

const visits = [
  { id: "done", time: "9:00", petName: "Juniper", route: "Maple Walk", state: "completed" as const },
  { id: "current", time: "11:30", petName: "Mochi", route: "Lakeside Loop", duration: "18 min", state: "current" as const },
  { id: "next", time: "2:00", petName: "Luna", route: "Oak Trail", state: "upcoming" as const },
];

describe("TodayIllustratedSchedule", () => {
  it("preserves the locked Indigo Emaki Today hierarchy and copy", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TodayIllustratedSchedule
          backgroundSrc="/approved-background.png"
          dateLabel="Wednesday, July 22"
          visits={visits}
          distanceLabel="7.2 mi"
          paceLabel="On time"
          nextVisitLabel="22 min to Luna after this walk"
          currentAction={<TodayCurrentAction walkId="walk-current" />}
        />
      </MemoryRouter>,
    );

    expect(html).toContain("<h1 id=\"today-emaki-title\">Today</h1>");
    expect(html).toContain("Wednesday, July 22");
    expect(html).toContain("1 complete");
    expect(html).toContain("3 visits");
    expect(html).toContain("7.2 mi");
    expect(html).toContain("On time");
    expect(html).toContain("22 min to Luna after this walk");
    expect(html).toContain('href="/walks/walk-current/live"');
    expect(html).toContain("End walk");
    expect(html).toContain("DONE");
    expect(html).toContain("UP NEXT");
  });

  it("keeps the approved visit order and excludes rejected elements", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TodayIllustratedSchedule
          backgroundSrc="/approved-background.png"
          dateLabel="Wednesday, July 22"
          visits={visits}
          paceLabel="On time"
          nextVisitLabel="22 min to Luna"
        />
      </MemoryRouter>,
    );

    expect(html.indexOf(">Juniper<")).toBeLessThan(html.indexOf(">Mochi<"));
    expect(html.indexOf(">Mochi<")).toBeLessThan(html.indexOf(">Luna<"));
    expect(html).not.toContain("portrait");
    expect(html).not.toContain("Today&#x27;s schedule");
    expect(html).not.toContain("Open walk");
  });

  it("makes each row a link with a label that stands on its own", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TodayIllustratedSchedule
          backgroundSrc="/approved-background.png"
          dateLabel="Wednesday, July 22"
          visits={visits.map((visit) => ({ ...visit, href: `/clients/${visit.id}` }))}
          paceLabel="On time"
          nextVisitLabel="22 min to Luna"
          currentAction={<TodayCurrentAction walkId="walk-current" />}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('href="/clients/current"');
    // Read out of context by a rotor, "11:30" says nothing; the state belongs
    // in the name because colour alone carries it visually (WCAG 1.4.1).
    expect(html).toContain('aria-label="Mochi, 11:30, Lakeside Loop, underway"');
    expect(html).toContain('aria-label="Juniper, 9:00, Maple Walk, done"');
    expect(html).toContain('aria-label="Luna, 2:00, Oak Trail, up next"');

    // END WALK must not end up inside the row link — nested interactive
    // elements are invalid and unreachable by keyboard.
    const rowLink = html.slice(html.indexOf('aria-label="Mochi'));
    const linkEnd = rowLink.indexOf("</a>");
    expect(rowLink.slice(0, linkEnd)).not.toContain("End walk");
  });

  it("still renders without hrefs, so the composition survives a read-only caller", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TodayIllustratedSchedule
          backgroundSrc="/approved-background.png"
          dateLabel="Wednesday, July 22"
          visits={visits}
          paceLabel="On time"
          nextVisitLabel="22 min to Luna"
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Mochi");
    expect(html).not.toContain('class="today-emaki-visit__link" href');
  });

  it("offers an action on an empty day", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TodayIllustratedSchedule
          backgroundSrc="/approved-background.png"
          dateLabel="Wednesday, July 22"
          visits={[]}
          paceLabel="Schedule ready"
          nextVisitLabel="Your day is clear"
          emptyAction={<a href="/calendar">Add a walk</a>}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("No visits scheduled today.");
    expect(html).toContain("Add a walk");
  });
});
