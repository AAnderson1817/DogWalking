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

/** Mirrors config.toml's minimum_password_length. Enforced here as well
 * because auth.admin.createUser does not apply the GoTrue password policy,
 * and the deployed policy is a dashboard setting no file controls (H2) —
 * the measured staging floor is 6. */
export const PASSWORD_MIN_LENGTH = 12;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClaimSignupDeps {
  /** fn_invite_signup_check: an invite_claim_outcome value. */
  checkInvite(token: string, email: string): Promise<string>;
  /** auth.admin.createUser with email_confirm false. 'exists' when GoTrue
   * says the address is already registered. */
  createUser(email: string, password: string): Promise<"created" | "exists">;
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
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new HttpError(
      400,
      "weak_password",
      `password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    );
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
