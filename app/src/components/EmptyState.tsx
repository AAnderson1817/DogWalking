import type { ReactNode } from "react";

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <p className="empty-state__title">{title}</p>
      {hint && <p style={{ marginTop: "var(--s-2)" }}>{hint}</p>}
      {action && <div style={{ marginTop: "var(--s-4)" }}>{action}</div>}
    </div>
  );
}
