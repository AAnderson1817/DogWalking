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

  it("a STALE session (enrolment happened elsewhere) still gets the prompt — the factor list is the authority", () => {
    // getAuthenticatorAssuranceLevel computes nextLevel from the CACHED
    // session's user.factors with no network call, so a session minted
    // before enrolment on another device reports nextLevel aal1 for up to a
    // token lifetime — while listFactors is a fresh GET /user. Gating on
    // nextLevel therefore made the doomed request exactly when the factor
    // was newest (adversarial review). The fresh list decides; nextLevel
    // decides nothing.
    expect(resolveMfaGate({ currentLevel: "aal1", nextLevel: "aal1" }, [VERIFIED]))
      .toEqual({ factorId: "f1" });
  });

  it("no verified factor means no step-up: an abandoned enrolment must not lock anyone out", () => {
    expect(resolveMfaGate({ currentLevel: "aal1", nextLevel: "aal1" }, [UNVERIFIED])).toBeNull();
    // Even if the levels claim aal2 is reachable, an unverified factor is not
    // challengeable — its secret may be in no app anywhere.
    expect(resolveMfaGate({ currentLevel: "aal1", nextLevel: "aal2" }, [UNVERIFIED])).toBeNull();
  });

  it("unknown LEVELS with a known verified factor still prompts — only proof of aal2 suppresses", () => {
    // The server reads a missing aal claim as aal1, never as strong; the
    // client mirror is the same: not-known-to-be-aal2 plus a verified
    // factor means the password-only request is doomed, and asking for a
    // code the operator provably holds costs at worst one extra field.
    expect(resolveMfaGate(null, [VERIFIED])).toEqual({ factorId: "f1" });
    expect(resolveMfaGate({ currentLevel: null, nextLevel: null }, [VERIFIED]))
      .toEqual({ factorId: "f1" });
  });

  it("an unknown FACTOR LIST is 'no step-up' — the one fail-open, backstopped by the server", () => {
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

  it("a failed LEVELS read with a fresh verified factor still gates — factors are the load-bearing input", async () => {
    auth.getAuthenticatorAssuranceLevel.mockResolvedValue({ data: null, error: { message: "x" } });
    auth.listFactors.mockResolvedValue({ data: { all: [VERIFIED] }, error: null });
    expect(await fetchMfaGate()).toEqual({ factorId: "f1" });
  });

  it("a failed FACTOR read is the fail-open", async () => {
    auth.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: "aal1", nextLevel: "aal2" },
      error: null,
    });
    auth.listFactors.mockResolvedValue({ data: null, error: { message: "x" } });
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

  it("a THROWN failure comes back as a message too — auth-js rethrows non-AuthErrors, and a throw here strands the form busy", async () => {
    auth.challengeAndVerify.mockRejectedValueOnce(new Error("fetch failed"));
    expect(await stepUpWithCode("f1", "123456")).toMatch(/fetch failed/);
  });
});

