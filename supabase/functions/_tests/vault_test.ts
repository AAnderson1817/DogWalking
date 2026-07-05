// credential-vault handler: rate limit, re-auth gate, purpose requirement,
// soft revoke; plus overage idempotency (mocked deps).
import { assert, assertEquals, assertRejects } from "./asserts.ts";
import { handleVault, makeRateLimiter, type VaultDeps, type CredentialMeta } from "../credential-vault/handler.ts";
import { chargeOverageForWalk, type OverageDeps } from "../_lib/overage.ts";

const OP = { id: "op-1", email: "op@pawtrail.dev" };

function cred(overrides: Partial<CredentialMeta> = {}): CredentialMeta {
  return {
    id: "cred-1",
    operator_id: "op-1",
    property_id: "prop-1",
    entry_method: "lockbox",
    label: "Front door",
    key_location_hint: null,
    rotated_at: null,
    revoked_at: null,
    ...overrides,
  };
}

function makeVaultDeps(opts: {
  passwordOk?: boolean;
  allow?: boolean;
  credential?: CredentialMeta | null;
} = {}): { deps: VaultDeps; calls: string[] } {
  const calls: string[] = [];
  const blob = new Uint8Array(40);
  const deps: VaultDeps = {
    allowAttempt: () => opts.allow ?? true,
    verifyPassword: (_e, _p) => {
      calls.push("verifyPassword");
      return Promise.resolve(opts.passwordOk ?? true);
    },
    encrypt: (_pt) => {
      calls.push("encrypt");
      return Promise.resolve(blob);
    },
    decrypt: (_b) => {
      calls.push("decrypt");
      return Promise.resolve("s3cret");
    },
    getProperty: (id) => Promise.resolve(id === "prop-1" ? { id, operator_id: "op-1" } : null),
    getCredential: (_id) =>
      Promise.resolve(opts.credential === undefined ? cred() : opts.credential),
    insertCredential: (_row) => {
      calls.push("insertCredential");
      return Promise.resolve(cred());
    },
    rotateCredential: (_id, _f) => {
      calls.push("rotateCredential");
      return Promise.resolve(cred({ rotated_at: "2026-07-01T00:00:00Z" }));
    },
    revokeCredential: (_id) => {
      calls.push("revokeCredential");
      return Promise.resolve();
    },
    readCredential: (_c, _p, _o) => {
      calls.push("readCredential");
      return Promise.resolve({ ciphertext: blob, label: "Front door", entry_method: "lockbox" });
    },
  };
  return { deps, calls };
}

Deno.test("rate limit rejects before any password attempt", async () => {
  const { deps, calls } = makeVaultDeps({ allow: false });
  await assertRejects(() =>
    handleVault(OP, { action: "get", credential_id: "cred-1", purpose: "walk", password: "pw" }, deps)
  );
  assertEquals(calls.length, 0);
});

Deno.test("wrong password rejects every action", async () => {
  const { deps, calls } = makeVaultDeps({ passwordOk: false });
  await assertRejects(() =>
    handleVault(OP, { action: "get", credential_id: "cred-1", purpose: "walk", password: "bad" }, deps)
  );
  assert(calls.includes("verifyPassword"));
  assert(!calls.includes("readCredential"));
});

Deno.test("get requires a non-empty purpose", async () => {
  const { deps } = makeVaultDeps();
  await assertRejects(() =>
    handleVault(OP, { action: "get", credential_id: "cred-1", purpose: "  ", password: "pw" }, deps)
  );
});

Deno.test("get decrypts through the audited read path", async () => {
  const { deps, calls } = makeVaultDeps();
  const result = await handleVault(
    OP,
    { action: "get", credential_id: "cred-1", purpose: "pre-walk entry", password: "pw" },
    deps,
  );
  assertEquals(result.secret, "s3cret");
  assertEquals(result.entry_method, "lockbox");
  assert(calls.indexOf("readCredential") < calls.indexOf("decrypt"));
});

