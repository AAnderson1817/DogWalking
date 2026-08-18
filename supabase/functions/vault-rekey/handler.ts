// vault-rekey core logic (review B2), dependency-injected for tests.
//
// A SEPARATE function from credential-vault on purpose. credential-vault is
// the operator-facing path: it requires an operator JWT and a fresh password
// re-auth on every action. These are machine paths called by CI with the
// service-role key. Adding a non-operator auth path to the most sensitive
// function in the product to save a directory would be a bad trade.
//
// Three actions, and none of them ever returns a plaintext or a key:
//
//   verify  — can the deployed key read this project's data? Decrypts the
//             canary, and installs one if there is none. This is the deploy
//             gate: a wrong key fails here instead of at a client's door.
//   status  — the census, for the rotation report.
//   rekey   — re-encrypt one batch onto the current key. Idempotent and
//             resumable; run it until nothing is left.

import { HttpError } from "../_lib/http.ts";
import { NIL_UUID, VaultBlobError, type VaultBinding } from "../_lib/crypto.ts";

export interface RekeyBody {
  action?: "verify" | "status" | "rekey";
  /** Rows per call. The caller loops; batches keep any single request short. */
  batch?: number;
}

export interface Census {
  total: number;
  on_primary: number;
  on_other: number;
  unreadable: number;
}

export interface RekeyRow {
  id: string;
  operator_id: string;
  ciphertext: Uint8Array;
  key_id: string | null;
}

export interface RekeyDeps {
  /** Key id of the key that currently encrypts. */
  primaryKeyId(): Promise<string>;
  /** Every key id the deployment can decrypt with. */
  heldKeyIds(): Promise<string[]>;
  encrypt(plaintext: string, binding: VaultBinding): Promise<Uint8Array>;
  decrypt(blob: Uint8Array, binding: VaultBinding): Promise<string>;
  census(keyId: string): Promise<Census>;
  readCanary(): Promise<Uint8Array | null>;
  setCanary(blob: Uint8Array): Promise<string>;
  rewrapBatch(keyId: string, limit: number): Promise<RekeyRow[]>;
  /** Compare-and-swap; false ⇒ the row changed under us, which is not an error. */
  applyRewrap(
    id: string,
    expect: Uint8Array,
    next: Uint8Array,
    expectKeyId: string,
  ): Promise<boolean>;
}

/** The canary's plaintext. Fixed and non-secret: its only job is to be
 *  something we know the answer to. */
export const CANARY_PLAINTEXT = "sanpo/vault/canary/v2";
const CANARY_BINDING: VaultBinding = { credentialId: NIL_UUID, operatorId: NIL_UUID };

export async function handleRekey(
  body: RekeyBody,
  deps: RekeyDeps,
): Promise<Record<string, unknown>> {
  const primary = await deps.primaryKeyId();

  switch (body.action) {
    case "verify": {
      const existing = await deps.readCanary();
      if (!existing) {
        // First deploy of a project: adopt the current key. This is the only
        // path that installs a pin, and it can only ever install the key the
        // deployment is already using — it cannot bless a wrong one.
        await deps.setCanary(await deps.encrypt(CANARY_PLAINTEXT, CANARY_BINDING));
        return { ok: true, key_id: primary, canary: "installed" };
      }
      try {
        const plaintext = await deps.decrypt(existing, CANARY_BINDING);
        if (plaintext !== CANARY_PLAINTEXT) {
          // Decrypted, but not to what we wrote. The blob is authentic under
          // a key we hold and still wrong, so this is corruption, not custody.
          // No cause, and no plaintext: the decrypted value is the thing that
          // is wrong, and logging it would log a secret to prove a secret
          // leaked. The key id in context is what identifies the blob.
          throw new HttpError(
            500,
            "canary_mismatch",
            "the vault canary decrypted to the wrong value",
            "authentic under a held key but not the expected plaintext",
          );
        }
      } catch (e) {
        if (e instanceof HttpError) throw e;
        if (e instanceof VaultBlobError && e.code === "key_unknown") {
          // The exact failure this whole design exists to catch, caught at
          // deploy time rather than by an operator at a front door.
          throw new HttpError(
            409,
            "key_mismatch",
            "the deployed vault key cannot read this project's data",
          );
        }
        throw new HttpError(
          500,
          "canary_unreadable",
          "the vault canary could not be decrypted",
          "decrypt threw something other than a VaultBlobError",
        );
      }
      const census = await deps.census(primary);
      // The pin may legitimately be on a retired key mid-rotation; report it
      // rather than failing, because reads still work.
      return { ok: true, key_id: primary, canary: "verified", census };
    }

    case "status": {
      return { ok: true, key_id: primary, held: await deps.heldKeyIds(), census: await deps.census(primary) };
    }

    case "rekey": {
      const limit = Math.max(1, Math.min(body.batch ?? 50, 500));
      const rows = await deps.rewrapBatch(primary, limit);
      let rewrapped = 0;
      let conflicts = 0;
      const unreadable: string[] = [];

      for (const row of rows) {
        const binding: VaultBinding = { credentialId: row.id, operatorId: row.operator_id };
        let plaintext: string;
        try {
          plaintext = await deps.decrypt(row.ciphertext, binding);
        } catch (e) {
          // NOT recorded anywhere as terminal. A row we cannot read today
          // because its key was not supplied becomes readable the moment it
          // is, and a journal marking it dead would destroy that. It stays in
          // the queue and is reported every run until it is fixed.
          unreadable.push(row.id);
          continue;
        }
        const next = await deps.encrypt(plaintext, binding);
        const applied = await deps.applyRewrap(row.id, row.ciphertext, next, primary);
        if (applied) rewrapped += 1;
        else conflicts += 1; // someone rotated it first; the newer blob wins
      }

      const census = await deps.census(primary);
      return {
        ok: true,
        key_id: primary,
        batch: rows.length,
        rewrapped,
        conflicts,
        unreadable,
        remaining: census.on_other + census.unreadable,
        census,
      };
    }

    default:
      throw new HttpError(400, "bad_request", "action must be verify, status or rekey");
  }
}
