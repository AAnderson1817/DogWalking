/**
 * Resolve with the promise's value, or with null once `ms` has passed.
 *
 * Its own module because two unrelated callers need it and neither should
 * import the other: `push.ts` bounds the service-worker probes (a worker that
 * never activates must not leave a spinner where a switch belongs), and
 * `auth-context.tsx` bounds the sign-out cleanup (Codex review on PR #85 — a
 * promise that never SETTLES is not a rejection, so a stalled unsubscribe left
 * somebody signed in on a shared device with the button doing nothing).
 *
 * Never rejects: a rejection resolves to null like a timeout, because every
 * caller here is bounding best-effort work whose failure is not the caller's
 * problem to re-raise.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}
