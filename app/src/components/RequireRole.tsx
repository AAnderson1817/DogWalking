// Route guard (spec 06): unauthenticated → /signin; wrong persona → own
// home; authenticated with no persona row yet → /onboard.
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth, type Role } from "@/lib/auth-context";

export function RequireRole({ role, children }: { role: Exclude<Role, null>; children: ReactNode }) {
  const auth = useAuth();
  const location = useLocation();

  if (auth.loading) {
    return (
      <div className="page" style={{ display: "grid", placeItems: "center" }}>
        <span className="pulse-live" aria-label="loading" />
      </div>
    );
  }
  if (!auth.session) {
    return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
  }
  if (auth.role === null) {
    return <Navigate to="/onboard" replace />;
  }
  if (auth.role !== role) {
    return <Navigate to={auth.role === "operator" ? "/" : "/portal"} replace />;
  }
  return <>{children}</>;
}
