// Bottom sheet (spec 05): mobile-first modal surface with backdrop,
// escape/backdrop dismissal, and a drag handle affordance.
import { useEffect, type ReactNode } from "react";

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
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} aria-hidden />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet__handle" />
        {title && (
          <h2 style={{ fontSize: "var(--fs-20)", marginBottom: "var(--s-3)" }}>{title}</h2>
        )}
        {children}
      </div>
    </>
  );
}
