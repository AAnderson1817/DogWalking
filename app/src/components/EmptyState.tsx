import type { ReactNode } from "react";
import { StateField, type StateFieldTone } from "./StateField";

export function EmptyState({
  title,
  hint,
  action,
  tone = "neutral",
  label,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  tone?: StateFieldTone;
  label?: string;
}) {
  return (
    <StateField tone={tone} label={label} title={title} detail={hint} action={action} role="status" />
  );
}
