// The step-up decision rules (review H2's client half). The rules worth
// pinning are the ones whose plausible-wrong versions are dangerous:
// challenging an UNVERIFIED factor demands a code that may exist in no app;
// failing CLOSED on a transport error walls every operator out of the vault
// on a flaky connection; and skipping the aal2 short-circuit asks a session
// that already presented its factor to present it again, forever.
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  getAuthenticatorAssuranceLevel: vi.fn(),
  listFactors: vi.fn(),
  challengeAndVerify: vi.fn(),
  enroll: vi.fn(),
  unenroll: vi.fn(),
}));

vi.mock("./supabase", () => ({ supabase: { auth: { mfa: auth } } }));

const {
  beginTotpEnrolment,
  fetchMfaGate,
  resolveMfaGate,
  stepUpWithCode,
  verifiedTotpFactor,
} = await import("./mfa");

const VERIFIED = { id: "f1", factor_type: "totp", status: "verified" };
const UNVERIFIED = { id: "f2", factor_type: "totp", status: "unverified" };

describe("resolveMfaGate", () => {
  it("demands a step-up exactly when a verified factor exists and the session has not presented it", () => {
    expect(resolveMfaGate({ currentLevel: "aal1", nextLevel: "aal2" }, [VERIFIED]))
      .toEqual({ factorId: "f1" });
  });

  it("a session already at aal2 is never asked twice — the server's own short-circuit, mirrored", () => {
    expect(resolveMfaGate({ currentLevel: "aal2", nextLevel: "aal2" }, [VERIFIED])).toBeNull();
  });

  it("no verified factor means no step-up: an abandoned enrolment must not lock anyone out", () => {
    expect(resolveMfaGate({ currentLevel: "aal1", nextLevel: "aal1" }, [UNVERIFIED])).toBeNull();
    // Even if the levels claim aal2 is reachable, an unverified factor is not
    // challengeable — its secret may be in no app anywhere.
    expect(resolveMfaGate({ currentLevel: "aal1", nextLevel: "aal2" }, [UNVERIFIED])).toBeNull();
  });

  it("unknown state is 'no step-up' — the fail-open direction the server backstops", () => {
    expect(resolveMfaGate(null, [VERIFIED])).toBeNull();
    expect(resolveMfaGate({ currentLevel: null, nextLevel: null }, [VERIFIED])).toBeNull();
    expect(resolveMfaGate({ currentLevel: "aal1", nextLevel: "aal2" }, null)).toBeNull();
  });
});

describe("verifiedTotpFactor", () => {
  it("picks only totp + verified", () => {
    expect(verifiedTotpFactor([UNVERIFIED, VERIFIED])?.id).toBe("f1");
    expect(verifiedTotpFactor([UNVERIFIED])).toBeNull();
    expect(verifiedTotpFactor([{ id: "p1", factor_type: "phone", status: "verified" }])).toBeNull();
    expect(verifiedTotpFactor(null)).toBeNull();
  });
});

describe("fetchMfaGate", () => {
  beforeEach(() => {
    auth.getAuthenticatorAssuranceLevel.mockReset();
    auth.listFactors.mockReset();
  });

  it("returns the gate from live session state", async () => {
    auth.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: "aal1", nextLevel: "aal2" },
      error: null,
    });
    auth.listFactors.mockResolvedValue({ data: { all: [VERIFIED] }, error: null });
    expect(await fetchMfaGate()).toEqual({ factorId: "f1" });
  });

  it("fails OPEN on a thrown transport error — the vault still refuses an insufficient session server-side", async () => {
    auth.getAuthenticatorAssuranceLevel.mockRejectedValue(new Error("network"));
    auth.listFactors.mockResolvedValue({ data: { all: [VERIFIED] }, error: null });
    expect(await fetchMfaGate()).toBeNull();
  });

  it("fails OPEN on an error envelope too", async () => {
    auth.getAuthenticatorAssuranceLevel.mockResolvedValue({ data: null, error: { message: "x" } });
    auth.listFactors.mockResolvedValue({ data: { all: [VERIFIED] }, error: null });
    expect(await fetchMfaGate()).toBeNull();
  });
});

describe("stepUpWithCode", () => {
  it("returns null on success and the message on refusal — never throws for a wrong code", async () => {
    auth.challengeAndVerify.mockResolvedValueOnce({ error: null });
    expect(await stepUpWithCode("f1", "123456")).toBeNull();
    expect(auth.challengeAndVerify).toHaveBeenCalledWith({ factorId: "f1", code: "123456" });
    auth.challengeAndVerify.mockResolvedValueOnce({ error: { message: "Invalid TOTP code" } });
    expect(await stepUpWithCode("f1", "000000")).toMatch(/invalid/i);
  });
});

describe("beginTotpEnrolment", () => {
  beforeEach(() => {
    auth.listFactors.mockReset();
    auth.enroll.mockReset();
    auth.unenroll.mockReset();
  });

  it("removes abandoned UNVERIFIED factors first, never a verified one", async () => {
    // GoTrue cannot re-show an unverified factor's secret, so an abandoned
    // enrolment is unfinishable — cleanup is the only honest continuation.
    // Deleting a VERIFIED factor here would silently turn two-factor OFF as
    // a side effect of opening the setup sheet.
    auth.listFactors.mockResolvedValue({ data: { all: [VERIFIED, UNVERIFIED] }, error: null });
    auth.unenroll.mockResolvedValue({ error: null });
    auth.enroll.mockResolvedValue({
      data: { id: "f3", totp: { qr_code: "data:image/svg+xml;utf-8,<svg/>", secret: "S3CRET" } },
      error: null,
    });
    const enrolment = await beginTotpEnrolment();
    expect(auth.unenroll).toHaveBeenCalledTimes(1);
    expect(auth.unenroll).toHaveBeenCalledWith({ factorId: "f2" });
    expect(enrolment).toEqual({
      factorId: "f3",
      qrCode: "data:image/svg+xml;utf-8,<svg/>",
      secret: "S3CRET",
    });
  });

  it("surfaces an enroll refusal as an error", async () => {
    auth.listFactors.mockResolvedValue({ data: { all: [] }, error: null });
    auth.enroll.mockResolvedValue({ data: null, error: { message: "MFA is not enabled" } });
    await expect(beginTotpEnrolment()).rejects.toThrow(/not enabled/i);
  });
});
