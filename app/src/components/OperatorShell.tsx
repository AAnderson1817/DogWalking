// Operator chrome: BottomNav (rail on desktop) around every operator screen
// except Walk Mode, which owns the full viewport.
import type { ReactNode } from "react";
import { AppMain, MAIN_ID } from "./AppMain";
import { BottomNav, NAV_ID } from "./BottomNav";

export function OperatorShell({ children }: { children: ReactNode }) {
  return (
    <>
      {/* Both directions, because the operator nav is a bottom bar on mobile
          (DOM-last, visually last) and an 88px left rail on desktop
          (DOM-last, visually FIRST). In the rail case a keyboard operator
          otherwise tabs through every roster row to change section. */}
      <a className="sr-only skip-link" href={`#${MAIN_ID}`}>
        Skip to content
      </a>
      <a className="sr-only skip-link" href={`#${NAV_ID}`}>
        Skip to navigation
      </a>
      <AppMain>{children}</AppMain>
      <BottomNav persona="operator" />
    </>
  );
}
