// Route guard (spec 06): unauthenticated → /signin; wrong persona → own
// home; authenticated with no persona row yet → /onboard. For operators,
// also the subscription gate (review H31): trial over with no live Sanpo
// subscription renders the subscribe wall IN PLACE, past_due renders a
// banner above the app.
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth, type Role } from "@/lib/auth-context";
import { operatorAccess } from "@/lib/operator-access";
import { BillingGraceBanner, BillingLocked } from "./BillingLocked";
import { LoadError } from "./LoadError";
import { LoadingState } from "./StateField";

export function RequireRole({ role, children }: { role: Exclude<Role, null>; children: ReactNode }) {
  const auth = useAuth();
  const location = useLocation();

  if (auth.loading) {
    return (
      <div className="page">
        <LoadingState label="Loading your account" />
      </div>
    );
  }
  if (!auth.session) {
    return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
  }
  // A resolved role wins over a stale error flag from a concurrent attempt.
  if (auth.roleError && auth.role === null) {
    // Resolution failed rather than resolving to "no persona" — never send a
    // signed-in user to onboarding on a transient error.
    return (
      <LoadError
        title="Couldn't load your account"
        message="Check your connection and try again."
        onRetry={async () => {
          await auth.refreshRole();
        }}
      />
    );
  }
  if (auth.role === null) {
    return <Navigate to="/onboard" replace />;
  }
  if (auth.role !== role) {
    return <Navigate to={auth.role === "operator" ? "/" : "/portal"} replace />;
  }
  // The subscription gate, AFTER role resolution succeeded and ONLY for the
  // operator persona — this same component guards portal routes, and a pet
  // owner must never be locked out of walks they paid their walker for
  // because the walker's own Sanpo bill failed. operatorAccess fails OPEN on
  // anything unreadable, so a transient blip can never masquerade as a
  // lapsed subscription (the roleError lesson, applied to billing).
  if (role === "operator") {
    const access = operatorAccess(auth.operatorBilling, Date.now());
    if (access === "locked") return <BillingLocked />;
    if (access === "grace") {
      return (
        <>
          <BillingGraceBanner />
          {children}
        </>
      );
    }
  }
  return <>{children}</>;
}
