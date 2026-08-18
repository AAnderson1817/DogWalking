// Keep the screen awake while a walk is recording (review H7).
//
// The real workflow is: tap START WALK, put the phone in a pocket, walk the dog
// for thirty minutes. On iOS Safari and Android Chrome `watchPosition` stops
// delivering fixes once the page is backgrounded or the screen locks, and it
// stops silently — no error, so nothing on screen changes and the trail simply
// resumes wherever the device wakes up. A screen wake lock is the only thing a
// web app can do about it.
//
// It is a mitigation, not a fix. The lock is released by the OS whenever the
// page is hidden (a call, a notification, the operator switching apps), which
// is why it is re-requested on `visibilitychange` rather than acquired once.
// A locked-screen field test on real hardware is still the thing that decides
// whether this platform can carry the feature at all — see docs/spec/00.
import { useCallback, useEffect, useState } from "react";

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
}

interface WakeLockLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

function wakeLockApi(): WakeLockLike | null {
  const nav = navigator as Navigator & { wakeLock?: WakeLockLike };
  return nav.wakeLock ?? null;
}

export interface WakeLockState {
  /** The browser exposes the API at all (Safari < 16.4 and Firefox do not). */
  supported: boolean;
  /** A sentinel is currently held. */
  held: boolean;
}

export function useWakeLock(active: boolean): WakeLockState {
  const [supported] = useState(() => wakeLockApi() !== null);
  const [held, setHeld] = useState(false);

  const request = useCallback(async (): Promise<WakeLockSentinelLike | null> => {
    const api = wakeLockApi();
    if (!api) return null;
    try {
      const sentinel = await api.request("screen");
      // The OS can drop it without us asking — reflect that rather than
      // reporting a lock that is not held.
      sentinel.addEventListener("release", () => setHeld(false));
      setHeld(true);
      return sentinel;
    } catch {
      // Denied, or the document was already hidden. Not fatal: the walk still
      // records while the screen is on.
      setHeld(false);
      return null;
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let sentinel: WakeLockSentinelLike | null = null;

    const acquire = async () => {
      if (disposed || document.visibilityState !== "visible") return;
      if (sentinel && !sentinel.released) return;
      sentinel = await request();
      if (disposed && sentinel && !sentinel.released) void sentinel.release();
    };

    void acquire();
    // Re-acquire on every return to the foreground: the OS releases the
    // sentinel when the page is hidden, so without this the lock survives
    // exactly one app switch and then never comes back for the rest of the
    // walk — the failure being silent, as ever.
    const onVisible = () => void acquire();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (sentinel && !sentinel.released) void sentinel.release();
      setHeld(false);
    };
  }, [active, request]);

  return { supported, held };
}
