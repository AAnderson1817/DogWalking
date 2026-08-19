import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SegmentedTabs, TabPanel } from "./SegmentedTabs";

/**
 * Review M16. Both segmented controls declared `role="tablist"` and
 * `role="tab"` with `aria-selected` and nothing else: no `aria-controls`, no
 * tabpanel, no roving `tabIndex`, no key handling, and no `aria-label` on
 * ClientDetail's. A screen-reader user was told "tab, 5 of 5, selected" for
 * the operator's main client workspace — whose fifth tab is the credential
 * vault — reached for the arrow keys that announcement implies, and nothing
 * happened.
 *
 * Incorrect ARIA is worse than none: it promises an interaction the widget
 * does not have. Every case here is about the promise being kept.
 */

const TABS = [
  { key: "pets", label: "Pets" },
  { key: "plan", label: "Plan" },
  { key: "walks", label: "Walks" },
] as const;

type Key = (typeof TABS)[number]["key"];

function Harness({ onChange = vi.fn() }: { onChange?: (k: Key) => void }) {
  const [value, setValue] = useState<Key>("pets");
  return (
    <>
      <SegmentedTabs
        idBase="t"
        label="Client sections"
        tabs={TABS}
        value={value}
        onChange={(k) => {
          setValue(k);
          onChange(k);
        }}
      />
      <TabPanel idBase="t" tabKey={value}>
        <p>panel for {value}</p>
      </TabPanel>
    </>
  );
}

const tab = (name: string) => screen.getByRole("tab", { name });

describe("SegmentedTabs", () => {
  it("names the control, so it is not an anonymous list of tabs", () => {
    render(<Harness />);
    expect(screen.getByRole("tablist", { name: "Client sections" })).toBeInTheDocument();
  });

  it("points each tab at a real panel", () => {
    render(<Harness />);
    const selected = tab("Pets");
    const panel = screen.getByRole("tabpanel");
    expect(selected).toHaveAttribute("aria-controls", panel.id);
    expect(panel).toHaveAttribute("aria-labelledby", selected.id);
  });

  it("keeps exactly one tab in the tab order", () => {
    // Roving tabIndex. Without it, Tab walks through every tab before
    // reaching the panel — which is what the tablist role exists to avoid.
    render(<Harness />);
    expect(tab("Pets")).toHaveAttribute("tabindex", "0");
    expect(tab("Plan")).toHaveAttribute("tabindex", "-1");
    expect(tab("Walks")).toHaveAttribute("tabindex", "-1");
  });

  it("moves focus with the arrow keys", async () => {
    // The headline defect: the announcement says "tab, 1 of 3", the user
    // presses Right, and nothing happens.
    const user = userEvent.setup();
    render(<Harness />);
    tab("Pets").focus();
    await user.keyboard("{ArrowRight}");
    expect(tab("Plan")).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(tab("Walks")).toHaveFocus();
  });

  it("wraps at both ends", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    tab("Pets").focus();
    await user.keyboard("{ArrowLeft}");
    expect(tab("Walks")).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(tab("Pets")).toHaveFocus();
  });

  it("jumps to the ends with Home and End", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    tab("Plan").focus();
    await user.keyboard("{End}");
    expect(tab("Walks")).toHaveFocus();
    await user.keyboard("{Home}");
    expect(tab("Pets")).toHaveFocus();
  });

  it("does NOT select on focus alone", async () => {
    // Manual activation is deliberate: ClientDetail's panels each mount a
    // component that fetches, so selection-follows-focus would fire a request
    // per tab as the user arrows across five of them.
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    tab("Pets").focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(onChange).not.toHaveBeenCalled();
    expect(tab("Pets")).toHaveAttribute("aria-selected", "true");
  });

  it("selects on Enter", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    tab("Pets").focus();
    await user.keyboard("{ArrowRight}{Enter}");
    expect(onChange).toHaveBeenCalledWith("plan");
    expect(tab("Plan")).toHaveAttribute("aria-selected", "true");
  });

  it("selects on Space without scrolling the page", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    tab("Pets").focus();
    await user.keyboard("{ArrowRight}{ArrowRight}[Space]");
    expect(onChange).toHaveBeenCalledWith("walks");
  });

  it("still selects on click", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    await user.click(tab("Walks"));
    expect(onChange).toHaveBeenCalledWith("walks");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("panel for walks");
  });

  it("moves the tab order with the selection", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(tab("Plan"));
    expect(tab("Plan")).toHaveAttribute("tabindex", "0");
    expect(tab("Pets")).toHaveAttribute("tabindex", "-1");
  });
});
