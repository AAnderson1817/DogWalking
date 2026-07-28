import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ApprovedIcon } from "./ApprovedIcon";
import { APPROVED_ICON_URLS } from "./approved-icons";
import { BottomNav } from "./BottomNav";
import { OPERATOR_NAV_ITEMS } from "./operator-navigation";

describe("ApprovedIcon", () => {
  it("exposes all six approved production masters", () => {
    expect(Object.keys(APPROVED_ICON_URLS).sort()).toEqual([
      "calendar",
      "clients",
      "day",
      "inbox",
      "payments",
      "route",
    ]);
  });

  it("renders an approved asset as a currentColor mask at the requested size", () => {
    const html = renderToStaticMarkup(<ApprovedIcon name="calendar" size={32} />);
    expect(html).toContain('class="approved-icon"');
    expect(html).toContain("mask-image:url");
    expect(html).toContain("data:image/svg+xml");
    expect(html).toContain("width:32px");
    expect(html).toContain("height:32px");
    expect(html).toContain('aria-hidden="true"');
  });
});

describe("operator primary navigation", () => {
  it("uses the approved order, labels, routes, and icon assignments", () => {
    expect(OPERATOR_NAV_ITEMS).toEqual([
      { to: "/", label: "Today", icon: "day", end: true },
      { to: "/calendar", label: "Calendar", icon: "calendar" },
      { to: "/roster", label: "Clients", icon: "clients" },
      { to: "/billing", label: "Money", icon: "payments" },
    ]);
  });

  it("keeps all four visible labels and marks the current destination", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/billing"]}>
        <BottomNav persona="operator" />
      </MemoryRouter>,
    );

    for (const label of ["Today", "Calendar", "Clients", "Money"]) {
      expect(html).toContain(`>${label}</a>`);
    }
    expect(html).toContain('href="/billing"');
    expect(html).toContain('aria-current="page"');
    expect(html.match(/approved-icon/g)).toHaveLength(4);
    expect(html).not.toContain(">Vault</a>");
    expect(html).not.toContain(">Inbox</a>");
  });
});
