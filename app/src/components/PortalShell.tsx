// Client portal chrome. Was assembled inline in App.tsx; extracted so the
// main landmark lives in one place per persona, as it does for the
// operator.
import type { ReactNode } from "react";
import { AppMain } from "./AppMain";
import { BottomNav } from "./BottomNav";

export function PortalShell({ children }: { children: ReactNode }) {
  return (
    <>
      <AppMain>{children}</AppMain>
      <BottomNav persona="client" />
    </>
  );
}
