// claim-signup decision logic (review H31), dependency-injected for tests.
//
// This is the function that lets the GoTrue "allow new users to sign up"
// toggle finally be turned OFF: client accounts stop depending on public
// signUp and are created here, by the admin API, but ONLY after the invite
// token has been validated. The ordering is the entire security property —
// an account created before the check is an account an attacker mints with
// a dead token, which is public signup wearing an invite's clothes.
//
// What this function does NOT do is claim. The claim itself stays
// `fn_claim_invite`, called by the signed-in browser with the privacy-notice
// version (H6: acceptance and binding are one transaction), so the audit row
// still records the authenticated principal. This function only answers
// "may an account be created for this token + email", via
// fn_invite_signup_check — which returns exactly what the claim will.
import { HttpError } from "../_lib/http.ts";

/** Mirrors config.toml's declared password posture — BOTH settings, not just
 * the length: `minimum_password_length = 12` AND `password_requirements =
 * "lower_upper_letters_digits"`. Enforced here because the deployed GoTrue
 * policy is a dashboard setting no file controls (H2; the measured staging
 * floor is 6 with no character classes), and an invited client's account
 * reaches their home address, entry-code activity and GPS traces — it must
 * not be allowed a WEAKER password than the declared posture just because it
 * was created through the admin API (adversarial review). */
export const PASSWORD_MIN_LENGTH = 12;

/** The `lower_upper_letters_digits` rule, one place. */
export function passwordMeetsPolicy(password: string): boolean {
  return password.length >= PASSWORD_MIN_LENGTH &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /\d/.test(password);
}

export const PASSWORD_POLICY_MESSAGE =
  `password must be at least ${PASSWORD_MIN_LENGTH} characters and include a lowercase letter, an uppercase letter, and a digit`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClaimSignupDeps {
  /** fn_invite_signup_allow_attempt (0048). False when the budget is spent. */
  allowAttempt(token: string): Promise<boolean>;
  /** fn_invite_signup_check: an invite_claim_outcome value. */
  checkInvite(token: string, email: string): Promise<string>;
  /** auth.admin.createUser with email_confirm false. 'exists' when GoTrue
   * says the address is already registered. */
  createUser(email: string, password: string): Promise<"created" | "exists">;
}

export const RATE_LIMIT_MESSAGE =
  "Too many attempts for this invite. Wait a few minutes and try again.";

/**
 * How the RPC's answer becomes a decision, as a pure function so the rule is
 * reachable from a test at all — importing `index.ts` executes
 * `serveFunction` and binds a port, which is why the seam exists.
 *
 * Fails CLOSED: anything that is not literally `true` refuses. This is the
 * OPPOSITE of the vault's account-has-password lookup, which fails open so a
 * flaky connection cannot wall an operator away from a door code. Here the
 * endpoint is public and creates accounts, and a limiter that opens under
 * load is no limiter at all — the load is the attack. `null` in particular
 * is what PostgREST returns for an RPC whose result it could not read, and a
 * `data !== false` reading would let exactly that through.
 */
export function rpcAllowsAttempt(data: unknown): boolean {
  return data === true;
}

const OUTCOME_MESSAGES: Record<string, string> = {
  not_found: "This invite link is not valid.",
  already_claimed: "This invite has already been used. Sign in instead.",
  expired: "This invite has expired — ask your walker to send a new one.",
  revoked: "This invite is no longer active.",
  email_mismatch: "This invite was sent to a different email address.",
};

export async function handleClaimSignup(
  body: unknown,
  deps: ClaimSignupDeps,
): Promise<{ registered: true }> {
  const b = body as { token?: unknown; email?: unknown; password?: unknown } | null;
  const token = typeof b?.token === "string" ? b.token.trim() : "";
  const email = typeof b?.email === "string" ? b.email.trim() : "";
  const password = typeof b?.password === "string" ? b.password : "";

  // Shape checks first, before any dependency runs: a malformed request must
  // learn nothing about any invite and cost nothing.
  if (!UUID_RE.test(token)) {
    throw new HttpError(400, "bad_request", "a valid invite token is required");
  }
  if (email.length < 3 || !email.includes("@") || email.length > 320) {
    throw new HttpError(400, "bad_request", "a valid email address is required");
  }
  if (!passwordMeetsPolicy(password)) {
    throw new HttpError(400, "weak_password", PASSWORD_POLICY_MESSAGE);
  }

  // 0048. Directly in front of the GUESS, and after the shape checks, which
  // is 0035's rule: a request that never reaches the database is neither of
  // the harms being bounded, and the password fumble is the thing a real
  // person repeats most.
  //
  // On exhaustion this refuses WITHOUT calling checkInvite at all. That is
  // the load-bearing half: no outcome is computed, so none can leak, and no
  // refusal row is written — which is one of the two harms. A limiter that
  // ran after the check, or that counted only refusals, would leave the
  // CORRECT address unlimited while wrong ones were refused, and an attacker
  // would read the answer straight off the status at no budget cost. That
  // version is the bug wearing the fix's clothes.
  //
  // Every request reaching here counts, including one that will succeed.
  if (!(await deps.allowAttempt(token))) {
    // Deliberately NOT one of the 0039 outcome codes: `claimSignup` in the
    // frontend remaps those onto InviteClaimError, which renders a TERMINAL
    // dead-end screen. A rate-limited claimant must land on the ordinary,
    // retryable form error instead.
    throw new HttpError(429, "rate_limited", RATE_LIMIT_MESSAGE);
  }

  // The invite decides whether an account may exist, BEFORE one is created.
  // The check also refuses email_mismatch here, so a claimant who typed the
  // wrong address is told so instead of being left with a fresh account that
  // can never claim anything.
  const outcome = await deps.checkInvite(token, email);
  if (outcome !== "claimed") {
    const message = OUTCOME_MESSAGES[outcome];
    if (!message) {
      // An outcome value this code has never seen is a contract drift with
      // fn_invite_signup_check, not a user error.
      throw new HttpError(500, "internal", "invite check failed", undefined, {
        outcome,
      });
    }
    // The code IS the outcome value, verbatim, so ClaimInvite maps it onto
    // the same differentiated dead-ends the RPC path uses (H4).
    throw new HttpError(409, outcome, message);
  }

  // 'exists' collapses into the same success as 'created', deliberately: a
  // distinct answer would make this public endpoint an account-existence
  // oracle for anyone holding a live invite whose client row has no bound
  // email. The frontend signs in right after; a wrong password there is the
  // ordinary, rate-limited sign-in failure.
  await deps.createUser(email, password);
  return { registered: true };
}
