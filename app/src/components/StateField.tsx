import type { ReactNode } from "react";
import { Spinner } from "./Spinner";

export type StateFieldTone = "neutral" | "information" | "attention" | "success";

export function StateField({
  tone = "neutral",
  label,
  title,
  detail,
  action,
  compact = false,
  role,
}: {
  tone?: StateFieldTone;
  label?: string;
  title: string;
  detail?: string;
  action?: ReactNode;
  compact?: boolean;
  role?: "status" | "alert";
}) {
  return (
    <section
      className={`state-field state-field--${tone}${compact ? " state-field--compact" : ""}`}
      role={role}
      aria-live={role === "alert" ? "assertive" : role ? "polite" : undefined}
    >
      <div className="state-field__copy">
        {label && <span className="state-field__label">{label}</span>}
        <p className="state-field__title">{title}</p>
        {detail && <p className="state-field__detail">{detail}</p>}
      </div>
      {action && <div className="state-field__action">{action}</div>}
    </section>
  );
}

export function LoadingState({
  label = "Loading your workspace",
  compact = false,
}: {
  label?: string;
  compact?: boolean;
}) {
  return (
    <div className={`loading-state${compact ? " loading-state--compact" : ""}`} role="status" aria-live="polite">
      <Spinner label={label} decorative />
      <span>{label}</span>
      {!compact && <span className="loading-state__detail">This should only take a moment.</span>}
    </div>
  );
}
