// The single <main> landmark. Before this, no route had one — screen-reader
// users navigate an unfamiliar app by landmark and heading, so the only way
// through Walk Mode or Money was a linear Tab from the top of the document.
//
// It carries `flex: 1; display: flex; flex-direction: column` (`.app-main`)
// because it becomes #root's flex child in place of the screen, and `.page`'s
// own `flex: 1` was written against that context.
import type { ReactNode } from "react";

export const MAIN_ID = "main-content";

export function AppMain({ children }: { children: ReactNode }) {
  return (
    // tabIndex -1 so the skip link can move focus here, not just scroll.
    <main id={MAIN_ID} className="app-main" tabIndex={-1}>
      {children}
    </main>
  );
}
