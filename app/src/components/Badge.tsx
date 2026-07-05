// Status badge (spec 05 colors: scheduled=mist, in_progress=teal,
// completed=pine-600, cancelled=faint, overage=amber).
import type { ReactNode } from "react";

export type BadgeStatus =
  | "scheduled"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "no_show"
  | "overage"
  | "warn"
  | "neutral";

const LABELS: Record<BadgeStatus, string> = {
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
  overage: "Overage",
  warn: "Attention",
  neutral: "—",
};

export function Badge({ status, children }: { status: BadgeStatus; children?: ReactNode }) {
  return <span className={`badge badge--${status}`}>{children ?? LABELS[status]}</span>;
}
