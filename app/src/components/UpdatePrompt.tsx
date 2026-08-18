import { useEffect, useState } from "react";
import { Button } from "./Button";
import { applyUpdate, watchForUpdate, type RegistrationLike } from "@/lib/sw-update";

/**
 * Offers a waiting service-worker update (review M6).
 *
 * Offers, rather than applies. The operator may be mid-walk with GPS
 * recording, and a reload they did not ask for is worse than a bundle that is
 * a day old. Dismissible, and the next poll brings it back.
 */
export function UpdatePrompt() {
  const [ready, setReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let stop: (() => void) | undefined;
    let cancelled = false;

    void navigator.serviceWorker.ready.then((registration) => {
      if (cancelled) return;
      stop = watchForUpdate(
        registration as unknown as RegistrationLike,
        () => navigator.serviceWorker.controller != null,
        { onWaiting: () => setReady(true) },
      );
    });

    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  if (!ready || dismissed) return null;

  return (
    <div className="update-prompt" role="status">
      <span className="update-prompt__text">A new version of Sanpo is ready.</span>
      <span className="update-prompt__actions">
        <Button
          onClick={() => {
            void navigator.serviceWorker.ready.then((registration) => {
              applyUpdate(
                registration as unknown as RegistrationLike,
                navigator.serviceWorker,
                () => window.location.reload(),
              );
            });
          }}
        >
          Reload
        </Button>
        <Button variant="ghost" onClick={() => setDismissed(true)}>
          Later
        </Button>
      </span>
    </div>
  );
}
