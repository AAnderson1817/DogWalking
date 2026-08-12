// Status badge. Visible labels remain the primary state cue; CT-1 semantic
// color roles provide a consistent secondary cue without changing the text.
import type { ReactNode } from "react";

export type BadgeStatus =
  | "scheduled"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "no_show"
  | "overage"
  | "attention"
  | "neutral"
  | "critical";

const LABELS: Record<BadgeStatus, string> = {
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Complete",
  cancelled: "Cancelled",
  no_show: "No-show",
  overage: "Overage",
  attention: "Attention",
  neutral: "Inactive",
  critical: "Critical",
};

export function Badge({ status, children }: { status: BadgeStatus; children?: ReactNode }) {
  return <span className={`badge badge--${status}`}>{children ?? LABELS[status]}</span>;
}
