import { useEffect, useState } from "react";

/**
 * Whether this device has a fine pointer — a mouse or trackpad (review M11).
 *
 * Calendar's drag-to-reschedule is HTML5 drag-and-drop, which does not fire on
 * touch: no `dragstart`, no `drop`, nothing. The walk chip nevertheless
 * rendered with `draggable`, a grab cursor and a drag affordance on a phone,
 * so the phase-06 headline interaction advertised itself and did nothing on
 * the primary device.
 *
 * There IS a working path — the chip is a button that opens an action sheet
 * wired to the same `reschedule()` — so the fix is to stop promising the one
 * that cannot work, not to remove the feature.
 *
 * `(pointer: fine)` rather than a touch-capability test: a laptop with a
 * touchscreen has both, and the question here is "can this person drag?", for
 * which the presence of a mouse is the answer. Live, not read once, because a
 * tablet gains a fine pointer the moment a keyboard case is attached.
 */
export function usePointerFine(): boolean {
  const [fine, setFine] = useState(() => queryPointerFine());

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(POINTER_FINE);
    const onChange = () => setFine(mq.matches);
    mq.addEventListener("change", onChange);
    onChange();
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return fine;
}

export const POINTER_FINE = "(pointer: fine)";

/**
 * Defaults to FALSE where the query cannot be run.
 *
 * The safe direction: a device wrongly treated as touch keeps a working tap
 * flow, while a device wrongly treated as mouse gets the affordance that does
 * nothing — which is the defect itself.
 */
export function queryPointerFine(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(POINTER_FINE).matches;
}
