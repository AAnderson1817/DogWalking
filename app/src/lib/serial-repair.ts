// One-at-a-time, latest-wins scheduling for the push repairs (Codex review on
// PR #85).
//
// `forgetPushDeviceOnSignedOut` and `reclaimPushDevice` are opposites — one
// unsubscribes this browser, the other re-registers it — and both begin by
// reading `pushManager.getSubscription()`. Run concurrently, either completion
// order is wrong: the cleanup can unsubscribe the endpoint the new account
// just registered, or the reclaim can register one the cleanup is about to
// invalidate. `getSession()` and `onAuthStateChange` both drive the auth
// transition independently, which is where the overlap came from.
//
// Extracted rather than left inline in `AuthProvider` because the second rule
// below cannot be exercised through the provider at all: `applyRole` is async,
// so a sign-out's repair always STARTS before a following sign-in's is queued.
// A test written against the provider therefore asserts the first rule and
// silently proves nothing about the second — which is what the first draft of
// that test did.

/** Schedules a repair. Returns nothing: these are best-effort by design. */
export type SerialRunner = (repair: () => Promise<void>) => void;

/**
 * Two rules, and they are separate:
 *
 *   1. NEVER CONCURRENT. Each repair waits for the one before it, so no two
 *      ever hold a view of the subscription at the same time.
 *   2. LATEST WINS. Any repair that has not STARTED when a newer one is
 *      scheduled is dropped rather than applied late — including one
 *      scheduled in the same tick, which is the case that matters: a
 *      sign-out immediately superseded by a sign-in should reassign this
 *      device to the new account, not unsubscribe it first and leave that
 *      account with push silently off. Applying a superseded repair acts on
 *      a session that no longer exists.
 *
 *      A repair already RUNNING is not interrupted; there is nothing to
 *      interrupt it with, and a half-applied unsubscribe is worse than a
 *      completed one.
 *
 * A rejection never propagates: these run inside the auth transition and must
 * never stand between anyone and being signed in or out.
 */
export function createSerialRunner(): SerialRunner {
  let generation = 0;
  let chain: Promise<void> = Promise.resolve();
  return (repair) => {
    const mine = ++generation;
    chain = chain
      .catch(() => {})
      .then(() => (mine === generation ? repair() : undefined))
      .catch(() => {});
  };
}
