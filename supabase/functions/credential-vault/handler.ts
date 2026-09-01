// credential-vault core logic (spec 03/04), dependency-injected for tests.
//
// Every action re-verifies the caller's password; 5/min/user shared rate limit;
// delete is a soft revoke (revoked_at — the audit log is immortal). Plaintext
// secrets never appear in logs or errors; the only place a secret leaves this
// function is the `secret` field of a successful `get` response.
//
// EVERY action writes an audit row now (review H3), not just a successful
// reveal: create, rotate, revoke and a FAILED RE-AUTH all leave a record, with
// the caller's IP and user agent. Before this the log held one event out of
// four, so it could not answer either of the questions it exists for — "who
// changed my garage code" or "who tried and failed to open my door".

import type { VaultBinding } from "../_lib/crypto.ts";
import { HttpError } from "../_lib/http.ts";

export interface VaultBody {
  action?: "put" | "get" | "delete";
  credential_id?: string;
  property_id?: string;
  entry_method?: string;
  label?: string;
  secret?: string;
  purpose?: string;
  password?: string;
  /**
   * The visit this reveal is for. Optional, and validated server-side against
   * the operator AND the property (0030) — a walk reference pointing somewhere
   * else would make the trail worse than empty. The purpose is still required;
   * this is the half of it the system can vouch for.
   */
  walk_id?: string;
}

export interface CredentialMeta {
  id: string;
  operator_id: string;
  property_id: string;
  entry_method: string;
  label: string | null;
  rotated_at: string | null;
  revoked_at: string | null;
}

export interface VaultDeps {
  /** Shared sliding-window limiter; false ⇒ over 5/min for this user. */
  allowAttempt(userId: string): boolean | Promise<boolean>;
  /**
   * How many VERIFIED MFA factors this account has.
   *
   * The gate is graduated on purpose (review H2). Requiring aal2
   * unconditionally would lock every operator out of the vault, because most
   * accounts hold no factor yet: TOTP enrolment is available on the current
   * plan (measured — `ops(auth-posture)`; this comment used to say it needed
   * the Pro plan, which was never checked) and is opt-in through Settings
   * (`security(mfa-ui)`). Instead: if the operator has
   * enrolled a factor, a password-only session is refused; if they have not,
   * the password stands and the audit row records the reduced assurance.
   *
   * That means enrolling a factor is what closes the exploit, and does so
   * without any further code change.
   */
  verifiedFactorCount(userId: string): Promise<number>;
  /**
   * Whether this account has a password at all (review M2, migration 0035).
   *
   * GoTrue returns the same `invalid_credentials` for "wrong password" and
   * "no password set" — deliberately, so sign-in is not an account oracle —
   * so `verifyPassword` genuinely cannot tell them apart. Only
   * `auth.users.encrypted_password` can.
   */
  accountHasPassword(userId: string): Promise<boolean>;
  verifyPassword(email: string, password: string): Promise<boolean>;
  /** The binding is authenticated (AES-GCM additionalData), so a ciphertext
   *  cannot be moved to another row or another tenant (review B2). */
  encrypt(plaintext: string, binding: VaultBinding): Promise<Uint8Array>;
  decrypt(blob: Uint8Array, binding: VaultBinding): Promise<string>;
  getProperty(id: string): Promise<{ id: string; operator_id: string } | null>;
  getCredential(id: string): Promise<CredentialMeta | null>;
  insertCredential(row: {
    /** Minted by the handler, not by the column default: the id is inside the
     *  AAD, so it must exist before the plaintext is encrypted. */
    id: string;
    operator_id: string;
    property_id: string;
    entry_method: string;
    ciphertext: Uint8Array;
    label: string | null;
  }): Promise<CredentialMeta>;
  rotateCredential(
    id: string,
    fields: {
      ciphertext: Uint8Array;
      entry_method?: string;
      label?: string | null;

    },
  ): Promise<CredentialMeta>;
  revokeCredential(id: string): Promise<void>;
  /** fn_read_credential RPC: tenancy assert + audit row + ciphertext. */
  readCredential(
    credentialId: string,
    purpose: string,
    operatorId: string,
    walkId?: string,
  ): Promise<{ ciphertext: Uint8Array; label: string | null; entry_method: string }>;
  /**
   * Record a failed password check.
   *
   * The one audit event with no successful operation behind it, and the one an
   * attacker most wants missing: before this, somebody could try passwords
   * against the vault until the rate limiter stopped them and leave no trace at
   * all. `credentialId` is whatever they were reaching for, which may be null
   * when they named nothing.
   */
  logReauthFailure(operatorId: string, credentialId: string | null): Promise<void>;
}

