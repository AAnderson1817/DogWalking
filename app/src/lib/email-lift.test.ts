import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 0054's two wrappers. The server's answers are text, so the wrappers are
 * where an unexpected string would turn into a wrong screen: read as "email is
 * on" it hides the notice, and read as "ready" it offers a button the server
 * refuses. An unknown answer must throw instead.
 */

const rpc = vi.fn();

vi.mock("./supabase", () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a) },
}));

const { getMyEmailStatus, liftMyEmailSuppression, EMAIL_LIFT_STATES } = await import("./api");

beforeEach(() => {
  rpc.mockReset();
});

describe("getMyEmailStatus", () => {
  it("asks the caller-scoped function with no arguments", async () => {
    rpc.mockResolvedValue({ data: [{ o_email: "a@x.test", o_state: "ready" }], error: null });
    await expect(getMyEmailStatus()).resolves.toEqual({ email: "a@x.test", state: "ready" });
    // No argument means it cannot be pointed at somebody else's address.
    expect(rpc).toHaveBeenCalledWith("fn_my_email_status");
  });

  it("answers null when the account is not a claimed client", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await expect(getMyEmailStatus()).resolves.toBeNull();
  });

  it("accepts every state the server's decision can produce", async () => {
    for (const state of EMAIL_LIFT_STATES) {
      rpc.mockResolvedValue({ data: [{ o_email: "a@x.test", o_state: state }], error: null });
      await expect(getMyEmailStatus()).resolves.toEqual({ email: "a@x.test", state });
    }
  });

  it("throws on a state it does not know, rather than guessing", async () => {
    rpc.mockResolvedValue({ data: [{ o_email: "a@x.test", o_state: "paused" }], error: null });
    await expect(getMyEmailStatus()).rejects.toThrow("Unrecognised email status: paused");
  });

  it("throws the database's message when the call fails", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "permission denied" } });
    await expect(getMyEmailStatus()).rejects.toThrow("permission denied");
  });
});

describe("liftMyEmailSuppression", () => {
  it("passes through lifted, not_client and every refusal", async () => {
    for (const answer of ["lifted", "not_client", ...EMAIL_LIFT_STATES]) {
      rpc.mockResolvedValue({ data: answer, error: null });
      await expect(liftMyEmailSuppression()).resolves.toBe(answer);
    }
    expect(rpc).toHaveBeenCalledWith("fn_lift_my_email_suppression");
  });

  it("throws on an answer it does not know", async () => {
    rpc.mockResolvedValue({ data: "maybe", error: null });
    await expect(liftMyEmailSuppression()).rejects.toThrow("Unrecognised email status: maybe");
  });

  it("throws the database's message when the call fails", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "JWT expired" } });
    await expect(liftMyEmailSuppression()).rejects.toThrow("JWT expired");
  });
});
