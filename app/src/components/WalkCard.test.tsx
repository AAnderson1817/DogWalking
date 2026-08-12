import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WalkCard } from "./WalkCard";

const BASE = {
  windowStart: "09:00:00",
  windowEnd: "10:30:00",
  petNames: ["Biscuit", "Pickle"],
  propertyLabel: "Riverside route",
  status: "scheduled" as const,
  clientName: "Amelia Hart",
};

describe("WalkCard schedule row", () => {
  it("shows the approved explicit schedule hierarchy without a card or dog avatar", () => {
    const html = renderToStaticMarkup(<WalkCard walk={BASE} />);
    expect(html).toContain("UP NEXT");
    expect(html).toContain("9:00–10:30 AM");
    expect(html).toContain("Biscuit &amp; Pickle");
    expect(html).toContain("Riverside route");
    expect(html).toContain("1 hr 30 min");
    expect(html).not.toContain('class="card');
    expect(html).not.toContain("pet-avatar");
  });

  it("uses a real button and complete accessible label when interactive", () => {
    const html = renderToStaticMarkup(<WalkCard walk={BASE} onClick={() => undefined} />);
    expect(html).toContain('<button type="button"');
    expect(html).toContain('aria-label="UP NEXT: Biscuit &amp; Pickle, 9:00 AM to 10:30 AM, Riverside route, 1 hr 30 min"');
  });

  it("uses CURRENT and DONE labels rather than color-only state", () => {
    expect(renderToStaticMarkup(<WalkCard walk={{ ...BASE, status: "in_progress" }} />)).toContain("CURRENT");
    expect(renderToStaticMarkup(<WalkCard walk={{ ...BASE, status: "completed" }} />)).toContain("✓ DONE");
  });
});
