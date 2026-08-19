/**
 * How long a revealed credential stays on screen (review M14).
 *
 * Thirty seconds with no way to extend is tight for the job this feature
 * exists to do: a door code, read off a phone, in gloves, at a keypad, in the
 * cold — and considerably worse with a motor or cognitive disability, or with
 * magnification, where reading the screen and reaching the keypad are two
 * separate operations.
 *
 * When it expired the operator had to start the entire cycle again: re-auth,
 * type a purpose, reveal. That is not merely annoying — it writes ANOTHER
 * `credential_access_log` row, so the trail H3 built to make a real intrusion
 * visible fills with repeated reads of the same door minutes apart, which is
 * exactly the shape a real intrusion has.
 *
 * So extending is a first-class action, and deliberately does NOT write a new
 * audit row: it is the same read, by the same person, for the purpose they
 * already gave, still standing at the same door. A row per extension would
 * make the log less able to answer its own question.
 */

/** Seconds a reveal is visible before it clears. */
export const REVEAL_SECONDS = 30;

/**
 * How many times one reveal may be extended.
 *
 * Bounded, because the point of the timer is that a code does not sit on an
 * unattended screen — an unlimited "keep showing" is the timer removed with
 * extra steps. Three extensions is 120 s total: long enough for a keypad that
 * needs two attempts, short enough that a phone put down mid-entry still
 * clears while the operator is on the doorstep rather than in the van.
 */
export const MAX_EXTENSIONS = 3;

export interface RevealTimer {
  /** Seconds left before the code clears. */
  countdown: number;
  /** Extensions already used for THIS reveal. */
  extensions: number;
}

export function startReveal(): RevealTimer {
  return { countdown: REVEAL_SECONDS, extensions: 0 };
}

export function canExtend(timer: RevealTimer): boolean {
  return timer.extensions < MAX_EXTENSIONS;
}

/**
 * Extend, if allowed. Returns the timer unchanged when the cap is reached, so
 * a caller cannot accidentally grant an unbounded reveal by not checking.
 */
export function extendReveal(timer: RevealTimer): RevealTimer {
  if (!canExtend(timer)) return timer;
  return { countdown: REVEAL_SECONDS, extensions: timer.extensions + 1 };
}

/** One second of the countdown. `null` means the code has cleared. */
export function tickReveal(timer: RevealTimer): RevealTimer | null {
  if (timer.countdown <= 1) return null;
  return { ...timer, countdown: timer.countdown - 1 };
}

/**
 * Whether this second should be announced to a screen reader.
 *
 * Not every tick: an assertive stream of numbers is unusable, and a polite
 * region that updates every second is only marginally better. One warning at
 * ten seconds, then the last five.
 */
export function shouldAnnounce(countdown: number): boolean {
  return countdown === 10 || countdown <= 5;
}
