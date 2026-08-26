import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ConfigError } from "@/components/ConfigError";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { UpdatePrompt } from "@/components/UpdatePrompt";
import { AuthProvider } from "@/lib/auth-context";
import { missingEnvKeys } from "@/lib/env";
import App from "@/App";
import "@/styles/global.css";

// Service worker (phase 08): production builds only — dev stays uncached.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}

// Review H22. `env.ts` used to throw from a getter, and `supabase.ts` reads it
// at module-evaluation time — so the throw happened while this file's own
// imports were still being evaluated, before `createRoot` ran and therefore
// before `ErrorBoundary` could catch anything. Blank page, no error surface.
//
// Nothing throws now, so the check is reachable here and the branch is
// explicit. The panel is rendered INSTEAD of the app rather than inside the
// boundary: a client pointed at `https://unconfigured.invalid` would otherwise
// spend the session failing one request at a time.
const missing = missingEnvKeys();
const root = createRoot(document.getElementById("root")!);

if (missing.length > 0) {
  root.render(
    <StrictMode>
      <ConfigError missing={missing} />
    </StrictMode>,
  );
} else {
  root.render(
    <StrictMode>
      <ErrorBoundary>
        {/* react-router 7 (review M41). `v7_startTransition` and
            `v7_relativeSplatPath` were the only two behavioural changes it
            makes to this app; both were turned on as opt-in flags under 6 and
            the whole suite run green before the version moved, so a
            regression could not have two places to have come from. They are
            defaults in 7, so the flags are gone rather than kept as no-ops. */}
        <BrowserRouter>
          <AuthProvider>
            <App />
            {/* Review M6. Outside <App> so it survives every route, and
                inside the router because it is part of the shell, not of a
                screen. */}
            <UpdatePrompt />
          </AuthProvider>
        </BrowserRouter>
      </ErrorBoundary>
    </StrictMode>,
  );
}
