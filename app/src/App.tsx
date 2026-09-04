// Route table (spec 06).
import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import { AppMain } from "@/components/AppMain";
import { OperatorShell } from "@/components/OperatorShell";
import { PortalShell } from "@/components/PortalShell";
import { RequireRole } from "@/components/RequireRole";
import SignIn from "@/screens/SignIn";
import Signup from "@/screens/Signup";
import Pricing from "@/screens/Pricing";
import Onboard from "@/screens/Onboard";
import ClaimInvite from "@/screens/ClaimInvite";
import Legal from "@/screens/Legal";
import Dashboard from "@/screens/Dashboard";
import Calendar from "@/screens/Calendar";
import Roster from "@/screens/Roster";
import ClientDetail from "@/screens/ClientDetail";
import WalkMode from "@/screens/WalkMode";
import AccessVault from "@/screens/AccessVault";
import BillingConsole from "@/screens/BillingConsole";
import Settings from "@/screens/Settings";
import PortalHome from "@/screens/PortalHome";
import Booking from "@/screens/Booking";
import PortalWalks from "@/screens/PortalWalks";
import WalkDetail from "@/screens/WalkDetail";
import PortalBilling from "@/screens/PortalBilling";
import PetProfiles from "@/screens/PetProfiles";
import NotFound from "@/screens/NotFound";
import ResetPassword from "@/screens/ResetPassword";

// Dev-only component gallery; the statically-false DEV guard removes both
// the route and the chunk from production builds (verified in build output).
const DevKit = import.meta.env.DEV ? lazy(() => import("@/screens/DevKit")) : null;
const InboxPreview = import.meta.env.DEV ? lazy(() => import("@/prototypes/InboxPreview")) : null;
const TodayPreview = import.meta.env.DEV ? lazy(() => import("@/prototypes/TodayPreview")) : null;
const CalendarWeekPreview = import.meta.env.DEV
  ? lazy(() => import("@/screens/CalendarWeekPreview"))
  : null;

function operator(el: React.ReactNode) {
  return (
    <RequireRole role="operator">
      <OperatorShell>{el}</OperatorShell>
    </RequireRole>
  );
}

// Walk Mode owns the full viewport — no nav chrome, but still a landmark.
// deferLock: the subscription gate must never interrupt a walk in progress
// (see RequireRole) — the lock lands on the next navigation instead.
function operatorBare(el: React.ReactNode) {
  return (
    <RequireRole role="operator" deferLock>
      <AppMain>{el}</AppMain>
    </RequireRole>
  );
}

function portal(el: React.ReactNode) {
  return (
    <RequireRole role="client">
      <PortalShell>{el}</PortalShell>
    </RequireRole>
  );
}

// Signed-out routes have no chrome to skip past, but still need the landmark.
function publicRoute(el: React.ReactNode) {
  return <AppMain>{el}</AppMain>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/signin" element={publicRoute(<SignIn />)} />
      {/* The explicit operator front door + the page that states the price
          (review H31). Public: both exist for people with no account yet. */}
      <Route path="/signup" element={publicRoute(<Signup />)} />
      <Route path="/pricing" element={publicRoute(<Pricing />)} />
      <Route path="/onboard" element={publicRoute(<Onboard />)} />
      <Route path="/claim/:token" element={publicRoute(<ClaimInvite />)} />
      {/* Review L16. Public and NOT behind RequireRole: the recovery link
          creates a session, but a role lookup that fails or is slow must not
          stand between somebody and the password they are here to set. */}
      <Route path="/reset-password" element={publicRoute(<ResetPassword />)} />
      {/* Review H6. Public: the people who most need the privacy notice are the
          ones who have NOT signed in — somebody who got an email they did not
          expect, or who is deciding whether to claim an invite at all. */}
      <Route path="/legal/:slug" element={publicRoute(<Legal />)} />

      <Route path="/" element={operator(<Dashboard />)} />
      <Route path="/calendar" element={operator(<Calendar />)} />
      <Route path="/roster" element={operator(<Roster />)} />
      <Route path="/clients/:id" element={operator(<ClientDetail />)} />
      <Route path="/walks/:id/live" element={operatorBare(<WalkMode />)} />
      <Route path="/vault" element={operator(<AccessVault />)} />
      <Route path="/billing" element={operator(<BillingConsole />)} />
      {/* Reached from Money rather than the nav: the four-item operator
          navigation is a locked brand decision (Today / Calendar / Clients /
          Money), and adding a fifth is a deliberate act, not a side effect of
          shipping a settings screen. */}
      <Route path="/settings" element={operator(<Settings />)} />

      <Route path="/portal" element={portal(<PortalHome />)} />
      <Route path="/portal/book" element={portal(<Booking />)} />
      <Route path="/portal/walks" element={portal(<PortalWalks />)} />
      <Route path="/portal/walks/:id" element={portal(<WalkDetail />)} />
      <Route path="/portal/billing" element={portal(<PortalBilling />)} />
      <Route path="/portal/pets" element={portal(<PetProfiles />)} />

      {DevKit && (
        <Route
          path="/dev/kit"
          element={
            <Suspense fallback={null}>
              <DevKit />
            </Suspense>
          }
        />
      )}

      {InboxPreview && (
        <Route
          path="/dev/inbox"
          element={
            <Suspense fallback={null}>
              <InboxPreview />
            </Suspense>
          }
        />
      )}

      {TodayPreview && (
        <Route
          path="/dev/today"
          element={
            <Suspense fallback={null}>
              <TodayPreview />
            </Suspense>
          }
        />
      )}

      {CalendarWeekPreview && (
        <Route
          path="/dev/calendar"
          element={
            <Suspense fallback={null}>
              <CalendarWeekPreview />
            </Suspense>
          }
        />
      )}

      <Route path="*" element={publicRoute(<NotFound />)} />
    </Routes>
  );
}
