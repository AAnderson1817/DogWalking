// credential-vault — POST, operator JWT (spec 03/04).
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonOk, readJson, requireOperator, serveFunction, HttpError } from "../_lib/http.ts";
import { adminClient } from "../_lib/admin.ts";
import { causeCode } from "../_lib/observe.ts";
import {
  bytesToPgHex,
  decryptSecret,
  encryptSecret,
  importVaultKey,
  pgHexToBytes,
  VaultBlobError,
  type VaultKey,
} from "../_lib/crypto.ts";
import {
  handleVault,
  type CredentialMeta,
  type VaultBody,
  type VaultDeps,
} from "./handler.ts";

const CRED_META_COLUMNS =
  "id, operator_id, property_id, entry_method, label, key_location_hint, rotated_at, revoked_at";

/**
 * The key ring. Two keys can be loaded at once — the current one, which
 * encrypts and decrypts, and a retired one that only decrypts. That is what
 * makes rotation possible: while a rewrap is in progress, some rows are on the
 * new key and some on the old, and BOTH read correctly. A mixed fleet on mixed
 * keys is the normal state during a rotation, not a hazard, so the rewrap can
 * be paused, killed or resumed with no outage and no deadline.
 *
 * Decryption routes strictly by the key id in the blob — never "try each key
 * until one works", which would reintroduce exactly the ambiguity the key id
 * exists to remove.
 */
interface KeyRing {
  primary: VaultKey;
  byId: Map<string, VaultKey>;
}

let ring: KeyRing | null = null;

async function getRing(): Promise<KeyRing> {
  if (ring) return ring;
  const primaryRaw = Deno.env.get("VAULT_MASTER_KEY");
  if (!primaryRaw) {
    throw new HttpError(
      500,
      "vault_key_missing",
      "the vault key is not configured",
      "the vault master key env var is unset in this deployment",
    );
  }
  const primary = await importVaultKey(primaryRaw);
  const byId = new Map<string, VaultKey>([[primary.id, primary]]);

  // `none` is the explicit tombstone for "there is no retired key", so
  // retiring one is a deliberate value rather than an absent variable that
  // could equally mean a mis-typed secret name.
  const previousRaw = (Deno.env.get("VAULT_MASTER_KEY_PREVIOUS") ?? "").trim();
  if (previousRaw !== "" && previousRaw !== "none") {
    const previous = await importVaultKey(previousRaw);
    if (previous.id === primary.id) {
      throw new HttpError(
        500,
        "vault_key_duplicate",
        "the retired vault key is the same as the current one",
      );
    }
    byId.set(previous.id, previous);
  }
  ring = { primary, byId };
  return ring;
}

