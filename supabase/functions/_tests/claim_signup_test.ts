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
} from "../claim-signup/handler.ts";

const TOKEN = "99999999-0000-4000-e000-000000000001";
const GOOD = {
  token: TOKEN,
  email: "pet-owner@example.com",
  password: "a".repeat(PASSWORD_MIN_LENGTH),
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

Deno.test("a short password is refused before any dependency runs", async () => {
  const err = await assertRejects(() =>
    handleClaimSignup({ ...GOOD, password: "a".repeat(PASSWORD_MIN_LENGTH - 1) }, untouchable)
  );
  assert(err instanceof HttpError && err.status === 400, `got ${String(err)}`);
  assertEquals((err as HttpError).code, "weak_password");
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

Deno.test("token and email are trimmed before the check sees them", async () => {
  let seen: { token?: string; email?: string } = {};
  const deps: ClaimSignupDeps = {
    checkInvite(token, email) {
      seen = { token, email };
      return Promise.resolve("claimed");
    },
    createUser: () => Promise.resolve("created"),
  };
  await handleClaimSignup(
    { token: `  ${TOKEN} `, email: " pet-owner@example.com ", password: GOOD.password },
    deps,
  );
  assertEquals(seen, { token: TOKEN, email: "pet-owner@example.com" });
});
