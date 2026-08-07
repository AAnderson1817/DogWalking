import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Badge, type BadgeStatus } from "./Badge";

const EXPECTED_LABELS: Record<BadgeStatus, string> = {
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Complete",
  cancelled: "Cancelled",
  no_show: "No-show",
  overage: "Overage",
  attention: "Attention",
  neutral: "Inactive",
  critical: "Critical",
};

describe("Badge", () => {
  it("keeps a visible label and stable status class for every semantic state", () => {
    for (const [status, label] of Object.entries(EXPECTED_LABELS)) {
      const html = renderToStaticMarkup(<Badge status={status as BadgeStatus} />);
      expect(html).toContain(`badge--${status}`);
      expect(html).toContain(`>${label}</span>`);
    }
  });

  it("allows explicit state text without losing the semantic class", () => {
    const html = renderToStaticMarkup(<Badge status="attention">Payment failed</Badge>);
    expect(html).toContain("badge--attention");
    expect(html).toContain(">Payment failed</span>");
  });
});
