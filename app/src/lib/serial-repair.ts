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

/**
 * A repair. `superseded()` answers, at any point DURING the work, whether a
 * newer auth transition has arrived since this one was scheduled.
 *
 * Passed in rather than checked only before starting (Codex review on PR #85,
 * thirteenth round). `applyRole` awaits a database query before it queues the
 * reclaim, so a sign-out's cleanup has always STARTED by then — the pre-start
 * check can never supersede it, and the cleanup went on to unsubscribe the
 * browser before the reclaim ran, leaving the newly signed-in account with
 * push silently off. That is the account-switch case 0049's reassigning
 * upsert exists for, lost to the repair meant to protect it.
 *
 * A repair must check this immediately before anything IRREVERSIBLE — the
 * unsubscribe, the RPC — not merely at the top. Checking at the top is what
 * the runner already does.
 */
export type Repair = (superseded: () => boolean) => Promise<void>;

/** Schedules a repair. Returns nothing: these are best-effort by design. */
export type SerialRunner = (repair: Repair) => void;

/**
 * Two rules, and they are separate:
 *
 *   1. NEVER CONCURRENT. Each repair waits for the one before it, so no two
 *      ever hold a view of the subscription at the same time.
 *   2. LATEST WINS. Any repair that has not STARTED when a newer one is
 *      scheduled is dropped rather than applied late: applying it would act
 *      on a session that no longer exists.
 *
 *   3. AND A RUNNING ONE CAN STAND DOWN. Rule 2 alone is not enough, because
 *      `applyRole` awaits a database query before queueing the reclaim — so
 *      a sign-out's cleanup has always started by the time the sign-in's
 *      repair is scheduled, and rule 2 can never reach it (Codex review on PR
 *      #85). It unsubscribed the browser, the reclaim then found nothing to
 *      register, and the newly signed-in account was left with push silently
 *      off: the account-switch case 0049's reassigning upsert exists for,
 *      lost to the repair meant to protect it.
 *
 *      So a running repair is not INTERRUPTED — a half-applied unsubscribe is
 *      worse than a completed one — it is told, and stands down of its own
 *      accord before the irreversible step.
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
      .then(() => (mine === generation ? repair(() => mine !== generation) : undefined))
      .catch(() => {});
  };
}
