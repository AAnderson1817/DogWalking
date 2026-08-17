import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { MAIN_ID } from "./AppMain";
import { NAV_ID } from "./BottomNav";
import { OperatorShell } from "./OperatorShell";
import { PortalShell } from "./PortalShell";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

describe("app shells", () => {
  it("gives the operator a main landmark wrapping the screen", () => {
    const html = render(
      <OperatorShell>
        <div className="page">Today</div>
      </OperatorShell>,
    );
    expect(html).toContain(`<main id="${MAIN_ID}" class="app-main"`);
    // The screen is inside the landmark, not a sibling of it.
    expect(html).toMatch(/<main[^>]*>.*<div class="page">Today<\/div>.*<\/main>/s);
  });

  it("gives the portal the same landmark", () => {
    const html = render(
      <PortalShell>
        <div className="page">Portal</div>
      </PortalShell>,
    );
    expect(html).toContain(`<main id="${MAIN_ID}" class="app-main"`);
  });

  it("puts both skip links before the landmark they target", () => {
    const html = render(
      <OperatorShell>
        <div className="page" />
      </OperatorShell>,
    );
    const skipToContent = html.indexOf(`href="#${MAIN_ID}"`);
    const skipToNav = html.indexOf(`href="#${NAV_ID}"`);
    const main = html.indexOf("<main");
    expect(skipToContent).toBeGreaterThan(-1);
    expect(skipToNav).toBeGreaterThan(-1);
    // Focus order is DOM order, so a skip link that is not first is useless.
    expect(skipToContent).toBeLessThan(main);
    expect(skipToNav).toBeLessThan(main);
  });

  it("makes the navigation a skip target", () => {
    const html = render(
      <OperatorShell>
        <div className="page" />
      </OperatorShell>,
    );
    expect(html).toContain(`id="${NAV_ID}"`);
    expect(html).toMatch(new RegExp(`<nav[^>]*id="${NAV_ID}"[^>]*tabindex="-1"`));
  });
});
