/**
 * How long a walk session is allowed to run unattended (review M28).
 *
 * A walk had no time bound of any kind. `complete-walk` was the only exit from
 * `in_progress`, so an operator who forgot to press END WALK — or whose phone
 * died, or who swiped the tab away — left a walk recording GPS for as long as
 * the app stayed open, and the route kept growing while they drove home. That
 * distance is printed on the client's report card as proof of service.
 *
 * The bound is two-stage on purpose, and neither stage completes the walk.
 *
 *  1. `prompt` — the operator is ASKED. This is the stage that fixes the
 *     ordinary case (a forgotten END WALK on a walk that really did finish),
 *     and it must not stop anything, because a genuinely long walk is a normal
 *     thing and confiscating the GPS from someone still on it would be a new
 *     defect wearing the old one's clothes.
 *
 *  2. `cap` — the prompt has gone unanswered for a further grace period, so
 *     nobody is looking at the phone. GPS emission stops. The walk stays
 *     `in_progress` and every point already recorded is kept: the trail simply
 *     ends where the evidence for it ended. That under-reports, which is the
 *     direction H7 already committed to — leaving out a stretch nobody was
 *     watching is honest, and inventing one is not.
 *
 * Completing is deliberately not one of the stages, here or in the nightly
 * sweep. Completing means BILLING, and a duration invented by a timer is not
 * something to charge a client for.
 */

/** Grace beyond the booked duration before the operator is asked. */
export const OVERRUN_GRACE_MS = 30 * 60_000;

/** Further grace, after the prompt, before GPS emission stops. */
export const OVERRUN_CAP_MS = 30 * 60_000;

/**
 * Used when the booked duration is unknown — the offline resume path restores
 * the walk from a local snapshot and has no way to read `service_types`.
 *
 * 60 rather than the 30 of the default service: with the duration unknown the
 * only wrong answer that costs anything is the one that prompts too early, on
 * a walk that is running perfectly normally.
 */
export const FALLBACK_DURATION_MINUTES = 60;

export interface WalkSessionInput {
  /** `walks.started_at`, ISO. Null before the walk starts. */
  startedAt: string | null;
  /** `service_types.duration_minutes` for this walk, if known. */
  durationMinutes: number | null | undefined;
  /** Epoch ms; the screen already ticks this once a second. */
  now: number;
  /** Epoch ms of the operator's last "still walking", if any. */
  snoozedAt: number | null;
}

export interface WalkSessionBound {
  /** Epoch ms at which the operator is asked whether they are still walking. */
  promptAt: number;
  /** Epoch ms at which GPS emission stops if the prompt goes unanswered. */
  capAt: number;
  /** The prompt is due and has not been answered since. */
  prompting: boolean;
  /** The prompt went unanswered long enough that recording has stopped. */
  capped: boolean;
}

/**
 * A walk that has not started has no bound at all. Returning null rather than
 * a bound in the far future keeps callers from having to know that.
 */
export function walkSessionBound(input: WalkSessionInput): WalkSessionBound | null {
  const { startedAt, durationMinutes, now, snoozedAt } = input;
  if (!startedAt) return null;
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return null;

  // A non-positive or absent duration means the same thing to us as an unknown
  // one: there is no booked length to measure against. `duration_minutes` has
  // a `> 0` CHECK, so this is defence rather than an expected case.
  const minutes =
    typeof durationMinutes === "number" && durationMinutes > 0
      ? durationMinutes
      : FALLBACK_DURATION_MINUTES;

  // Snoozing restarts the clock from the moment the operator answered, NOT
  // from the start of the walk — otherwise a walk already past its bound would
  // re-prompt on the next tick and the button would do nothing.
  const base = snoozedAt ?? started;
  const promptAt = snoozedAt
    ? base + OVERRUN_GRACE_MS
    : base + minutes * 60_000 + OVERRUN_GRACE_MS;
  const capAt = promptAt + OVERRUN_CAP_MS;

  return {
    promptAt,
    capAt,
    prompting: now >= promptAt,
    capped: now >= capAt,
  };
}
