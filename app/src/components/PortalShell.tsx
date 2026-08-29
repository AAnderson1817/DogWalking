// Client portal chrome. Was assembled inline in App.tsx; extracted so the
// main landmark lives in one place per persona, as it does for the
// operator.
import type { ReactNode } from "react";
import { AppMain, MAIN_ID } from "./AppMain";
import { BottomNav, NAV_ID } from "./BottomNav";
import { LegalLinks } from "./LegalLinks";

export function PortalShell({ children }: { children: ReactNode }) {
  return (
    <>
      {/* Entailed by the rail, not adjacent politeness. The client nav becomes
          an 88px left rail at 1024px (review M18), which puts it DOM-last and
          visually FIRST — the exact condition OperatorShell's own comment says
          forces a keyboard user through every row on the page to change
          section. Shipping the rail without these anchors would introduce the
          problem that comment documents. The targets already existed and
          pointed at nothing. */}
      <a className="sr-only skip-link" href={`#${MAIN_ID}`}>
        Skip to content
      </a>
      <a className="sr-only skip-link" href={`#${NAV_ID}`}>
        Skip to navigation
      </a>
      <AppMain>
        {children}
        {/* Review H6: the client's standing route to the notice. It is the one
            persona whose data was entered before they had any account, so the
            portal is where "what is held about me" has to be reachable. */}
        <LegalLinks />
      </AppMain>
      <BottomNav persona="client" />
    </>
  );
}
