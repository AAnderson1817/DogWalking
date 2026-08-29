/**
 * Review L16: there was no way back into an account.
 *
 * A grep for `resetPasswordForEmail` and "Forgot" returned nothing. The magic
 * link was the only route back in, and it is presented as an alternative *way
 * to sign in* rather than as recovery — so somebody who had forgotten their
 * password had to work out for themselves that the other button would save
 * them. For an operator that account holds every client's entry codes.
 *
 * The logic worth extracting from the screens is what to SAY afterwards.
 */

/** Where Supabase sends the recovery link back to. */
export const RESET_REDIRECT_PATH = "/reset-password";

export function resetRedirectUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${RESET_REDIRECT_PATH}`;
}

export interface ResetOutcome {
  /** Message to show. Always non-empty — silence after a submit is its own bug. */
  message: string;
  /** `success` renders as a confirmation; `error` renders as a form error. */
  tone: "success" | "error";
}

/**
 * What a "send me a reset link" attempt should say.
 *
 * The rule: **the same confirmation whether or not the address has an
 * account.** Anything else is an account-existence oracle — type an address,
 * read the response, learn whether that person is a Sanpo customer. GoTrue is
 * careful about this on purpose (it returns the same `invalid_credentials` for
 * a wrong password and an account with no password, which review M2 had to
 * work around rather than defeat), and it would be undone by a screen that
 * reports "no account with that email" from a failed lookup.
 *
 * So an error is surfaced ONLY when it is about this request rather than about
 * this account: a rate limit the person can wait out, or a transport failure
 * they can retry. Telling somebody their link is on the way when the request
 * never left the browser is the opposite failure and is worth avoiding too.
 */
export function describeResetOutcome(
  error: { message?: string; status?: number } | null,
  email: string,
): ResetOutcome {
  const sent: ResetOutcome = {
    // Deliberately conditional — "if that address has an account" — so the
    // sentence is true either way and reveals nothing.
    message: `If ${email} has an account, a reset link is on its way. It expires in an hour.`,
    tone: "success",
  };
  if (!error) return sent;

  // 429 is the one status that is about the REQUEST rather than the account,
  // and it is actionable: wait. Supabase's own message names the interval.
  if (error.status === 429) {
    return {
      message: error.message ?? "Too many requests just now. Try again in a minute.",
      tone: "error",
    };
  }

  // A network failure has no status at all. Say so rather than claiming an
  // email was sent — a false confirmation costs somebody an hour of waiting
  // for a message that was never requested.
  if (error.status === undefined) {
    return {
      message: "Couldn't reach the server. Check your connection and try again.",
      tone: "error",
    };
  }

  // Everything else — 400s about the address, 422s, anything GoTrue may add
  // later — collapses into the neutral confirmation. This is the branch that
  // keeps the oracle closed, and it is deliberately the DEFAULT rather than a
  // list of known-safe codes: a status this function has never seen must not
  // become a disclosure by omission.
  return sent;
}
