import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./EmptyState";
import { LoadingState, StateField } from "./StateField";

describe("StateField", () => {
  it("keeps state, message, and recovery action visible", () => {
    const html = renderToStaticMarkup(
      <StateField
        tone="attention"
        label="Needs attention"
        title="Couldn't load the calendar"
        detail="Check your connection and try again."
        role="alert"
        action={<button type="button">Retry</button>}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain("Needs attention");
    expect(html).toContain("Couldn&#x27;t load the calendar");
    expect(html).toContain(">Retry<");
  });

  it("gives loading and empty states explicit visible language", () => {
    const loading = renderToStaticMarkup(<LoadingState label="Loading clients" />);
    const empty = renderToStaticMarkup(<EmptyState title="No clients yet" />);
    expect(loading).toContain('role="status"');
    expect(loading).toContain("Loading clients");
    expect(loading.match(/role="status"/g)).toHaveLength(1);
    expect(empty).toContain("No clients yet");
  });
});
