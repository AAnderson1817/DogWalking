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
  "id, operator_id, property_id, entry_method, label, rotated_at, revoked_at";

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

/**
 * `operatorId` is a constructor argument, not a per-call one, because every
 * definer function in 0030 scopes its write on it — an id passed per call is an
 * id a future call site can forget or get wrong, and here that would mean
 * rotating another operator's credential.
 */
function makeDeps(
  operatorId: string,
  clientIp: string | null,
  userAgent: string | null,
): VaultDeps {
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

    // Through fn_write_credential (0030), not a bare INSERT: the row and its
    // 'create' audit entry land in one transaction. Two statements from here
    // could half-succeed, and the half that survives would be the one that
    // changes the door.
    async insertCredential(row) {
      const { error } = await db.rpc("fn_write_credential", {
        p_id: row.id,
        p_operator: row.operator_id,
        p_property: row.property_id,
        p_entry_method: row.entry_method,
        p_ciphertext: bytesToPgHex(row.ciphertext),
        p_label: row.label,
        p_ip: clientIp,
        p_user_agent: userAgent,
      });
      // causeCode, not the whole error: this statement carries the ciphertext,
      // so a syntax or constraint failure could quote part of the payload back
      // in its own message. A SQLSTATE is enough to diagnose from, and
      // invariant 2 is not worth a better log line.
      if (error) {
        throw new HttpError(500, "db_error", "credential insert failed", causeCode(error), {
          property_id: row.property_id,
        });
      }
      const { data, error: readErr } = await db
        .from("access_credentials")
        .select(CRED_META_COLUMNS)
        .eq("id", row.id)
        .single();
      if (readErr) {
        throw new HttpError(500, "db_error", "credential read-back failed", readErr, {
          credential_id: row.id,
        });
      }
      return data as CredentialMeta;
    },

    // Through fn_rotate_credential (0030). The 'rotate' audit row is what
    // answers "who changed my garage code on the 14th" — before it, a rotation
    // left only `rotated_at`, which the NEXT rotation overwrote, so a door's
    // code history was exactly one entry long.
    async rotateCredential(id, fields) {
      const { error } = await db.rpc("fn_rotate_credential", {
        p_id: id,
        p_operator: operatorId,
        p_ciphertext: bytesToPgHex(fields.ciphertext),
        p_entry_method: fields.entry_method ?? null,
        p_label: fields.label ?? null,
        p_ip: clientIp,
        p_user_agent: userAgent,
      });
      // causeCode for the same reason as the insert above: the statement
      // carries the new ciphertext.
      if (error) {
        throw new HttpError(500, "db_error", "credential rotation failed", causeCode(error), {
          credential_id: id,
        });
      }
      const { data, error: readErr } = await db
        .from("access_credentials")
        .select(CRED_META_COLUMNS)
        .eq("id", id)
        .single();
      if (readErr) {
        throw new HttpError(500, "db_error", "credential read-back failed", readErr, {
          credential_id: id,
        });
      }
      return data as CredentialMeta;
    },

    // Through fn_revoke_credential (0030). A revoke is the event a client most
    // wants a record of — it is the moment the walker's access to their home
    // ended, and before this it wrote no audit row at all.
    async revokeCredential(id) {
      const { error } = await db.rpc("fn_revoke_credential", {
        p_id: id,
        p_operator: operatorId,
        p_ip: clientIp,
        p_user_agent: userAgent,
      });
      if (error) {
        throw new HttpError(500, "db_error", "credential revoke failed", error, {
          credential_id: id,
        });
      }
    },

    async logReauthFailure(operator, credentialId) {
      const { error } = await db.rpc("fn_log_credential_action", {
        p_credential: credentialId,
        p_operator: operator,
        p_action: "reauth_failed",
        p_purpose: null,
        p_ip: clientIp,
        p_user_agent: userAgent,
        p_walk: null,
      });
      // Thrown, and swallowed by the handler. The caller must be refused either
      // way; a 500 here would tell an attacker they had found a way to turn the
      // audit trail off.
      if (error) throw new HttpError(500, "db_error", "audit write failed", error);
    },

    async readCredential(credentialId, purpose, forOperator, walkId) {
      const { data, error } = await db.rpc("fn_read_credential", {
        p_credential: credentialId,
        p_purpose: purpose,
        p_operator: forOperator,
        p_ip: clientIp,
        p_user_agent: userAgent,
        p_walk: walkId ?? null,
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
  // Truncated here as well as in the SQL: a caller controls this header, and a
  // multi-kilobyte user agent should not reach the database at all.
  const userAgent = req.headers.get("user-agent")?.slice(0, 400) || null;
  const result = await handleVault(
    operator,
    body,
    makeDeps(operator.id, clientIp, userAgent),
  );
  return jsonOk(result);
});
