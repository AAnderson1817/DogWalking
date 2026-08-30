// TOTP second factor — the client half of the vault's graduated assurance
// gate (review H2; server: credential-vault resolveAssurance).
//
// The server's rule has been live since the H2 fix: a session at aal2 passes,
// a session with NO verified factor passes at reduced assurance, and a
// password-only session on an account that HAS a verified factor is refused
// `second_factor_required` — so enrolling a factor is what closes the
// stolen-session-to-vault chain, with no server change. What was missing is
// any way to enroll: no call to supabase.auth.mfa.* existed anywhere in the
// tree, so the posture the gate was built for was unreachable.
//
// Two surfaces consume this module:
//   - MfaSection (Settings): enroll → scan QR → verify. Verifying the
//     enrolment code upgrades the CURRENT session to aal2 in place.
//   - ReauthSheet: when the account has a verified factor and the session is
//     still aal1 (a magic-link session, or one that predates enrolment), the
//     sheet asks for a code and upgrades the session BEFORE the vault call,
//     so the doomed request is never made — the M2 shape, one rung up.
//
// The decision logic is pure and exported; the wrappers around
// supabase.auth.mfa are thin and fail OPEN (return "no step-up") on transport
// errors, for the same reason accountHasPassword does: the server still
// refuses an insufficient session safely, while failing closed here would
// wall every operator out of the vault on a flaky connection.
import { supabase } from "./supabase";

export interface MfaFactorLike {
  id: string;
  factor_type?: string;
  status?: string;
}

export interface MfaLevelsLike {
  currentLevel: string | null;
  nextLevel: string | null;
}

/** The factor a step-up should challenge: the first VERIFIED TOTP factor.
 * Unverified factors are abandoned enrolments — the server deliberately does
 * not count them (an abandoned setup must not lock anyone out), so
 * challenging one here would demand a code the person may never have added
 * to any app. */
export function verifiedTotpFactor(
  factors: MfaFactorLike[] | null | undefined,
): MfaFactorLike | null {
  if (!factors) return null;
  return factors.find((f) => f.factor_type === "totp" && f.status === "verified") ?? null;
}

/**
 * Whether this session needs a TOTP step before an aal2-gated action, and
 * which factor to challenge. Null means "no step-up": already aal2, no
 * verified factor, or unknown state (the fail-open direction — see header).
 *
 * The aal2 short-circuit mirrors the server exactly: resolveAssurance
 * returns "aal2" before ever counting factors, so a session that already
 * presented the factor is never asked twice.
 */
export function resolveMfaGate(
  levels: MfaLevelsLike | null | undefined,
  factors: MfaFactorLike[] | null | undefined,
): { factorId: string } | null {
  if (!levels || levels.currentLevel === "aal2") return null;
  if (levels.nextLevel !== "aal2") return null;
  const factor = verifiedTotpFactor(factors);
  return factor ? { factorId: factor.id } : null;
}

/** resolveMfaGate against the live session; any transport failure is "no
 * step-up" (fail open — the server refuses safely). */
export async function fetchMfaGate(): Promise<{ factorId: string } | null> {
  try {
    const [{ data: levels, error: lvlErr }, { data: factors, error: facErr }] = await Promise
      .all([
        supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
        supabase.auth.mfa.listFactors(),
      ]);
    if (lvlErr || facErr) return null;
    return resolveMfaGate(levels, factors?.all);
  } catch {
    return null;
  }
}

/** Challenge + verify in one step; a success upgrades the current session to
 * aal2 in place. Returns the error message, or null on success. */
export async function stepUpWithCode(factorId: string, code: string): Promise<string | null> {
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
  return error ? error.message : null;
}

export interface TotpEnrolment {
  factorId: string;
  qrCode: string;
  secret: string;
}

/**
 * Start a TOTP enrolment, cleaning up abandoned ones first.
 *
 * GoTrue cannot re-show the secret of an existing unverified factor, so an
 * abandoned enrolment (closed the sheet mid-scan, phone died) is
 * unfinishable by construction — the only honest continuation is a fresh
 * QR. Unverified factors carry no security weight (the server counts only
 * verified ones), so removing them is cleanup, not a security action.
 */
export async function beginTotpEnrolment(): Promise<TotpEnrolment> {
  const { data: existing } = await supabase.auth.mfa.listFactors();
  for (const f of existing?.all ?? []) {
    if (f.status !== "verified") {
      await supabase.auth.mfa.unenroll({ factorId: f.id });
    }
  }
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp" });
  if (error || !data) {
    throw new Error(error?.message ?? "Could not start two-factor setup.");
  }
  return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
}

/** Confirm the enrolment with a code from the app — the moment the factor
 * becomes verified and the vault starts requiring it. Returns the error
 * message, or null on success. */
export async function confirmTotpEnrolment(factorId: string, code: string): Promise<string | null> {
  return stepUpWithCode(factorId, code);
}

/** Remove a verified factor. GoTrue requires the session at aal2 for this,
 * which is why MfaSection collects a code first — turning two-factor off
 * requires having it. */
export async function removeTotpFactor(factorId: string): Promise<string | null> {
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  return error ? error.message : null;
}

/** The Settings section's view of the account: the verified factor if any. */
export async function fetchVerifiedFactor(): Promise<MfaFactorLike | null> {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw new Error(error.message);
  return verifiedTotpFactor(data?.all);
}
