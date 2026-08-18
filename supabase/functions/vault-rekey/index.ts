// vault-rekey — POST, service-role only (review B2).
//
// Deploy verification and key rotation. Never returns a plaintext or any key
// material; the only secrets it touches are in memory for the length of one
// re-encryption.
import {
  HttpError,
  isServiceAuth,
  jsonOk,
  readJson,
  serveFunction,
} from "../_lib/http.ts";
import { adminClient } from "../_lib/admin.ts";
import {
  bytesToPgHex,
  decryptSecret,
  encryptSecret,
  importVaultKey,
  pgHexToBytes,
  type VaultKey,
} from "../_lib/crypto.ts";
import { handleRekey, type RekeyBody, type RekeyDeps, type RekeyRow } from "./handler.ts";

interface KeyRing {
  primary: VaultKey;
  byId: Map<string, VaultKey>;
}

let ring: KeyRing | null = null;

/** Same ring as credential-vault: the current key encrypts and decrypts, a
 *  retired key only decrypts. `none` is the explicit tombstone for "there is
 *  no retired key", so retiring one is a deliberate value rather than an
 *  absent variable that could equally mean a mis-typed secret name. */
async function getRing(): Promise<KeyRing> {
  if (ring) return ring;
  const primaryRaw = Deno.env.get("VAULT_MASTER_KEY");
  if (!primaryRaw) {
    throw new HttpError(500, "vault_key_missing", "the vault key is not configured");
  }
  const primary = await importVaultKey(primaryRaw);
  const byId = new Map<string, VaultKey>([[primary.id, primary]]);
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

function makeDeps(): RekeyDeps {
  const db = adminClient();
  return {
    async primaryKeyId() {
      return (await getRing()).primary.id;
    },
    async heldKeyIds() {
      return [...(await getRing()).byId.keys()];
    },
    async encrypt(plaintext, binding) {
      return await encryptSecret((await getRing()).primary, plaintext, binding);
    },
    async decrypt(blob, binding) {
      // Deliberately NOT wrapped in HttpError here: handleRekey distinguishes
      // key_unknown from corruption, and needs the VaultBlobError to do it.
      return await decryptSecret((await getRing()).byId, blob, binding);
    },
    async census(keyId) {
      const { data, error } = await db.rpc("fn_vault_census", { p_key_id: keyId });
      if (error) throw new HttpError(500, "db_error", "vault census failed");
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, number> | null;
      return {
        total: Number(row?.total ?? 0),
        on_primary: Number(row?.on_primary ?? 0),
        on_other: Number(row?.on_other ?? 0),
        unreadable: Number(row?.unreadable ?? 0),
      };
    },
    async readCanary() {
      const { data, error } = await db.from("vault_canary").select("ciphertext").maybeSingle();
      if (error) throw new HttpError(500, "db_error", "canary lookup failed");
      return data?.ciphertext ? pgHexToBytes(data.ciphertext as string) : null;
    },
    async setCanary(blob) {
      const { data, error } = await db.rpc("fn_vault_set_canary", {
        p_ciphertext: bytesToPgHex(blob),
      });
      if (error) throw new HttpError(500, "db_error", "canary write failed");
      return String(data);
    },
    async rewrapBatch(keyId, limit) {
      const { data, error } = await db.rpc("fn_vault_rewrap_batch", {
        p_key_id: keyId,
        p_limit: limit,
      });
      if (error) throw new HttpError(500, "db_error", "rewrap batch failed");
      return ((data ?? []) as Array<Record<string, unknown>>).map((r): RekeyRow => ({
        id: String(r.id),
        operator_id: String(r.operator_id),
        ciphertext: pgHexToBytes(String(r.ciphertext)),
        key_id: r.key_id === null ? null : String(r.key_id),
      }));
    },
    async applyRewrap(id, expect, next, expectKeyId) {
      const { data, error } = await db.rpc("fn_vault_rewrap_apply", {
        p_id: id,
        p_expect_ciphertext: bytesToPgHex(expect),
        p_new_ciphertext: bytesToPgHex(next),
        p_expect_key_id: expectKeyId,
      });
      if (error) throw new HttpError(500, "db_error", "rewrap apply failed");
      return Boolean(data);
    },
  };
}

serveFunction(async (req) => {
  // Service-role only. There is no operator path: rotation is an operational
  // act performed by CI, and the census counts rows across every tenant.
  if (!isServiceAuth(req.headers.get("Authorization"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "")) {
    throw new HttpError(403, "forbidden", "service role required");
  }
  const body = await readJson<RekeyBody>(req);
  return jsonOk(await handleRekey(body, makeDeps()));
});
