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

// ── overage: double-charge protections (0013 redesign) ────────────────────
interface OverageOpts {
  live?: {
    status: "succeeded" | "pending";
    pi?: string | null;
    createdMsAgo?: number;
  };
  piLiveStatus?: string; // what retrievePaymentIntent reports
  declines?: boolean;
  infraFails?: boolean;
}

function makeODeps(opts: OverageOpts = {}) {
  const calls: string[] = [];
  const updates: Array<Record<string, unknown>> = [];
  let attemptKey = "";
  const NOW = 1_700_000_000_000;
  const deps: OverageDeps = {
    getWalk: (id) =>
      Promise.resolve({
        id,
        operator_id: "op-1",
        client_id: "client-1",
        status: "completed",
        is_overage: true,
      }),
    getLiveOveragePayment: (walkId) => {
      calls.push("getLive");
      if (!opts.live) return Promise.resolve(null);
      return Promise.resolve({
        id: "pay-live",
        walk_id: walkId,
        type: "overage" as const,
        amount_pence: 2200,
        status: opts.live.status,
        stripe_payment_intent_id: opts.live.pi ?? null,
        receipt_url: null,
        created_at: new Date(NOW - (opts.live.createdMsAgo ?? 0)).toISOString(),
      });
    },
    retrievePaymentIntent: (piId) => {
      calls.push(`retrievePI:${piId}`);
      return Promise.resolve({ status: opts.piLiveStatus ?? "succeeded", receipt_url: "https://r" });
    },
    getClientBilling: () =>
      Promise.resolve({
        stripe_customer_id: "cus_1",
        plan: { overage_rate_pence: 2200 },
        full_name: "Amelia Hart",
      }),
    createOffSessionPaymentIntent: (args) => {
      calls.push("createPI");
      attemptKey = args.attemptKey;
      if (opts.declines) {
        return Promise.reject({ type: "StripeCardError", message: "declined" });
      }
      if (opts.infraFails) return Promise.reject(new Error("stripe unreachable"));
      return Promise.resolve({ id: "pi_2", status: "succeeded", receipt_url: null });
    },
    insertPayment: (row) => {
      calls.push(`insertPayment:${row.status}`);
      return Promise.resolve({ ...row, id: "pay-new" });
    },
    updatePayment: (id, fields) => {
      calls.push(`updatePayment:${String(fields.status)}`);
      updates.push({ id, ...fields });
      return Promise.resolve({
        id,
        walk_id: "walk-1",
        type: "overage" as const,
        amount_pence: 2200,
        status: fields.status as "succeeded" | "failed" | "pending",
        stripe_payment_intent_id: (fields.stripe_payment_intent_id as string | null) ?? null,
        receipt_url: (fields.receipt_url as string | null) ?? null,
      });
    },
    insertNotification: (row) => {
      calls.push(`notify:${row.client_id === null ? "operator" : "client"}`);
      return Promise.resolve();
    },
    isCardError: (err) => (err as { type?: string })?.type === "StripeCardError",
    now: () => NOW,
  };
  return { deps, calls, updates, attemptKey: () => attemptKey };
}

Deno.test("existing succeeded overage payment short-circuits (no new charge)", async () => {
  const { deps, calls } = makeODeps({ live: { status: "succeeded" } });
  const result = await chargeOverageForWalk("walk-1", deps);
  assertEquals(result.already_charged, true);
  assert(!calls.includes("createPI"));
});

Deno.test("fresh pending claim (no PI yet) blocks a concurrent re-charge", async () => {
  const { deps, calls } = makeODeps({ live: { status: "pending", createdMsAgo: 30_000 } });
  const result = await chargeOverageForWalk("walk-1", deps);
  assertEquals(result.already_charged, true);
  assert(!calls.includes("createPI"), "must not double-charge while an attempt is live");
});

Deno.test("stale id-less pending claim is released and re-attempted", async () => {
  const { deps, calls } = makeODeps({ live: { status: "pending", createdMsAgo: 20 * 60_000 } });
  const result = await chargeOverageForWalk("walk-1", deps);
  assertEquals(result.already_charged, false);
  assert(calls.includes("updatePayment:failed"), "stale claim must be released");
  assert(calls.includes("createPI"));
});

Deno.test("pending claim with a PI reconciles: Stripe says succeeded → settle, no re-charge", async () => {
  const { deps, calls } = makeODeps({
    live: { status: "pending", pi: "pi_9" },
    piLiveStatus: "succeeded",
  });
  const result = await chargeOverageForWalk("walk-1", deps);
  assertEquals(result.already_charged, true);
  assertEquals(result.payment.status, "succeeded");
  assert(calls.includes("retrievePI:pi_9"));
  assert(!calls.includes("createPI"));
});

Deno.test("pending claim with a dead PI is failed and re-charged", async () => {
  const { deps, calls } = makeODeps({
    live: { status: "pending", pi: "pi_9" },
    piLiveStatus: "requires_payment_method",
  });
  const result = await chargeOverageForWalk("walk-1", deps);
  assertEquals(result.already_charged, false);
  assert(calls.includes("updatePayment:failed"));
  assert(calls.includes("createPI"));
});

Deno.test("pending claim with an in-flight PI (processing) is left alone", async () => {
  const { deps, calls } = makeODeps({
    live: { status: "pending", pi: "pi_9" },
    piLiveStatus: "processing",
  });
  const result = await chargeOverageForWalk("walk-1", deps);
  assertEquals(result.already_charged, true);
  assert(!calls.includes("createPI"));
});

Deno.test("fresh charge claims first and uses a per-attempt idempotency key", async () => {
  const { deps, calls, attemptKey } = makeODeps();
  const result = await chargeOverageForWalk("walk-1", deps);
  assertEquals(result.already_charged, false);
  assertEquals(result.payment.status, "succeeded");
  const order = calls.filter((c) => c === "insertPayment:pending" || c === "createPI");
  assertEquals(order, ["insertPayment:pending", "createPI"], "claim row must precede the Stripe confirm");
  assertEquals(attemptKey(), "overage_walk-1_pay-new");
});

Deno.test("card decline fails the claim + notifies both personas, walk stays completed", async () => {
  const { deps, calls } = makeODeps({ declines: true });
  const result = await chargeOverageForWalk("walk-1", deps);
  assertEquals(result.payment.status, "failed");
  assert(calls.includes("updatePayment:failed"));
  assert(calls.includes("notify:client"));
  assert(calls.includes("notify:operator"));
});

Deno.test("infra error leaves the pending claim and rethrows (caller retries)", async () => {
  const { deps, calls } = makeODeps({ infraFails: true });
  await assertRejects(() => chargeOverageForWalk("walk-1", deps));
  assert(calls.includes("insertPayment:pending"));
  assert(!calls.includes("updatePayment:failed"), "claim must survive to block double-charging");
  assert(!calls.includes("notify:client"), "no decline notification for an infra failure");
});
