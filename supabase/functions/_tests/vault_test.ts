// credential-vault handler: rate limit, re-auth gate, purpose requirement,
// soft revoke; plus overage idempotency (mocked deps).
import { assert, assertEquals, assertFalse, assertRejects } from "./asserts.ts";
import {
  type CredentialMeta,
  handleVault,
  makeRateLimiter,
  resolveAssurance,
  type VaultDeps,
} from "../credential-vault/handler.ts";
import { sessionAssurance } from "../_lib/http.ts";
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
  /** Verified MFA factors on the account (review H2). */
  factors?: number;
  /** Whether the account has a password at all (review M2). */
  hasPassword?: boolean;
} = {}): { deps: VaultDeps; calls: string[]; seen: Seen } {
  const calls: string[] = [];
  const seen: Seen = {};
  const blob = new Uint8Array(40);
  const deps: VaultDeps = {
    allowAttempt: () => {
      // Recorded, because M2 is as much about WHEN this runs as whether it
      // allows: it used to run first, so a request that could never succeed
      // still burned a slot in the 5/min window.
      calls.push("allowAttempt");
      return opts.allow ?? true;
    },
    accountHasPassword: (_id) => {
      calls.push("accountHasPassword");
      return Promise.resolve(opts.hasPassword ?? true);
    },
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
    verifiedFactorCount: (_id) => {
      calls.push("verifiedFactorCount");
      return Promise.resolve(opts.factors ?? 0);
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
  // This asserted `calls.length === 0`, which was true only incidentally: the
  // limiter ran first and the fixture did not record it. M2 moved the limiter
  // to sit directly in front of the guess, so an account-state check now
  // legitimately precedes it. The INTENT — nothing is guessed and nothing is
  // read — is unchanged, and is now what the test says.
  assertFalse(calls.includes("verifyPassword"));
  assertFalse(calls.includes("readCredential"));
  assertFalse(calls.includes("decrypt"));
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
  /** PaymentIntent status the charge returns (review H12: only `succeeded` announces). */
  piStatus?: string;
  /** Receipt URL on the PaymentIntent, if any. */
  receiptUrl?: string | null;
}

function makeODeps(opts: OverageOpts = {}) {
  const calls: string[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const notes: Array<Record<string, unknown>> = [];
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
      return Promise.resolve({
        id: "pi_2",
        status: opts.piStatus ?? "succeeded",
        receipt_url: opts.receiptUrl ?? null,
      });
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
      // The ROW is kept, not just the fact of it: H12 is about what the
      // message says — the amount and that money moved — so a test that only
      // counted notifications would pass against a blank one.
      notes.push(row as Record<string, unknown>);
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
  return { deps, calls, updates, notes, attemptKey: () => attemptKey };
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

// ── Assurance: a password alone is not enough when better exists (H2) ──────
// An attacker holding only a live session can call updateUser({password}) with
// NO knowledge of the current password (Supabase secure_password_change is off
// by default and was never deployed to any project), then satisfy the vault's
// password check with the password they just set. They cannot manufacture aal2.

Deno.test("an aal1 session is REFUSED when the account has a verified factor", async () => {
  const { deps } = makeVaultDeps({ factors: 1 });
  const err = await assertRejects(() =>
    handleVault(
      { ...OP, aal: "aal1" },
      { action: "get", credential_id: "cred-1", purpose: "walk", password: "pw" },
      deps,
    )
  );
  assertEquals((err as { code?: string }).code, "second_factor_required");
});

Deno.test("an aal2 session is allowed and never has to count factors", async () => {
  // The strongest case short-circuits: no reason to ask the auth API anything.
  const { deps, calls } = makeVaultDeps({ factors: 1 });
  await handleVault(
    { ...OP, aal: "aal2" },
    { action: "get", credential_id: "cred-1", purpose: "walk", password: "pw" },
    deps,
  );
  assert(calls.includes("readCredential"));
  assertFalse(calls.includes("verifiedFactorCount"), "aal2 needs no factor lookup");
});

Deno.test("an operator with NO factor still gets in — the gate is graduated", async () => {
  // Requiring aal2 unconditionally would lock out every operator who has not
  // enrolled a factor — which, the day the gate ships, is all of them.
  // (An earlier version of this comment said MFA needed the Supabase Pro plan.
  // The first live read-back of the auth config showed TOTP enrol and verify
  // both already enabled, so enrolling is free and available today.)
  const { deps, calls } = makeVaultDeps({ factors: 0 });
  await handleVault(
    { ...OP, aal: "aal1" },
    { action: "get", credential_id: "cred-1", purpose: "walk", password: "pw" },
    deps,
  );
  assert(calls.includes("readCredential"));
});

Deno.test("a MISSING aal claim is treated as aal1, not assumed strong", async () => {
  // This is what a project with no MFA configured emits. Reading strength from
  // an ABSENT claim would be the whole gate failing open.
  const { deps } = makeVaultDeps({ factors: 1 });
  const err = await assertRejects(() =>
    handleVault(
      { ...OP, aal: null },
      { action: "get", credential_id: "cred-1", purpose: "walk", password: "pw" },
      deps,
    )
  );
  assertEquals((err as { code?: string }).code, "second_factor_required");
});

Deno.test("the assurance gate applies to WRITES too, not just reveals", async () => {
  // Rotating a credential with a stolen session is as damaging as reading one:
  // it locks the operator out of their own client's door.
  const { deps } = makeVaultDeps({ factors: 1 });
  await assertRejects(() =>
    handleVault(
      { ...OP, aal: "aal1" },
      { action: "put", credential_id: "cred-1", secret: "9999", password: "pw" },
      deps,
    )
  );
});

Deno.test("resolveAssurance reports the three cases distinctly", async () => {
  const { deps } = makeVaultDeps({ factors: 0 });
  assertEquals(await resolveAssurance({ id: "op-1", aal: "aal2" }, deps), "aal2");
  assertEquals(await resolveAssurance({ id: "op-1", aal: "aal1" }, deps), "aal1_no_factor");
  const withFactor = makeVaultDeps({ factors: 2 }).deps;
  assertEquals(await resolveAssurance({ id: "op-1", aal: "aal1" }, withFactor), "insufficient");
});

Deno.test("sessionAssurance reads the claim, and refuses to guess", () => {
  // Unverified read, safe because verify_jwt is on at the gateway — the same
  // justification the role read has carried since phase 01.
  const tok = (payload: Record<string, unknown>) =>
    `h.${btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}.s`;
  assertEquals(sessionAssurance(`Bearer ${tok({ aal: "aal2" })}`), "aal2");
  assertEquals(sessionAssurance(`Bearer ${tok({ aal: "aal1" })}`), "aal1");
  assertEquals(sessionAssurance(`Bearer ${tok({})}`), null, "absent means unknown, not aal1");
  assertEquals(sessionAssurance(`Bearer ${tok({ aal: "aal3" })}`), null, "an unknown value is not accepted");
  assertEquals(sessionAssurance("Bearer not-a-jwt"), null);
  assertEquals(sessionAssurance(null), null);
});

// ── A magic-link operator is told what is wrong, not locked out (review M2) ──

const GET = { action: "get" as const, credential_id: "cred-1", purpose: "walk", password: "pw" };

/** The refusal's `code`, which is the whole point of the finding. */
async function refusalCode(deps: VaultDeps, body = GET): Promise<string> {
  const err = await assertRejects(() => handleVault(OP, body, deps));
  return (err as { code?: string }).code ?? "(no code)";
}

Deno.test("an account with no password gets a distinct, actionable refusal", async () => {
  const { deps } = makeVaultDeps({ hasPassword: false });
  // Not `reauth_failed`. "Password verification failed" reads as a typo to
  // someone who has no password to mistype, and is what left magic-link
  // operators stuck with no way forward inside the product.
  assertEquals(await refusalCode(deps), "password_not_set");
});

Deno.test("a passwordless account does NOT burn a rate-limit slot", async () => {
  const { deps, calls } = makeVaultDeps({ hasPassword: false });
  await assertRejects(() => handleVault(OP, GET, deps));
  // The second half of M2: five attempts at a password that cannot exist
  // returned 429 and locked the operator out for a minute at a time.
  assertFalse(calls.includes("allowAttempt"));
  // Nothing was guessed, so nothing should have been checked.
  assertFalse(calls.includes("verifyPassword"));
});

Deno.test("the limiter still guards an actual password guess", async () => {
  // The other direction. Moving the limiter must not remove it: a wrong
  // password on a real account is exactly what it exists to bound.
  const { deps, calls } = makeVaultDeps({ hasPassword: true, allow: false });
  assertEquals(await refusalCode(deps), "rate_limited");
  assert(calls.includes("allowAttempt"));
  // Refused before the guess was tried, not after.
  assertFalse(calls.includes("verifyPassword"));
});

Deno.test("a malformed request is refused before it costs a slot", async () => {
  const { deps, calls } = makeVaultDeps();
  await assertRejects(() =>
    handleVault(OP, { action: "get", credential_id: "cred-1", purpose: "walk" }, deps)
  );
  assertFalse(calls.includes("allowAttempt"));
});

// ── H12: an off-session charge the client is actually told about ───────────
//
// `notifyFailure` shipped with no counterpart. A SUCCESSFUL charge sent
// nothing, so the only message the client got was `walk_complete` — "Your walk
// report card is ready" — with no amount and no mention that money had moved.

function clientNote(notes: Array<Record<string, unknown>>, type: string) {
  return notes.find((n) => n.type === type && n.client_id !== null);
}

Deno.test("H12: a successful overage charge tells the client, with the amount", async () => {
  const { deps, notes } = makeODeps();
  const result = await chargeOverageForWalk("walk-1", deps);
  assertEquals(result.payment.status, "succeeded");
  const note = clientNote(notes, "payment_taken");
  assert(note, "a successful off-session charge must notify the client");
  // The amount is the whole point — an announcement without it is not one.
  assert(String(note.title).includes("$22.00"), `title lacked the amount: ${note.title}`);
  assert(String(note.body).includes("$22.00"), `body lacked the amount: ${note.body}`);
  assertEquals(note.walk_id, "walk-1");
});

Deno.test("H12: the receipt travels with the notification when Stripe gave one", async () => {
  const { deps, notes } = makeODeps({ receiptUrl: "https://stripe.test/receipt/abc" });
  await chargeOverageForWalk("walk-1", deps);
  const note = clientNote(notes, "payment_taken")!;
  assert(String(note.body).includes("https://stripe.test/receipt/abc"));
});

Deno.test("H12: no receipt line is invented when Stripe did not give one", async () => {
  const { deps, notes } = makeODeps({ receiptUrl: null });
  await chargeOverageForWalk("walk-1", deps);
  const note = clientNote(notes, "payment_taken")!;
  assertFalse(String(note.body).includes("Receipt:"));
});

/**
 * A `pending` PaymentIntent has taken nothing yet. Announcing it would be
 * contradicted by the decline notification minutes later, which is worse for
 * the client than one message arriving when the money actually moves.
 */
Deno.test("H12: a pending charge announces nothing", async () => {
  const { deps, notes } = makeODeps({ piStatus: "processing" });
  const result = await chargeOverageForWalk("walk-1", deps);
  assertEquals(result.payment.status, "pending");
  assertEquals(clientNote(notes, "payment_taken"), undefined);
});

/** A declined charge must not report that money was taken. */
Deno.test("H12: a declined charge announces no payment", async () => {
  const { deps, notes } = makeODeps({ declines: true });
  await chargeOverageForWalk("walk-1", deps);
  assertEquals(clientNote(notes, "payment_taken"), undefined);
  assert(clientNote(notes, "payment_failed"), "a decline is still the client's to fix");
});

/**
 * A configuration fault is the operator's. The client must hear nothing at
 * all — not a failure (it is not theirs to fix, review B6) and certainly not a
 * payment_taken.
 */
Deno.test("H12: an unconfigured operator does not message the client at all", async () => {
  const { deps, notes } = makeODeps({ noPlan: true });
  await chargeOverageForWalk("walk-1", deps);
  assertEquals(notes.filter((n) => n.client_id !== null).length, 0);
});