Deno.test("put on a new credential encrypts and never echoes the secret", async () => {
  const { deps, calls } = makeVaultDeps();
  const result = await handleVault(
    OP,
    {
      action: "put",
      property_id: "prop-1",
      entry_method: "door_code",
      secret: "4711#",
      label: "Side gate",
      password: "pw",
    },
    deps,
  );
  assert(calls.includes("encrypt"));
  assert(calls.includes("insertCredential"));
  assertEquals(JSON.stringify(result).includes("4711#"), false);
});

Deno.test("rotating a revoked credential is rejected", async () => {
  const { deps } = makeVaultDeps({ credential: cred({ revoked_at: "2026-01-01T00:00:00Z" }) });
  await assertRejects(() =>
    handleVault(OP, { action: "put", credential_id: "cred-1", secret: "new", password: "pw" }, deps)
  );
});

Deno.test("delete soft-revokes", async () => {
  const { deps, calls } = makeVaultDeps();
  const result = await handleVault(
    OP,
    { action: "delete", credential_id: "cred-1", password: "pw" },
    deps,
  );
  assertEquals(result.revoked, true);
  assert(calls.includes("revokeCredential"));
});

Deno.test("cross-tenant credential access is invisible (404)", async () => {
  const { deps } = makeVaultDeps({ credential: cred({ operator_id: "op-2" }) });
  await assertRejects(() =>
    handleVault(OP, { action: "delete", credential_id: "cred-1", password: "pw" }, deps)
  );
});

Deno.test("rate limiter allows 5/min then blocks, sliding window", () => {
  let t = 0;
  const allow = makeRateLimiter(5, 60_000, () => t);
  for (let i = 0; i < 5; i++) assert(allow("u1"));
  assert(!allow("u1"));
  assert(allow("u2")); // independent per user
  t = 61_000; // window slides
  assert(allow("u1"));
});

// ── overage idempotency ────────────────────────────────────────────────────
function makeOverageDeps(opts: { existing?: boolean; declines?: boolean }) {
  const calls: string[] = [];
  const deps: OverageDeps = {
    getWalk: (id) =>
      Promise.resolve({
        id,
        operator_id: "op-1",
        client_id: "client-1",
        status: "completed",
        is_overage: true,
      }),
    getSucceededOveragePayment: (walkId) => {
      calls.push("getSucceededOveragePayment");
      return Promise.resolve(
        opts.existing
          ? {
            walk_id: walkId,
            type: "overage",
            amount_pence: 2200,
            status: "succeeded",
            stripe_payment_intent_id: "pi_1",
            receipt_url: null,
          }
          : null,
      );
    },
    getClientBilling: () =>
      Promise.resolve({
        stripe_customer_id: "cus_1",
        plan: { overage_rate_pence: 2200 },
        full_name: "Amelia Hart",
      }),
    createOffSessionPaymentIntent: () => {
      calls.push("createPI");
      if (opts.declines) return Promise.reject(new Error("card_declined"));
      return Promise.resolve({ id: "pi_2", status: "succeeded", receipt_url: null });
    },
    insertPayment: (row) => {
      calls.push(`insertPayment:${row.status}`);
      return Promise.resolve(row);
    },
    insertNotification: (row) => {
      calls.push(`notify:${row.client_id === null ? "operator" : "client"}`);
      return Promise.resolve();
    },
  };
  return { deps, calls };
}

Deno.test("existing succeeded overage payment short-circuits (no new charge)", async () => {
  const { deps, calls } = makeOverageDeps({ existing: true });
  const result = await chargeOverageForWalk("walk-1", deps);
  assertEquals(result.already_charged, true);
  assert(!calls.includes("createPI"));
});

Deno.test("card decline records failed payment + notifies both personas, walk stays completed", async () => {
  const { deps, calls } = makeOverageDeps({ declines: true });
  const result = await chargeOverageForWalk("walk-1", deps);
  assertEquals(result.payment.status, "failed");
  assert(calls.includes("insertPayment:failed"));
  assert(calls.includes("notify:client"));
  assert(calls.includes("notify:operator"));
});
