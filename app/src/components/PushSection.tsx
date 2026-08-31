// Push opt-in, for both personas (review M27).
//
// One component rather than two: the decision is identical, and the only
// difference between an operator and a client here is which screen it sits on.
// The RPC resolves the persona itself, so nothing in this file knows or cares.
import { useCallback, useEffect, useRef, useState } from "react";
import { FormError } from "@/components/fields";
import {
  canToggle,
  disablePush,
  enablePush,
  type PushState,
  pushState,
  readPushEnvironment,
} from "@/lib/push";

/** What each state says, and — where it matters — whose problem it is. */
const EXPLANATION: Record<PushState, string> = {
  on: "This device will show a notification when something needs you.",
  off: "Get a notification on this device when something needs you.",
  denied:
    "Notifications are blocked for this site in your browser. You can turn them back on in your browser's site settings — this switch cannot.",
  unsupported:
    "This browser cannot show push notifications. On an iPhone, add Sanpo to your Home Screen first.",
  unconfigured: "Push notifications are not set up for this installation yet.",
  "stale-worker":
    "An app update is ready. Reload to finish it, then you can turn notifications on — until then this device could not show them.",
};

export function PushSection({ heading = "Notifications" }: { heading?: string }) {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(pushState(await readPushEnvironment()));
    } catch {
      // Reading the environment is not something a person can act on, and a
      // hard failure here would replace a working page with an error. Report
      // the state we can least wrongly claim.
      setState("unsupported");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      setState(state === "on" ? await disablePush() : await enablePush());
      headingRef.current?.focus();
    } catch (e) {
      // The browser's own words where there are any: "Registration failed -
      // push service error" is more use than a sentence we invent.
      setError(e instanceof Error ? e.message : "Could not change notification settings.");
      // Re-read rather than assume: a failed subscribe can still have left a
      // permission decision behind, and showing the old state would make the
      // switch look broken on the next press.
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section" aria-labelledby="settings-push">
      <h2 id="settings-push" tabIndex={-1} ref={headingRef}>{heading}</h2>
      {/* Mounted before its text arrives and out of flow when empty — a live
          region that appears together with its content is announced far less
          reliably (the FormError rule from a11y(vault+errors)). */}
      <FormError message={error} />
      {state === null
        ? <p className="text-secondary">Checking…</p>
        : (
          <>
            <p className="text-secondary">{EXPLANATION[state]}</p>
            {canToggle(state) && (
              <button
                type="button"
                className={state === "on" ? "btn btn--ghost" : "btn"}
                onClick={() => void toggle()}
                disabled={busy}
              >
                {busy
                  ? "Working…"
                  : state === "on"
                  ? "Turn off on this device"
                  : "Turn on for this device"}
              </button>
            )}
          </>
        )}
    </section>
  );
}
