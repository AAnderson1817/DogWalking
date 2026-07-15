// credential-vault — POST, operator JWT (spec 03/04).
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonOk, readJson, requireOperator, serveFunction, HttpError } from "../_lib/http.ts";
import { adminClient } from "../_lib/admin.ts";
import {
  bytesToPgHex,
  decryptSecret,
  encryptSecret,
  importVaultKey,
  pgHexToBytes,
} from "../_lib/crypto.ts";
import {
  handleVault,
  type CredentialMeta,
  type VaultBody,
  type VaultDeps,
} from "./handler.ts";

const CRED_META_COLUMNS =
  "id, operator_id, property_id, entry_method, label, key_location_hint, rotated_at, revoked_at";

let vaultKey: CryptoKey | null = null;
async function getVaultKey(): Promise<CryptoKey> {
  if (!vaultKey) {
    const raw = Deno.env.get("VAULT_MASTER_KEY");
    if (!raw) throw new HttpError(500, "misconfigured", "vault key is not configured");
    vaultKey = await importVaultKey(raw);
  }
  return vaultKey;
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
      if (error) throw new HttpError(500, "rate_limit_failed", "vault rate limit check failed");
      return Boolean(data);
    },

    async verifyPassword(email, password) {
      // Fresh re-auth check against GoTrue with the anon key; the session is
      // discarded — only the boolean outcome is used.
      const url = Deno.env.get("SUPABASE_URL");
      const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
      if (!url || !anonKey) throw new HttpError(500, "misconfigured", "auth is not configured");
      const probe = createClient(url, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error } = await probe.auth.signInWithPassword({ email, password });
      return !error;
    },

    async encrypt(plaintext) {
      return await encryptSecret(await getVaultKey(), plaintext);
    },

    async decrypt(blob) {
      try {
        return await decryptSecret(await getVaultKey(), blob);
      } catch {
        // Wrong key or tampered blob — never include details.
        throw new HttpError(500, "decrypt_failed", "credential could not be decrypted");
      }
    },

    async getProperty(id) {
      const { data, error } = await db
        .from("properties")
        .select("id, operator_id")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new HttpError(500, "db_error", "property lookup failed");
      return data;
    },

    async getCredential(id) {
      const { data, error } = await db
        .from("access_credentials")
        .select(CRED_META_COLUMNS)
        .eq("id", id)
        .maybeSingle();
      if (error) throw new HttpError(500, "db_error", "credential lookup failed");
      return data as CredentialMeta | null;
    },

    async insertCredential(row) {
      const { data, error } = await db
        .from("access_credentials")
        .insert({ ...row, ciphertext: bytesToPgHex(row.ciphertext) })
        .select(CRED_META_COLUMNS)
        .single();
      if (error) throw new HttpError(500, "db_error", "credential insert failed");
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
      if (error) throw new HttpError(500, "db_error", "credential rotation failed");
      return data as CredentialMeta;
    },

    async revokeCredential(id) {
      const { error } = await db
        .from("access_credentials")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw new HttpError(500, "db_error", "credential revoke failed");
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
