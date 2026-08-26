// Route table (spec 06).
import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import { AppMain } from "@/components/AppMain";
import { OperatorShell } from "@/components/OperatorShell";
import { PortalShell } from "@/components/PortalShell";
import { RequireRole } from "@/components/RequireRole";
import SignIn from "@/screens/SignIn";
import Onboard from "@/screens/Onboard";
import ClaimInvite from "@/screens/ClaimInvite";
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

// Dev-only component gallery; the statically-false DEV guard removes both
// the route and the chunk from production builds (verified in build output).
const DevKit = import.meta.env.DEV ? lazy(() => import("@/screens/DevKit")) : null;
const InboxPreview = import.meta.env.DEV ? lazy(() => import("@/screens/InboxPreview")) : null;
const TodayPreview = import.meta.env.DEV ? lazy(() => import("@/screens/TodayPreview")) : null;
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
function operatorBare(el: React.ReactNode) {
  return (
    <RequireRole role="operator">
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
      <Route path="/onboard" element={publicRoute(<Onboard />)} />
      <Route path="/claim/:token" element={publicRoute(<ClaimInvite />)} />

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
