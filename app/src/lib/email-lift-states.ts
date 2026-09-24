// The answers of 0054's decision and lift, with no imports, so the parity
// test that reads them out of the migration (scripts/email-lift-states.test.ts)
// can load this without the Supabase client.

/**
 * Whether email to the calling client's contact address is off, and whether
 * they can turn it back on from this session. The states are the server's
 * `fn_email_lift_decision`, in the order it decides them.
 */
export const EMAIL_LIFT_STATES = [
  "no_address",
  "not_suppressed",
  "not_liftable",
  "not_login_address",
  "not_confirmed",
  "needs_link_sign_in",
  "ready",
] as const;
export type EmailLiftState = (typeof EMAIL_LIFT_STATES)[number];

/**
 * What `fn_lift_my_email_suppression` answers besides the decision's states:
 * it lifted, or the account is not a claimed client. (`not_suppressed` is a
 * decision state and also what it answers when there was nothing to lift.)
 */
export const EMAIL_LIFT_RESULTS = ["lifted", "not_client"] as const;
export type EmailLiftResult = (typeof EMAIL_LIFT_RESULTS)[number] | EmailLiftState;

/**
 * An answer this build does not know: a server newer than the page. Its own
 * class so the portal can say that plainly instead of showing the raw string.
 */
export class UnrecognisedEmailStatusError extends Error {
  constructor(answer: unknown) {
    super(`Unrecognised email status: ${String(answer)}`);
    this.name = "UnrecognisedEmailStatusError";
  }
}

export function asLiftState(s: unknown): EmailLiftState {
  if ((EMAIL_LIFT_STATES as readonly unknown[]).includes(s)) return s as EmailLiftState;
  throw new UnrecognisedEmailStatusError(s);
}

export function asLiftResult(s: unknown): EmailLiftResult {
  if ((EMAIL_LIFT_RESULTS as readonly unknown[]).includes(s)) return s as EmailLiftResult;
  return asLiftState(s);
}