describe("beginTotpEnrolment", () => {
  beforeEach(() => {
    auth.listFactors.mockReset();
    auth.enroll.mockReset();
    auth.unenroll.mockReset();
  });

  it("removes abandoned UNVERIFIED totp factors first — never a verified one, never another type", async () => {
    // GoTrue cannot re-show an unverified factor's secret, so an abandoned
    // enrolment is unfinishable — cleanup is the only honest continuation.
    // Deleting a VERIFIED factor here would silently turn two-factor OFF as
    // a side effect of opening the setup sheet; a non-totp factor mid-
    // enrolment elsewhere is not this surface's to sweep.
    auth.listFactors.mockResolvedValue({
      data: {
        all: [VERIFIED, UNVERIFIED, { id: "p9", factor_type: "phone", status: "unverified" }],
      },
      error: null,
    });
    auth.unenroll.mockResolvedValue({ error: null });
    auth.enroll.mockResolvedValue({
      data: {
        id: "f3",
        totp: {
          qr_code: "data:image/svg+xml;utf-8,<svg/>",
          secret: "S3CRET",
          uri: "otpauth://totp/sanpo?secret=S3CRET",
        },
      },
      error: null,
    });
    const enrolment = await beginTotpEnrolment();
    expect(auth.unenroll).toHaveBeenCalledTimes(1);
    expect(auth.unenroll).toHaveBeenCalledWith({ factorId: "f2" });
    expect(enrolment).toEqual({
      factorId: "f3",
      qrCode: "data:image/svg+xml;utf-8,<svg/>",
      secret: "S3CRET",
      uri: "otpauth://totp/sanpo?secret=S3CRET",
    });
  });

  it("surfaces an enroll refusal as an error", async () => {
    auth.listFactors.mockResolvedValue({ data: { all: [] }, error: null });
    auth.enroll.mockResolvedValue({ data: null, error: { message: "MFA is not enabled" } });
    await expect(beginTotpEnrolment()).rejects.toThrow(/not enabled/i);
  });

  it("a failed sweep is named at the step that failed — auth-js returns envelopes, never throws", async () => {
    // Unchecked, the sweep silently skips, enroll refuses (name conflict /
    // factor cap), and the surfaced error misattributes the cause — on
    // every retry, identically.
    auth.listFactors.mockResolvedValue({ data: { all: [UNVERIFIED] }, error: null });
    auth.unenroll.mockResolvedValue({ error: { message: "factor locked" } });
    await expect(beginTotpEnrolment()).rejects.toThrow(/unfinished two-factor setup.*factor locked/i);
    expect(auth.enroll).not.toHaveBeenCalled();
  });

  it("a failed factor listing refuses up front instead of sweeping blind", async () => {
    auth.listFactors.mockResolvedValue({ data: null, error: { message: "network" } });
    await expect(beginTotpEnrolment()).rejects.toThrow(/existing two-factor setup/i);
    expect(auth.enroll).not.toHaveBeenCalled();
  });
});

describe("removeTotpFactor", () => {
  it("a THROWN unenroll comes back as a message — the sibling of the stepUpWithCode rule (Codex, PR #78)", async () => {
    // auth-js rethrows non-AuthErrors (a dropped connection, say); unwrapped,
    // the rejection escapes into MfaSection.remove(), which never reaches
    // setBusy(false) — the removal form stuck on its spinner until reload.
    const { removeTotpFactor } = await import("./mfa");
    auth.unenroll.mockReset();
    auth.unenroll.mockRejectedValueOnce(new Error("fetch failed"));
    expect(await removeTotpFactor("f1")).toMatch(/fetch failed/);
    auth.unenroll.mockResolvedValueOnce({ error: { message: "denied" } });
    expect(await removeTotpFactor("f1")).toMatch(/denied/);
    auth.unenroll.mockResolvedValueOnce({ error: null });
    expect(await removeTotpFactor("f1")).toBeNull();
  });
});

describe("fetchVerifiedFactor", () => {
  beforeEach(() => {
    auth.listFactors.mockReset();
  });

  it("returns the verified factor, and THROWS on a failed read — 'unavailable' and 'off' must stay distinct", async () => {
    // The fail-open convention of the sibling wrappers is deliberately NOT
    // used here: rendering the setup button on a failed read invites an
    // enrolment attempt that fails worse one step later, against an account
    // whose live factor we simply could not see.
    auth.listFactors.mockResolvedValueOnce({ data: { all: [UNVERIFIED, VERIFIED] }, error: null });
    const { fetchVerifiedFactor } = await import("./mfa");
    expect((await fetchVerifiedFactor())?.id).toBe("f1");
    auth.listFactors.mockResolvedValueOnce({ data: null, error: { message: "network down" } });
    await expect(fetchVerifiedFactor()).rejects.toThrow(/network down/);
  });
});
