/**
 * Service-worker update detection (review M6).
 *
 * Registration used to be one line — `navigator.serviceWorker.register("/sw.js")`
 * — with no `update()`, no `updatefound` and no `controllerchange`. A browser
 * checks for a new worker on navigation, and an installed PWA resumed from the
 * app switcher navigates rarely or never, so a walker could run a weeks-old
 * bundle against evolved edge-function contracts indefinitely, with no way to
 * find out and nothing to press.
 *
 * The update is offered, never forced. `sw.js` no longer calls `skipWaiting()`
 * at install for the same reason: taking over mid-session lets `activate` wipe
 * the cache holding the running page's chunks, so a lazy import afterwards
 * fetches a hashed file the new deploy no longer serves — a 404 in the middle
 * of a walk. Nothing changes until somebody taps.
 */

/** How often to ask the server whether a new worker exists. */
export const UPDATE_POLL_MS = 60 * 60_000;

/** The parts of ServiceWorkerRegistration this module actually uses. */
export interface RegistrationLike {
  waiting: { postMessage(msg: unknown): void } | null;
  installing: { addEventListener(type: string, fn: () => void): void; state: string } | null;
  addEventListener(type: string, fn: () => void): void;
  update(): Promise<unknown>;
}

/**
 * Whether a registration currently has a new worker parked and ready.
 *
 * Split out and named because the condition is easy to get subtly wrong in the
 * dangerous direction: `waiting` is also non-null on a FIRST install, when
 * there is no controller yet and nothing to reload into. Prompting then shows
 * a "new version" banner to somebody who just opened the app for the first
 * time.
 */
export function hasWaitingUpdate(
  registration: Pick<RegistrationLike, "waiting">,
  hasController: boolean,
): boolean {
  return hasController && registration.waiting != null;
}

export interface WatchOptions {
  /** Called when an update is parked and ready to be applied. */
  onWaiting: () => void;
  /** Test seam; defaults to the real timers. */
  setPoll?: (fn: () => void, ms: number) => unknown;
  clearPoll?: (handle: unknown) => void;
  pollMs?: number;
}

/**
 * Watch a registration for an update and report when one is ready.
 *
 * Three triggers, because no single one is sufficient: a worker already
 * waiting at page load (the common case after a background install), one that
 * finishes installing while the page is open, and a periodic re-check for the
 * installed PWA that never navigates. Returns a teardown.
 */
export function watchForUpdate(
  registration: RegistrationLike,
  hasController: () => boolean,
  options: WatchOptions,
): () => void {
  const { onWaiting } = options;
  const setPoll = options.setPoll ?? ((fn, ms) => setInterval(fn, ms));
  const clearPoll = options.clearPoll ?? ((h) => clearInterval(h as number));

  const report = () => {
    if (hasWaitingUpdate(registration, hasController())) onWaiting();
  };

  report();

  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener("statechange", () => {
      // `installed` with a controller present means "ready and waiting".
      // Without the controller check this fires on the very first install.
      if (installing.state === "installed") report();
    });
  });

  const handle = setPoll(() => void registration.update(), options.pollMs ?? UPDATE_POLL_MS);
  return () => clearPoll(handle);
}

/**
 * Apply a waiting update: tell it to take over, then reload once it has.
 *
 * The reload is gated on a flag rather than firing for any `controllerchange`.
 * Another tab accepting an update also changes this page's controller, and
 * reloading a walk out from under an operator because a second tab was tidied
 * up would be a worse bug than the stale bundle.
 */
export function applyUpdate(
  registration: Pick<RegistrationLike, "waiting">,
  container: { addEventListener(type: string, fn: () => void): void },
  reload: () => void,
): void {
  const waiting = registration.waiting;
  if (!waiting) return;
  let reloaded = false;
  container.addEventListener("controllerchange", () => {
    if (reloaded) return;
    reloaded = true;
    reload();
  });
  waiting.postMessage({ type: "SKIP_WAITING" });
}
