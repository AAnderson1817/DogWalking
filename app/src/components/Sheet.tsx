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
  title?: string;
  children: ReactNode;
}) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusFirst = () => {
      const sheet = sheetRef.current;
      if (!sheet) return;
      const first = sheet.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? sheet).focus();
    };
    const frame = window.requestAnimationFrame(focusFirst);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
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
      restoreFocusRef.current?.focus();
      restoreFocusRef.current = null;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} aria-hidden />
      <div ref={sheetRef} className="sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="sheet__handle" />
        {title && (
          <h2 style={{ fontSize: "var(--fs-20)", marginBottom: "var(--s-3)" }}>{title}</h2>
        )}
        {children}
      </div>
    </>
  );
}