/**
 * Three outcomes, not two: `aal2` (best), `aal1_no_factor` (what this product
 * is today — allowed, and recorded), `insufficient` (a factor exists but this
 * session did not present it — refused).
 */
export type AssuranceOutcome = "aal2" | "aal1_no_factor" | "insufficient";

export async function resolveAssurance(
  operator: { id: string; aal?: "aal1" | "aal2" | null },
  deps: VaultDeps,
): Promise<AssuranceOutcome> {
  if (operator.aal === "aal2") return "aal2";
  // A missing claim is treated exactly like aal1. It is what a project with no
  // MFA configured emits, and assuming the stronger value from an ABSENT claim
  // would be the whole gate failing open.
  const factors = await deps.verifiedFactorCount(operator.id);
  return factors > 0 ? "insufficient" : "aal1_no_factor";
}

export async function handleVault(
  operator: { id: string; email?: string; aal?: "aal1" | "aal2" | null },
  body: VaultBody,
  deps: VaultDeps,
): Promise<Record<string, unknown>> {
  // ── Order matters, and it was wrong (review M2) ─────────────────────────
  //
  // `allowAttempt` used to run FIRST, so every request burned a slot in the
  // 5/min window — including requests that could never have succeeded. An
  // operator who signed up with a magic link has no password to type, and
  // five attempts at a password that cannot exist locked them out of the
  // vault entirely, on a doorstep, with no way to fix it in the product.
  //
  // The limiter exists to bound password GUESSING. So it now sits directly in
  // front of the guess, and the checks that are about the shape of the
  // request or the state of the account come first and cost nothing.
  if (!body?.password) {
    throw new HttpError(401, "password_required", "password re-verification is required");
  }
  if (!operator.email) {
    throw new HttpError(401, "reauth_failed", "account has no email to verify against");
  }

  if (!(await deps.accountHasPassword(operator.id))) {
    // Deliberately NOT a `reauth_failed`, and deliberately not audited.
    //
    // No password was checked, so nothing was tried — recording this as a
    // failed re-auth would fill the trail with configuration noise in exactly
    // the log that has to make a real attack visible (review H3). Nor is it a
    // blind spot: an attacker holding a stolen session on a passwordless
    // account learns nothing here, and to actually read a credential they must
    // first set a password, after which the reveal writes an ordinary audit
    // row carrying their IP.
    throw new HttpError(
      409,
      "password_not_set",
      "This account signs in with a magic link and has no password yet. Set one to unlock the vault — every reveal is recorded against it.",
    );
  }

  // Now, and only now, is a password about to be guessed.
  if (!(await deps.allowAttempt(operator.id))) {
    throw new HttpError(429, "rate_limited", "too many vault attempts; wait a minute");
  }

  const passwordOk = await deps.verifyPassword(operator.email, body.password);
  if (!passwordOk) {
    // Recorded BEFORE the throw. This is the event an attacker most wants
    // missing: previously somebody could try passwords against the vault until
    // the rate limiter stopped them and leave no trace whatsoever, so a client
    // asking "did anyone try to open my door" had no answer either way.
    //
    // Best-effort on purpose: if the log write fails, the caller must still be
    // refused. Turning a rejected password into a 500 would tell an attacker
    // they had found a way to disable the audit trail.
    try {
      await deps.logReauthFailure(operator.id, body.credential_id ?? null);
    } catch {
      // swallowed deliberately — see above
    }
    throw new HttpError(401, "reauth_failed", "password verification failed");
  }

  // The password alone is not enough when something better exists.
  //
  // An attacker holding only a live session can change the account password
  // without knowing the old one and then pass the check above with the password
  // they just set, which reduces "one compromised browser session" to "every
  // entry code for every one of this operator's clients". They cannot
  // manufacture aal2, because that needs the second factor itself.
  //
  // Refused only when the operator HAS a verified factor — see
  // verifiedFactorCount. An operator with no factor is where the product is
  // today, and the audit row records that the reveal happened at reduced
  // assurance rather than pretending otherwise.
  const assurance = await resolveAssurance(operator, deps);
  if (assurance === "insufficient") {
    throw new HttpError(
      401,
      "second_factor_required",
      // The named remedy matches what the product actually does now: the
      // re-auth sheet collects the code and upgrades the session in place —
      // there is deliberately no step-up at sign-in, so "sign in again"
      // (this message's first wording) instructed a flow that does not
      // exist (adversarial review).
      "Your account has two-factor authentication enabled, so the vault needs it for this session. Try again and enter the code from your authenticator app when asked.",
    );
  }

  switch (body.action) {
    case "put": {
      if (!body.secret || body.secret.length === 0) {
        throw new HttpError(400, "bad_request", "secret is required");
      }
      if (body.credential_id) {
        // Rotation of an existing credential.
        const cred = await deps.getCredential(body.credential_id);
        if (!cred || cred.operator_id !== operator.id) {
          throw new HttpError(404, "credential_not_found", "credential not found");
        }
        if (cred.revoked_at) {
          throw new HttpError(409, "credential_revoked", "credential has been revoked");
        }
        const blob = await deps.encrypt(body.secret, {
          credentialId: cred.id,
          operatorId: operator.id,
        });
        const updated = await deps.rotateCredential(cred.id, {
          ciphertext: blob,
          entry_method: body.entry_method ?? undefined,
          label: body.label ?? undefined,
        });
        return { credential: publicMeta(updated) };
      }
      if (!body.property_id || !body.entry_method) {
        throw new HttpError(400, "bad_request", "property_id and entry_method are required for a new credential");
      }
      const property = await deps.getProperty(body.property_id);
      if (!property || property.operator_id !== operator.id) {
        throw new HttpError(404, "property_not_found", "property not found");
      }
      // Mint the id first: encryption binds to it. Insert-then-update was
      // considered and rejected — it leaves a window where the row holds a
      // blob bound to an id it does not yet have.
      const id = crypto.randomUUID();
      const blob = await deps.encrypt(body.secret, {
        credentialId: id,
        operatorId: operator.id,
      });
      const created = await deps.insertCredential({
        id,
        operator_id: operator.id,
        property_id: body.property_id,
        entry_method: body.entry_method,
        ciphertext: blob,
        label: body.label ?? null,
      });
      return { credential: publicMeta(created) };
    }

    case "get": {
      if (!body.credential_id) {
        throw new HttpError(400, "bad_request", "credential_id is required");
      }
      if (!body.purpose || body.purpose.trim().length === 0) {
        throw new HttpError(400, "purpose_required", "a non-empty purpose is required");
      }
      const { ciphertext, label, entry_method } = await deps.readCredential(
        body.credential_id,
        body.purpose.trim(),
        operator.id,
        body.walk_id,
      );
      const secret = await deps.decrypt(ciphertext, {
        credentialId: body.credential_id,
        operatorId: operator.id,
      });
      return { secret, label, entry_method };
    }

    case "delete": {
      if (!body.credential_id) {
        throw new HttpError(400, "bad_request", "credential_id is required");
      }
      const cred = await deps.getCredential(body.credential_id);
      if (!cred || cred.operator_id !== operator.id) {
        throw new HttpError(404, "credential_not_found", "credential not found");
      }
      await deps.revokeCredential(cred.id);
      return { revoked: true };
    }

    default:
      throw new HttpError(400, "bad_request", "action must be put, get, or delete");
  }
}

function publicMeta(c: CredentialMeta): Omit<CredentialMeta, "operator_id"> {
  return {
    id: c.id,
    property_id: c.property_id,
    entry_method: c.entry_method,
    label: c.label,
    rotated_at: c.rotated_at,
    revoked_at: c.revoked_at,
  };
}

/** In-memory sliding-window limiter used only by unit tests. */
export function makeRateLimiter(
  limit = 5,
  windowMs = 60_000,
  now: () => number = Date.now,
): (userId: string) => boolean {
  const attempts = new Map<string, number[]>();
  return (userId: string) => {
    const t = now();
    const kept = (attempts.get(userId) ?? []).filter((x) => t - x < windowMs);
    if (kept.length >= limit) {
      attempts.set(userId, kept);
      return false;
    }
    kept.push(t);
    attempts.set(userId, kept);
    return true;
  };
}
