// credential-vault handler: rate limit, re-auth gate, purpose requirement,
// soft revoke; plus overage idempotency (mocked deps).
import { assert, assertEquals, assertFalse, assertRejects } from "./asserts.ts";
import { handleVault, makeRateLimiter, type VaultDeps, type CredentialMeta } from "../credential-vault/handler.ts";
import type { VaultBinding } from "../_lib/crypto.ts";
import { chargeOverageForWalk, type OverageDeps } from "../_lib/overage.ts";

const OP = { id: "op-1", email: "op@pawtrail.dev" };

function cred(overrides: Partial<CredentialMeta> = {}): CredentialMeta {
  return {
    id: "cred-1",
    operator_id: "op-1",
    property_id: "prop-1",
    entry_method: "lockbox",
    label: "Front door",
    rotated_at: null,
    revoked_at: null,
    ...overrides,
  };
}

interface Seen {
  encryptBinding?: VaultBinding;
  decryptBinding?: VaultBinding;
  insertedId?: string;
  /** Which credential a failed re-auth was reaching for (review H3). */
  reauthFailureFor?: string | null;
  /** The walk a reveal was attributed to, if any. */
  readWalkId?: string;
}

function makeVaultDeps(opts: {
  passwordOk?: boolean;
  allow?: boolean;
  credential?: CredentialMeta | null;
} = {}): { deps: VaultDeps; calls: string[]; seen: Seen } {
  const calls: string[] = [];
  const seen: Seen = {};
  const blob = new Uint8Array(40);
  const deps: VaultDeps = {
    allowAttempt: () => opts.allow ?? true,
    verifyPassword: (_e, _p) => {
      calls.push("verifyPassword");
      return Promise.resolve(opts.passwordOk ?? true);
    },
    // The fakes RECORD the binding. Ignoring it would let the handler bind a
    // blob to the wrong row and every one of these tests would still pass —
    // and the resulting ciphertext is unreadable forever, so it is exactly the
    // mistake that must not be caught only in production.
    encrypt: (_pt, binding) => {
      calls.push("encrypt");
      seen.encryptBinding = binding;
      return Promise.resolve(blob);
    },
    decrypt: (_b, binding) => {
      calls.push("decrypt");
      seen.decryptBinding = binding;
      return Promise.resolve("s3cret");
    },
    logReauthFailure: (_op, credentialId) => {
      calls.push("logReauthFailure");
      seen.reauthFailureFor = credentialId;
      return Promise.resolve();
    },
    getProperty: (id) => Promise.resolve(id === "prop-1" ? { id, operator_id: "op-1" } : null),
    getCredential: (_id) =>
      Promise.resolve(opts.credential === undefined ? cred() : opts.credential),
    insertCredential: (row) => {
      calls.push("insertCredential");
      seen.insertedId = row.id;
      return Promise.resolve(cred({ id: row.id }));
    },
    rotateCredential: (_id, _f) => {
      calls.push("rotateCredential");
      return Promise.resolve(cred({ rotated_at: "2026-07-01T00:00:00Z" }));
    },
    revokeCredential: (_id) => {
      calls.push("revokeCredential");
      return Promise.resolve();
    },
    readCredential: (_c, _p, _o, walkId) => {
      calls.push("readCredential");
      seen.readWalkId = walkId;
      return Promise.resolve({ ciphertext: blob, label: "Front door", entry_method: "lockbox" });
    },
  };
  return { deps, calls, seen };
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
  /** null plan → no overage rate to charge (operator has configured nothing). */
  noPlan?: boolean;
  /** null customer → checkout never completed for this client. */
  noCustomer?: boolean;
  /** resolveAccount throws → operator has not connected Stripe. */
  notConnected?: boolean;
  /** Stripe rejects the request itself — retrying cannot fix it. */
  permanentFails?: boolean;
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
        stripe_customer_id: opts.noCustomer ? null : "cus_1",
        plan: opts.noPlan ? null : { overage_rate_pence: 2200 },
        full_name: "Amelia Hart",
      }),
    resolveAccount: () => {
      if (opts.notConnected) throw new Error("stripe_not_connected");
      return { stripeAccount: "acct_1" };
    },
    createOffSessionPaymentIntent: (args) => {
      calls.push("createPI");
      attemptKey = args.attemptKey;
      if (opts.declines) {
        return Promise.reject({ type: "StripeCardError", message: "declined" });
      }
      if (opts.permanentFails) {
        return Promise.reject({ type: "StripeInvalidRequestError", code: "resource_missing" });
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
    isPermanentError: (err) => {
      const e = err as { type?: string; code?: string; message?: string } | null;
      return e?.type === "StripeInvalidRequestError" ||
        e?.code === "resource_missing" ||
        e?.message === "no payment method on file";
    },
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

Deno.test("stale id-less pending claim reuses the original claim idempotency key", async () => {
  const { deps, calls, attemptKey } = makeODeps({
    live: { status: "pending", createdMsAgo: 20 * 60_000 },
  });
  const result = await chargeOverageForWalk("walk-1", deps);
  assertEquals(result.already_charged, false);
  assert(!calls.includes("insertPayment:pending"), "must not create a replacement claim");
  assert(!calls.includes("updatePayment:failed"), "must not release ambiguous claims as failed");
  assert(calls.includes("createPI"));
  assertEquals(attemptKey(), "overage_walk-1_pay-live");
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

// ── The binding is the thing that makes a blob readable at all ─────────────

Deno.test("create binds the blob to the id it actually inserts", async () => {
  const { deps, seen } = makeVaultDeps({ credential: null });
  await handleVault(OP, { action: "put", password: "pw", property_id: "prop-1", entry_method: "lockbox", secret: "1234" }, deps);
  // The id must be minted BEFORE encryption and be the same one stored: the
  // credential_id is inside the AAD, so a mismatch here produces a row whose
  // ciphertext can never be decrypted, and nothing would notice until an
  // operator stood at a door.
  assert(seen.insertedId, "no id was inserted");
  assertEquals(seen.encryptBinding?.credentialId, seen.insertedId);
  assertEquals(seen.encryptBinding?.operatorId, OP.id);
});

Deno.test("rotate binds to the existing credential, not a fresh id", async () => {
  const { deps, seen } = makeVaultDeps({ credential: cred({ id: "cred-7" }) });
  await handleVault(OP, { action: "put", password: "pw", credential_id: "cred-7", secret: "9999" }, deps);
  assertEquals(seen.encryptBinding?.credentialId, "cred-7");
  assertEquals(seen.encryptBinding?.operatorId, OP.id);
});

Deno.test("get binds to the credential being read", async () => {
  const { deps, seen } = makeVaultDeps();
  await handleVault(OP, { action: "get", password: "pw", credential_id: "cred-1", purpose: "at the door" }, deps);
  assertEquals(seen.decryptBinding?.credentialId, "cred-1");
  assertEquals(seen.decryptBinding?.operatorId, OP.id);
});

Deno.test("a create binding is never reused across two credentials", async () => {
  const a = makeVaultDeps({ credential: null });
  await handleVault(OP, { action: "put", password: "pw", property_id: "prop-1", entry_method: "lockbox", secret: "1" }, a.deps);
  const b = makeVaultDeps({ credential: null });
  await handleVault(OP, { action: "put", password: "pw", property_id: "prop-1", entry_method: "lockbox", secret: "2" }, b.deps);
  assert(
    a.seen.encryptBinding?.credentialId !== b.seen.encryptBinding?.credentialId,
    "two creates must not share a credential id",
  );
});

// ── Whose fault is it? (review B6) ─────────────────────────────────────────
// An un-configured operator used to dun their own customers: every walk sent
// the pet owner "we couldn't charge for your walk, please update your payment
// method" when the real cause was that the operator had never made a plan.

Deno.test("no plan on file tells the OPERATOR only", async () => {
  const { deps, calls } = makeODeps({ noPlan: true });
  const result = await chargeOverageForWalk("walk-1", deps);
  assertEquals(result.payment.status, "failed");
  assert(calls.includes("notify:operator"), "the operator must hear about it");
  assert(
    !calls.includes("notify:client"),
    "the client cannot fix a missing plan and must not be blamed for it",
  );
});

Deno.test("no billing profile tells the OPERATOR only", async () => {
  // No Stripe customer means checkout never completed, so the client has no
  // payment method to update and no unaided way to add one.
  const { deps, calls } = makeODeps({ noCustomer: true });
  await chargeOverageForWalk("walk-1", deps);
  assert(calls.includes("notify:operator"));
  assertFalse(calls.includes("notify:client"));
});

Deno.test("an unconnected Stripe account tells the OPERATOR only, and records the walk", async () => {
  const { deps, calls } = makeODeps({ notConnected: true });
  const result = await chargeOverageForWalk("walk-1", deps);
  // The walk happened; the record of it survives as a failed charge rather
  // than the whole completion throwing.
  assertEquals(result.payment.status, "failed");
  assert(calls.includes("notify:operator"));
  assertFalse(calls.includes("notify:client"));
  assertFalse(calls.includes("createPI"), "must not attempt a charge it cannot route");
});

Deno.test("a declined CARD still tells both — that one is the client's to fix", async () => {
  const { deps, calls } = makeODeps({ declines: true });
  await chargeOverageForWalk("walk-1", deps);
  assert(calls.includes("notify:client"), "a card decline is the client's to act on");
  assert(calls.includes("notify:operator"));
});

// ── Three-way error taxonomy (review H13) ──────────────────────────────────
// Every non-card failure used to be treated as transient: rethrown, leaving
// the claim pending. So a PERMANENT failure — a customer that does not exist
// on this account, a malformed request — left the walk uncompletable and every
// retry hit the same wall forever.

Deno.test("a permanent failure resolves the claim instead of wedging the walk", async () => {
  const { deps, calls } = makeODeps({ permanentFails: true });
  const result = await chargeOverageForWalk("walk-1", deps);
  assertEquals(result.payment.status, "failed");
  assert(
    calls.includes("updatePayment:failed"),
    "the claim must be resolved so the walk can complete and the debt is visible",
  );
});

Deno.test("a permanent failure is the OPERATOR's to fix, not the client's", async () => {
  // Nothing the client can do about a customer missing from the operator's
  // Stripe account — telling them to update a payment method is wrong.
  const { deps, calls } = makeODeps({ permanentFails: true });
  await chargeOverageForWalk("walk-1", deps);
  assert(calls.includes("notify:operator"));
  assertFalse(calls.includes("notify:client"));
});

Deno.test("a TRANSIENT failure still keeps the claim pending and rethrows", async () => {
  // The distinction is the whole point: Stripe being briefly unreachable must
  // NOT resolve the claim, because the charge may yet have gone through.
  const { deps, calls } = makeODeps({ infraFails: true });
  await assertRejects(() => chargeOverageForWalk("walk-1", deps));
  assertFalse(
    calls.includes("updatePayment:failed"),
    "a transient fault must leave the claim pending — the charge may have landed",
  );
});

Deno.test("a card decline is still its own class — client told, claim failed", async () => {
  const { deps, calls } = makeODeps({ declines: true });
  const result = await chargeOverageForWalk("walk-1", deps);
  assertEquals(result.payment.status, "failed");
  assert(calls.includes("notify:client"));
});

// ── The audit trail records every event, not one in four (review H3) ───────
// `credential_access_log` was written in exactly one place — inside
// fn_read_credential, on a SUCCESSFUL reveal. Create, rotate, revoke and a
// failed re-auth wrote nothing, so the trail could answer neither "who changed
// my garage code on the 14th" nor "did anybody try to open my door".

Deno.test("a FAILED re-auth is recorded — the event an attacker wants missing", async () => {
  // Previously somebody with a live session could try passwords against the
  // vault until the rate limiter stopped them and leave no trace whatsoever.
  const { deps, calls, seen } = makeVaultDeps({ passwordOk: false });
  await assertRejects(() =>
    handleVault(OP, { action: "get", credential_id: "cred-1", purpose: "walk", password: "bad" }, deps)
  );
  assert(calls.includes("logReauthFailure"), "a failed re-auth left no audit row");
  assertEquals(seen.reauthFailureFor, "cred-1", "the row must name what was being reached for");
});

Deno.test("a failed re-auth naming no credential still records", async () => {
  const { deps, calls, seen } = makeVaultDeps({ passwordOk: false });
  await assertRejects(() => handleVault(OP, { action: "delete", password: "bad" }, deps));
  assert(calls.includes("logReauthFailure"));
  assertEquals(seen.reauthFailureFor, null);
});

Deno.test("the caller is still refused when the audit write itself fails", async () => {
  // A 500 here would tell an attacker they had found a way to turn the audit
  // trail off. The refusal is what matters; the log is best-effort.
  const { deps, calls } = makeVaultDeps({ passwordOk: false });
  deps.logReauthFailure = () => {
    calls.push("logReauthFailure");
    return Promise.reject(new Error("audit table gone"));
  };
  const err = await assertRejects(() =>
    handleVault(OP, { action: "get", credential_id: "cred-1", purpose: "walk", password: "bad" }, deps)
  );
  assert(calls.includes("logReauthFailure"));
  assertEquals((err as { code?: string }).code, "reauth_failed", "the refusal must survive");
});

Deno.test("a reveal passes the walk through, so the purpose is not the only witness", async () => {
  // The purpose is typed by the person under suspicion. A walk reference is
  // something the system knows independently, and 0030 validates it against
  // both the operator and the property.
  const { deps, seen } = makeVaultDeps();
  await handleVault(
    OP,
    { action: "get", credential_id: "cred-1", purpose: "pre-walk entry", password: "pw", walk_id: "walk-7" },
    deps,
  );
  assertEquals(seen.readWalkId, "walk-7");
});

Deno.test("a reveal without a walk still works — the field is optional", async () => {
  const { deps, seen } = makeVaultDeps();
  await handleVault(
    OP,
    { action: "get", credential_id: "cred-1", purpose: "ad-hoc check", password: "pw" },
    deps,
  );
  assertEquals(seen.readWalkId, undefined);
});

Deno.test("the credential metadata no longer carries a key location hint", async () => {
  // The field was an ordinary column, client-readable, rendered with no
  // re-auth and no audit row, and its placeholder coached a means of entry.
  // Asserted on the RESPONSE because that is what a borrowed session sees.
  const { deps } = makeVaultDeps();
  const res = await handleVault(
    OP,
    {
      action: "put",
      property_id: "prop-1",
      entry_method: "lockbox",
      label: "Front door",
      secret: "1234",
      password: "pw",
    },
    deps,
  );
  const meta = (res as { credential: Record<string, unknown> }).credential;
  assert(!("key_location_hint" in meta), "the hint is back in the vault response");
});
