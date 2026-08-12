// Reusable "couldn't load — retry" card (re-review fix: the loader error
// states shipped with no retry affordance, a dead end on an installed PWA).
import { useState } from "react";
import { Button } from "./Button";
import { Spinner } from "./Spinner";
import { StateField } from "./StateField";

/** Friendlier copy for the common offline/network case. */
// oxlint-disable-next-line react/only-export-components
export function loadErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return "You appear to be offline. Check your connection and try again.";
  }
  return msg || "Something went wrong.";
}

export function LoadError({
  title = "Couldn't load",
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const offline = /offline|connection/i.test(message);
  return (
    <div className="page">
      <StateField
        tone={offline ? "information" : "attention"}
        label={offline ? "Offline" : "Needs attention"}
        title={title}
        detail={message}
        role="alert"
        action={
          <Button
            onClick={() => {
              setBusy(true);
              void Promise.resolve(onRetry()).finally(() => setBusy(false));
            }}
            disabled={busy}
          >
            {busy ? <Spinner label="Retrying" /> : "Retry"}
          </Button>
        }
      />
    </div>
  );
}
