// Styled empty state used by every not-yet-built route (phase 02 deliverable
// 5) so the shell navigates end-to-end before real screens land.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export function PlaceholderScreen({
  title,
  phase,
  children,
}: {
  title: string;
  phase: string;
  children?: ReactNode;
}) {
  return (
    <div className="page">
      <h1>{title}</h1>
      <div
        style={{
          marginTop: "var(--s-4)",
          background: "var(--surface)",
          borderRadius: "var(--r-lg)",
          boxShadow: "var(--shadow-1)",
          padding: "var(--s-8) var(--s-4)",
          textAlign: "center",
        }}
      >
        <span
          className="section-label"
          style={{ display: "block", marginBottom: "var(--s-2)" }}
        >
          On the trail
        </span>
        <p style={{ color: "var(--text-2)" }}>
          This screen arrives in phase {phase}.
        </p>
        {children}
        <p style={{ marginTop: "var(--s-4)" }}>
          <Link to="/" style={{ color: "var(--pine-600)" }}>
            Back to Dashboard
          </Link>
        </p>
      </div>
    </div>
  );
}
