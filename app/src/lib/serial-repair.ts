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

/**
 * Schedules a repair for a given auth transition. Returns nothing: these are
 * best-effort by design.
 *
 * The VERSION comes from the caller and is the transition's, not the
 * scheduling moment's (Codex review on PR #85, fifteenth round). Minting it
 * here made "superseded" mean "a later repair was SCHEDULED", and the reclaim
 * is scheduled only after `resolveRole` finishes — a database round trip,
 * while a repair is two service-worker lookups. So in practice the cleanup had
 * always finished first, `superseded()` was never true, and the whole
 * stand-down was inert; the provider test hid it by resolving the role query
 * immediately.
 */
export type SerialRunner = (repair: Repair, version: number) => void;

/**
 * Two rules, and they are separate:
 *
 *   1. NEVER CONCURRENT. Each repair waits for the one before it, so no two
 *      ever hold a view of the subscription at the same time.
 *   2. LATEST WINS. Any repair that has not STARTED once a newer TRANSITION
 *      has arrived is dropped rather than applied late: applying it would act
 *      on a session that no longer exists. This also discards a repair whose
 *      transition was superseded while its role lookup was still running — a
 *      lookup begun before a sign-out can finish after it, and queueing its
 *      reclaim would make the sign-out's cleanup stand down while the previous
 *      account's subscription stayed live, which is the shared-device leak the
 *      cleanup exists to close.
 *
 *   3. AND A RUNNING ONE CAN STAND DOWN. Rule 2 alone is not enough: a
 *      sign-out's cleanup has usually started by the time a following
 *      transition is seen, and rule 2 cannot reach it (Codex review on PR
 *      #85). It unsubscribed the browser, the reclaim then found nothing to
 *      register, and the newly signed-in account was left with push silently
 *      off: the account-switch case 0049's reassigning upsert exists for,
 *      lost to the repair meant to protect it.
 *
 *      Both rules key on the TRANSITION, which is why the version is the
 *      caller's. Keyed on scheduling instead, a running cleanup only learns it
 *      was superseded once the reclaim is queued — which happens after a
 *      database round trip, long after two service-worker lookups have
 *      finished — so it never learned in time.
 *
 *      So a running repair is not INTERRUPTED — a half-applied unsubscribe is
 *      worse than a completed one — it is told, and stands down of its own
 *      accord before the irreversible step.
 *
 * A rejection never propagates: these run inside the auth transition and must
 * never stand between anyone and being signed in or out.
 */
export function createSerialRunner(currentVersion: () => number): SerialRunner {
  let chain: Promise<void> = Promise.resolve();
  return (repair, version) => {
    chain = chain
      .catch(() => {})
      .then(() =>
        version === currentVersion() ? repair(() => version !== currentVersion()) : undefined
      )
      .catch(() => {});
  };
}
