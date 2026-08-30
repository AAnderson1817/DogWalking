// claim-signup: the invite decides whether an account may exist, BEFORE one
// is created (review H31). The ordering is the security property — an
// account created before the check is public signup wearing an invite's
// clothes — so the ordering test drives a deps recorder rather than trusting
// the code's shape.
import { assert, assertEquals, assertRejects } from "./asserts.ts";
import { HttpError } from "../_lib/http.ts";
import {
  type ClaimSignupDeps,
  handleClaimSignup,
  PASSWORD_MIN_LENGTH,
  passwordMeetsPolicy,
} from "../claim-signup/handler.ts";

const TOKEN = "99999999-0000-4000-e000-000000000001";
// Meets the declared posture — length AND lower_upper_letters_digits. The
// first fixture was 12 lowercase letters, i.e. a password the declared
// policy REJECTS, so the suite itself encoded the gap (adversarial review).
const GOOD = {
  token: TOKEN,
  email: "pet-owner@example.com",
  password: "Correct-Horse-9",
};

function recordingDeps(
  outcome: string,
  createResult: "created" | "exists" = "created",
): { deps: ClaimSignupDeps; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      checkInvite(_token, _email) {
        calls.push("checkInvite");
        return Promise.resolve(outcome);
      },
      createUser(_email, _password) {
        calls.push("createUser");
        return Promise.resolve(createResult);
      },
    },
  };
}

/** Deps that blow up when touched — for requests that must be refused on
 * shape alone, learning nothing about any invite and creating nothing. */
const untouchable: ClaimSignupDeps = {
  checkInvite() {
    throw new Error("checkInvite must not run for a malformed request");
  },
  createUser() {
    throw new Error("createUser must not run for a malformed request");
  },
};

Deno.test("a refused invite creates no account — the check runs first", async () => {
  const { deps, calls } = recordingDeps("expired");
  const err = await assertRejects(() => handleClaimSignup(GOOD, deps));
  assert(err instanceof HttpError && err.status === 409, `got ${String(err)}`);
  assertEquals((err as HttpError).code, "expired");
  assertEquals(calls, ["checkInvite"]);
});

Deno.test("every refusal outcome surfaces verbatim as the error code", async () => {
  for (const outcome of ["not_found", "already_claimed", "expired", "revoked", "email_mismatch"]) {
    const { deps, calls } = recordingDeps(outcome);
    const err = await assertRejects(() => handleClaimSignup(GOOD, deps));
    assert(err instanceof HttpError, `outcome ${outcome}: got ${String(err)}`);
    assertEquals((err as HttpError).code, outcome);
    assertEquals(calls, ["checkInvite"], `outcome ${outcome} reached createUser`);
  }
});

Deno.test("an outcome this code has never seen is a 500, not a user error", async () => {
  const { deps } = recordingDeps("some_future_outcome");
  const err = await assertRejects(() => handleClaimSignup(GOOD, deps));
  assert(err instanceof HttpError && err.status === 500, `got ${String(err)}`);
});

Deno.test("a live invite creates the account and reports success", async () => {
  const { deps, calls } = recordingDeps("claimed");
  const res = await handleClaimSignup(GOOD, deps);
  assertEquals(res, { registered: true });
  assertEquals(calls, ["checkInvite", "createUser"]);
});

Deno.test("an already-registered address collapses into the same success", async () => {
  // A distinct answer would make the public endpoint an account-existence
  // oracle for anyone holding a live invite with no bound email; the
  // frontend's sign-in attempt is the rate-limited place that distinction
  // already lives.
  const { deps } = recordingDeps("claimed", "exists");
  const res = await handleClaimSignup(GOOD, deps);
  assertEquals(res, { registered: true });
});

Deno.test("a policy-breaking password is refused before any dependency runs", async () => {
  // The declared posture is length AND character classes: a 12-char
  // all-lowercase password passes a bare length check and is exactly what
  // `lower_upper_letters_digits` exists to refuse.
  for (const password of [
    "Aa1".padEnd(PASSWORD_MIN_LENGTH - 1, "x"), // too short
    "a".repeat(PASSWORD_MIN_LENGTH + 4),        // no upper, no digit
    "A".repeat(PASSWORD_MIN_LENGTH + 4),        // no lower, no digit
    "Aa".repeat(PASSWORD_MIN_LENGTH),           // no digit
  ]) {
    const err = await assertRejects(() =>
      handleClaimSignup({ ...GOOD, password }, untouchable)
    );
    assert(err instanceof HttpError && err.status === 400, `${password}: got ${String(err)}`);
    assertEquals((err as HttpError).code, "weak_password", password);
  }
  assert(passwordMeetsPolicy(GOOD.password), "the happy fixture must meet the policy it tests");
});

Deno.test("a malformed token is refused before any dependency runs", async () => {
  for (const token of ["", "not-a-uuid", TOKEN.slice(0, -1), `${TOKEN}0`]) {
    const err = await assertRejects(() =>
      handleClaimSignup({ ...GOOD, token }, untouchable)
    );
    assert(err instanceof HttpError && err.status === 400, `token ${token}: got ${String(err)}`);
  }
});

Deno.test("a malformed email is refused before any dependency runs", async () => {
  for (const email of ["", "no-at-sign", "a@" + "x".repeat(320)]) {
    const err = await assertRejects(() =>
      handleClaimSignup({ ...GOOD, email }, untouchable)
    );
    assert(err instanceof HttpError && err.status === 400, `email ${email}: got ${String(err)}`);
  }
});

Deno.test("check and createUser see the IDENTICAL trimmed email — the invariant the design rests on", async () => {
  // 0045's contract is that the email the check validated is the email the
  // account is created with. Pinning only the check's arguments left the
  // other half free to drift to the raw input (adversarial review).
  const seen: Array<{ call: string; token?: string; email?: string }> = [];
  const deps: ClaimSignupDeps = {
    checkInvite(token, email) {
      seen.push({ call: "checkInvite", token, email });
      return Promise.resolve("claimed");
    },
    createUser(email) {
      seen.push({ call: "createUser", email });
      return Promise.resolve("created");
    },
  };
  await handleClaimSignup(
    { token: `  ${TOKEN} `, email: " pet-owner@example.com ", password: GOOD.password },
    deps,
  );
  assertEquals(seen, [
    { call: "checkInvite", token: TOKEN, email: "pet-owner@example.com" },
    { call: "createUser", email: "pet-owner@example.com" },
  ]);
});
