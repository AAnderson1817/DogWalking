// Bottom sheet (spec 05): mobile-first modal surface with backdrop,
// escape/backdrop dismissal, focus trap/restoration, and a drag handle affordance.
import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** Required: a dialog without an accessible name is unusable by name or
      by rotor, and every existing call site already passes one. */
  title: string;
  children: ReactNode;
}) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  // The trap must only set up / tear down on open/close. Consumers pass
  // inline onClose handlers, so keying the effect on onClose would re-run it
  // (and yank focus) on every parent re-render — e.g. each password keystroke
  // in the vault re-auth sheet. Read the latest handler through a ref instead.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // aria-modal="true" is a request, not an enforcement: without this the
    // background stayed in the accessibility tree and modal semantics rested
    // entirely on the screen reader honouring the attribute. Walk up from
    // the sheet and mark every sibling `inert`, which removes them from the
    // accessibility tree AND from hit-testing and focus. The backdrop is
    // exempt — inert would swallow the click that dismisses the sheet.
    const inerted: HTMLElement[] = [];
    for (let node: HTMLElement | null = sheetRef.current; node && node !== document.body; ) {
      const parent: HTMLElement | null = node.parentElement;
      if (!parent) break;
      for (const sibling of Array.from(parent.children)) {
        if (
          sibling !== node &&
          sibling instanceof HTMLElement &&
          !sibling.hasAttribute("inert") &&
          !sibling.hasAttribute("data-sheet-backdrop")
        ) {
          sibling.setAttribute("inert", "");
          inerted.push(sibling);
        }
      }
      node = parent;
    }

    const focusFirst = () => {
      const sheet = sheetRef.current;
      if (!sheet) return;
      const first = sheet.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? sheet).focus();
    };
    const frame = window.requestAnimationFrame(focusFirst);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const sheet = sheetRef.current;
      if (!sheet) return;
      const focusable = Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
      if (focusable.length === 0) {
        e.preventDefault();
        sheet.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey);
      // Only what this sheet set, so a nested sheet cannot un-inert the
      // background its parent is still holding.
      for (const el of inerted) el.removeAttribute("inert");
      restoreFocusRef.current?.focus();
      restoreFocusRef.current = null;
    };
  }, [open]);

  if (!open) return null;
  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} aria-hidden data-sheet-backdrop />
      <div ref={sheetRef} className="sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="sheet__handle" />
        <h2 style={{ fontSize: "var(--fs-20)", marginBottom: "var(--s-3)" }}>{title}</h2>
        {children}
      </div>
    </>
  );
}
