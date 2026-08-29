/**
 * The password rule, stated once on the client side.
 *
 * **The server is the authority.** GoTrue enforces `minimum_password_length`
 * and `password_requirements`, and every place that sets a password surfaces
 * GoTrue's own error rather than swallowing it. What lives here is a courtesy:
 * telling somebody the rule before they type, and catching the obvious miss
 * without a round trip. It can never *permit* something the server refuses.
 *
 * The values are duplicated from `supabase/config.toml`, which is the one thing
 * that made this worth a module. Two copies of a rule is the drift this
 * repository has already paid for twice — the payment-status sets, and the
 * low-credit subscription predicate — so `scripts/password-policy.test.ts`
 * parses the toml and fails if these numbers stop matching it.
 *
 * The floor is 12 rather than Supabase's default 6 (review H2): for an
 * operator this password is the only thing between a stolen session and every
 * door code they hold.
 */

/** `auth.minimum_password_length` in `supabase/config.toml`. */
export const PASSWORD_MIN_LENGTH = 12;

/** `auth.password_requirements` in `supabase/config.toml`. */
export const PASSWORD_REQUIREMENTS = "lower_upper_letters_digits";

/** Shown under the field, before anything is typed. */
export const PASSWORD_HELP =
  `At least ${PASSWORD_MIN_LENGTH} characters, with an uppercase letter, ` +
  `a lowercase letter and a digit.`;

/**
 * The first thing wrong with this password, or null.
 *
 * One problem at a time rather than a list: the field shows a single error, and
 * a person fixing a password fixes it once and resubmits either way.
 *
 * Empty input returns null — "you have not typed anything yet" is the disabled
 * submit button's job, not an error message's. A form that shouts before the
 * first keystroke is worse than one that waits.
 */
export function passwordPolicyProblem(password: string): string | null {
  if (password.length === 0) return null;
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  // Mirrors GoTrue's `lower_upper_letters_digits`, which asks for one of each
  // of the three classes and says nothing about symbols — so a passphrase with
  // no punctuation passes, which is the point.
  if (!/[a-z]/.test(password)) return "Add a lowercase letter.";
  if (!/[A-Z]/.test(password)) return "Add an uppercase letter.";
  if (!/[0-9]/.test(password)) return "Add a digit.";
  return null;
}
