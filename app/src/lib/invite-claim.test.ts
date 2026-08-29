import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Review H4: `claimInvite` maps the outcome the database returns onto a
 * sentence the person can act on.
 *
 * The old code threw whatever PostgREST gave it and `ClaimInvite.tsx` then
 * matched the substring "claim" against the message — so an expired link, a
 * withdrawn one, and a genuine network failure all rendered as "This invite
 * has already been claimed." Two of those three were wrong, and the third sent
 * somebody to sign in to an account that does not exist.
 *
 * The outcomes are DATA, not exceptions, and that is load-bearing rather than
 * stylistic: `fn_claim_invite` writes an audit row for every attempt, and a
 * PL/pgSQL `raise` rolls the transaction back to the caller's savepoint,
 * discarding it. Log-then-raise records only the attempts that succeeded.
 */

const rpc = vi.fn();
vi.mock("./supabase", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

const { claimInvite, InviteClaimError, INVITE_CLAIM_MESSAGE, inviteState } = await import("./api");

beforeEach(() => rpc.mockReset());

describe("claimInvite", () => {
  it("returns the client id on a successful claim", async () => {
    rpc.mockResolvedValue({ data: [{ client_id: "c-1", outcome: "claimed" }], error: null });
    await expect(claimInvite("tok")).resolves.toBe("c-1");
  });

  const refusals = ["not_found", "already_claimed", "expired", "revoked", "email_mismatch"] as const;

  it.each(refusals)("turns %s into its own actionable sentence", async (outcome) => {
    rpc.mockResolvedValue({ data: [{ client_id: null, outcome }], error: null });
    await expect(claimInvite("tok")).rejects.toMatchObject({ outcome });
    await claimInvite("tok").catch((e: unknown) => {
      expect(e).toBeInstanceOf(InviteClaimError);
      expect((e as Error).message).toBe(INVITE_CLAIM_MESSAGE[outcome]);
    });
  });

  /** Every refusal must read differently, or the mapping is decoration. */
  it("gives each refusal a distinct message", () => {
    const seen = new Set(refusals.map((r) => INVITE_CLAIM_MESSAGE[r]));
    expect(seen.size).toBe(refusals.length);
  });

  /** Expired and withdrawn ask for different things from the reader. */
  it("does not describe a withdrawn invite as expired", () => {
    expect(INVITE_CLAIM_MESSAGE.revoked).not.toMatch(/expire/i);
    expect(INVITE_CLAIM_MESSAGE.expired).toMatch(/expire/i);
  });

  /**
   * A claim that reports success but carries no client id is not a claim. The
   * old contract returned a bare uuid, so there was no way to express this;
   * treating it as success would navigate a signed-up account into a portal it
   * was never bound to.
   */
  it("refuses a 'claimed' outcome with no client id", async () => {
    rpc.mockResolvedValue({ data: [{ client_id: null, outcome: "claimed" }], error: null });
    await expect(claimInvite("tok")).rejects.toBeInstanceOf(InviteClaimError);
  });

  it("treats an empty result as not_found rather than as a claim", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await expect(claimInvite("tok")).rejects.toMatchObject({ outcome: "not_found" });
  });

  /** A transport failure is not an invite verdict and must not be dressed as one. */
  it("passes a transport error through as a plain Error", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "JWT expired" } });
    await expect(claimInvite("tok")).rejects.not.toBeInstanceOf(InviteClaimError);
  });
});

describe("inviteState", () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  const past = new Date(Date.now() - 3600_000).toISOString();

  it("reads a bound account as claimed whatever the dates say", () => {
    expect(inviteState({ auth_user_id: "u", invite_expires_at: past, invite_revoked_at: past }))
      .toBe("claimed");
  });

  it("prefers revoked over expired", () => {
    expect(inviteState({ auth_user_id: null, invite_revoked_at: past, invite_expires_at: past }))
      .toBe("revoked");
  });

  it("treats a null expiry on an unclaimed row as active", () => {
    expect(inviteState({ auth_user_id: null, invite_expires_at: null })).toBe("active");
  });

  it("expires exactly at the boundary rather than after it", () => {
    expect(inviteState({ auth_user_id: null, invite_expires_at: new Date(Date.now() - 1).toISOString() }))
      .toBe("expired");
    expect(inviteState({ auth_user_id: null, invite_expires_at: future })).toBe("active");
  });
});
