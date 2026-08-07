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
});
