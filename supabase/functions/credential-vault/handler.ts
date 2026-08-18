// credential-vault core logic (spec 03/04), dependency-injected for tests.
// Every action re-verifies the caller's password; 5/min/user shared rate limit;
// get writes exactly one audit row (via fn_read_credential); delete is a
// soft revoke (revoked_at — audit log immortal). Plaintext secrets never
// appear in logs or errors; the only place a secret leaves this function is
// the `secret` field of a successful `get` response.

import type { VaultBinding } from "../_lib/crypto.ts";
import { HttpError } from "../_lib/http.ts";

export interface VaultBody {
  action?: "put" | "get" | "delete";
  credential_id?: string;
  property_id?: string;
  entry_method?: string;
  label?: string;
  secret?: string;
  key_location_hint?: string;
  purpose?: string;
  password?: string;
}

export interface CredentialMeta {
  id: string;
  operator_id: string;
  property_id: string;
  entry_method: string;
  label: string | null;
  key_location_hint: string | null;
  rotated_at: string | null;
  revoked_at: string | null;
}

export interface VaultDeps {
  /** Shared sliding-window limiter; false ⇒ over 5/min for this user. */
  allowAttempt(userId: string): boolean | Promise<boolean>;
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
    key_location_hint: string | null;
  }): Promise<CredentialMeta>;
  rotateCredential(
    id: string,
    fields: {
      ciphertext: Uint8Array;
      entry_method?: string;
      label?: string | null;
      key_location_hint?: string | null;
    },
  ): Promise<CredentialMeta>;
  revokeCredential(id: string): Promise<void>;
  /** fn_read_credential RPC: tenancy assert + audit row + ciphertext. */
  readCredential(
    credentialId: string,
    purpose: string,
    operatorId: string,
  ): Promise<{ ciphertext: Uint8Array; label: string | null; entry_method: string }>;
}

export async function handleVault(
  operator: { id: string; email?: string },
  body: VaultBody,
  deps: VaultDeps,
): Promise<Record<string, unknown>> {
  if (!(await deps.allowAttempt(operator.id))) {
    throw new HttpError(429, "rate_limited", "too many vault attempts; wait a minute");
  }
  if (!body?.password) {
    throw new HttpError(401, "password_required", "password re-verification is required");
  }
  if (!operator.email) {
    throw new HttpError(401, "reauth_failed", "account has no email to verify against");
  }
  const passwordOk = await deps.verifyPassword(operator.email, body.password);
  if (!passwordOk) {
    throw new HttpError(401, "reauth_failed", "password verification failed");
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
          key_location_hint: body.key_location_hint ?? undefined,
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
        key_location_hint: body.key_location_hint ?? null,
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
    key_location_hint: c.key_location_hint,
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
