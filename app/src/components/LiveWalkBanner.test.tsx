import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { LiveWalkBanner } from "./LiveWalkBanner";

describe("LiveWalkBanner", () => {
  it("renders one explicit, quiet Current Moment action", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-15T14:05:07Z"));
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LiveWalkBanner
          walkId="walk-1"
          startedAt="2026-07-15T14:00:00Z"
          label="Walking Biscuit"
        />
      </MemoryRouter>,
    );

    expect(html).toContain("CURRENT");
    expect(html).toContain("Walking Biscuit");
    expect(html).toContain("05:07");
    expect(html).toContain("Open walk");
    expect(html).not.toContain("pulse-live");
    vi.restoreAllMocks();
  });
});