function makeDeps(clientIp: string | null): VaultDeps {
  const db = adminClient();
  return {
    async allowAttempt(userId) {
      const { data, error } = await db.rpc("fn_vault_allow_attempt", {
        p_user: userId,
        p_ip: clientIp,
        p_limit: 5,
        p_window_seconds: 60,
      });
      if (error) {
        throw new HttpError(500, "rate_limit_failed", "vault rate limit check failed", error, {
          user_id: userId,
        });
      }
      return Boolean(data);
    },

    async verifyPassword(email, password) {
      // Fresh re-auth check against GoTrue with the anon key; the session is
      // discarded — only the boolean outcome is used.
      const url = Deno.env.get("SUPABASE_URL");
      const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
      if (!url || !anonKey) {
        throw new HttpError(
          500,
          "misconfigured",
          "auth is not configured",
          `missing ${!url ? "SUPABASE_URL" : "SUPABASE_ANON_KEY"}`,
        );
      }
      const probe = createClient(url, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error } = await probe.auth.signInWithPassword({ email, password });
      return !error;
    },

    async encrypt(plaintext, binding) {
      // Always the primary. A retired key must never write a new blob.
      return await encryptSecret((await getRing()).primary, plaintext, binding);
    },

    async decrypt(blob, binding) {
      const { byId } = await getRing();
      try {
        return await decryptSecret(byId, blob, binding);
      } catch (e) {
        // The blob names its key, so these are now distinguishable — and the
        // distinction is the point. `key_unknown` is recoverable by supplying
        // the key; `decrypt_failed` is not, and means tampering or a relocated
        // row. Collapsing them into one message was the original defect.
        if (e instanceof VaultBlobError) {
          const status = e.code === "key_unknown" ? 409 : 500;
          throw new HttpError(status, e.code, e.message);
        }
        // The thrown value is NOT passed as the cause. A decryption failure
        // on an unrecognised error shape is the one place where whatever went
        // wrong may have handled plaintext, and the code already distinguishes
        // the diagnosable cases (VaultBlobError) above.
        throw new HttpError(
          500,
          "decrypt_failed",
          "credential could not be decrypted",
          "a non-VaultBlobError escaped decryptSecret",
          { credential_id: binding.credentialId },
        );
      }
    },

    async getProperty(id) {
      const { data, error } = await db
        .from("properties")
        .select("id, operator_id")
        .eq("id", id)
        .maybeSingle();
      if (error) {
        throw new HttpError(500, "db_error", "property lookup failed", error, {
          property_id: id,
        });
      }
      return data;
    },

    async getCredential(id) {
      const { data, error } = await db
        .from("access_credentials")
        .select(CRED_META_COLUMNS)
        .eq("id", id)
        .maybeSingle();
      if (error) {
        throw new HttpError(500, "db_error", "credential lookup failed", error, {
          credential_id: id,
        });
      }
      return data as CredentialMeta | null;
    },

    async insertCredential(row) {
      const { data, error } = await db
        .from("access_credentials")
        .insert({ ...row, ciphertext: bytesToPgHex(row.ciphertext) })
        .select(CRED_META_COLUMNS)
        .single();
      // causeCode, not the whole error: this statement carries the ciphertext,
      // so a syntax or constraint failure could quote part of the payload back
      // in its own message. A SQLSTATE is enough to diagnose from, and
      // invariant 2 is not worth a better log line.
      if (error) {
        throw new HttpError(500, "db_error", "credential insert failed", causeCode(error), {
          property_id: (row as { property_id?: string }).property_id,
        });
      }
      return data as CredentialMeta;
    },

    async rotateCredential(id, fields) {
      const update: Record<string, unknown> = {
        ciphertext: bytesToPgHex(fields.ciphertext),
        rotated_at: new Date().toISOString(),
      };
      if (fields.entry_method !== undefined) update.entry_method = fields.entry_method;
      if (fields.label !== undefined) update.label = fields.label;
      if (fields.key_location_hint !== undefined) {
        update.key_location_hint = fields.key_location_hint;
      }
      const { data, error } = await db
        .from("access_credentials")
        .update(update)
        .eq("id", id)
        .select(CRED_META_COLUMNS)
        .single();
      // causeCode for the same reason as the insert above: the statement
      // carries the new ciphertext.
      if (error) {
        throw new HttpError(500, "db_error", "credential rotation failed", causeCode(error), {
          credential_id: id,
        });
      }
      return data as CredentialMeta;
    },

    async revokeCredential(id) {
      const { error } = await db
        .from("access_credentials")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", id);
      if (error) {
        throw new HttpError(500, "db_error", "credential revoke failed", error, {
          credential_id: id,
        });
      }
    },

    async readCredential(credentialId, purpose, operatorId) {
      const { data, error } = await db.rpc("fn_read_credential", {
        p_credential: credentialId,
        p_purpose: purpose,
        p_operator: operatorId,
      });
      if (error) {
        // The definer function raises on tenancy/revocation violations;
        // surface a neutral 404 without echoing its message.
        throw new HttpError(404, "credential_not_found", "credential not found or not readable");
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new HttpError(404, "credential_not_found", "credential not found");
      return {
        ciphertext: pgHexToBytes(row.ciphertext as string),
        label: (row.label as string | null) ?? null,
        entry_method: row.entry_method as string,
      };
    },
  };
}

serveFunction(async (req) => {
  const operator = await requireOperator(req);
  const body = await readJson<VaultBody>(req);
  // First hop of x-forwarded-for = the caller as seen by the edge gateway.
  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const result = await handleVault(operator, body, makeDeps(clientIp));
  return jsonOk(result);
});
