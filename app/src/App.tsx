// Route table (spec 06).
import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import { BottomNav } from "@/components/BottomNav";
import { OperatorShell } from "@/components/OperatorShell";
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

function operator(el: React.ReactNode) {
  return (
    <RequireRole role="operator">
      <OperatorShell>{el}</OperatorShell>
    </RequireRole>
  );
}

// Walk Mode owns the full viewport — no nav chrome.
function operatorBare(el: React.ReactNode) {
  return <RequireRole role="operator">{el}</RequireRole>;
}

function portal(el: React.ReactNode) {
  return (
    <RequireRole role="client">
      {el}
      <BottomNav persona="client" />
    </RequireRole>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/signin" element={<SignIn />} />
      <Route path="/onboard" element={<Onboard />} />
      <Route path="/claim/:token" element={<ClaimInvite />} />

      <Route path="/" element={operator(<Dashboard />)} />
      <Route path="/calendar" element={operator(<Calendar />)} />
      <Route path="/roster" element={operator(<Roster />)} />
      <Route path="/clients/:id" element={operator(<ClientDetail />)} />
      <Route path="/walks/:id/live" element={operatorBare(<WalkMode />)} />
      <Route path="/vault" element={operator(<AccessVault />)} />
      <Route path="/billing" element={operator(<BillingConsole />)} />

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

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
