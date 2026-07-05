// Custom PWA install prompt (phase 08): surfaces on the Dashboard from the
// second visit once the browser offers beforeinstallprompt.
import { useEffect, useState } from "react";
import { Button } from "./Button";
import { Card } from "./Card";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const VISITS_KEY = "pawtrail-visits";
const DISMISSED_KEY = "pawtrail-install-dismissed";

export function countVisit(): number {
  const n = Number(localStorage.getItem(VISITS_KEY) ?? "0") + 1;
  localStorage.setItem(VISITS_KEY, String(n));
  return n;
}

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [eligible, setEligible] = useState(false);

  useEffect(() => {
    const visits = countVisit();
    if (visits < 2 || localStorage.getItem(DISMISSED_KEY)) return;
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setEligible(true);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  if (!eligible || !deferred) return null;

  return (
    <Card
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--s-3)",
        background: "var(--pine-900)",
        color: "#EDF5F1",
        marginTop: "var(--s-4)",
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700 }}>Put PawTrail on your home screen</div>
        <div style={{ fontSize: "var(--fs-14)", opacity: 0.8 }}>
          One tap to walk mode — works offline mid-walk.
        </div>
      </div>
      <Button
        variant="accent"
        onClick={() => {
          void deferred.prompt().then(() => setEligible(false));
        }}
      >
        Install
      </Button>
      <button
        aria-label="Dismiss"
        onClick={() => {
          localStorage.setItem(DISMISSED_KEY, "1");
          setEligible(false);
        }}
        style={{ background: "none", border: 0, color: "#9DB8AE", cursor: "pointer" }}
      >
        ✕
      </button>
    </Card>
  );
}
