// Operator chrome: BottomNav (rail on desktop) around every operator screen
// except Walk Mode, which owns the full viewport.
import type { ReactNode } from "react";
import { BottomNav } from "./BottomNav";

export function OperatorShell({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <BottomNav persona="operator" />
    </>
  );
}
