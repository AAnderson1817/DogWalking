// The enrolment surface (review H2's client half). The rules worth pinning:
// verify-before-on (an unverified factor protects nothing and must not read
// as "on"), removal demands a current code (a session-only attacker must not
// be able to delete the control that contains stolen sessions), and a failed
// status read is "unavailable + retry", never "off" (rendering setup on a
// failed read invites an enrolment that fails worse one step later).
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MfaSection } from "./MfaSection";
import type { MfaFactorLike, TotpEnrolment } from "@/lib/mfa";

const CALLS = vi.hoisted(() => ({ order: [] as string[] }));
const mfa = vi.hoisted(() => ({
  fetchVerifiedFactor: vi.fn(async (): Promise<MfaFactorLike | null> => null),
  beginTotpEnrolment: vi.fn(async (): Promise<TotpEnrolment> => ({
    factorId: "f-new",
    qrCode: "data:image/svg+xml;utf-8,%3Csvg%3E%3C/svg%3E",
    secret: "S3CRETKEY",
  })),
  confirmTotpEnrolment: vi.fn(async (_f: string, _c: string): Promise<string | null> => null),
  stepUpWithCode: vi.fn(async (_f: string, _c: string): Promise<string | null> => null),
  removeTotpFactor: vi.fn(async (_f: string): Promise<string | null> => null),
}));

vi.mock("@/lib/mfa", () => ({
  fetchVerifiedFactor: () => mfa.fetchVerifiedFactor(),
  beginTotpEnrolment: () => mfa.beginTotpEnrolment(),
  confirmTotpEnrolment: (f: string, c: string) => mfa.confirmTotpEnrolment(f, c),
  stepUpWithCode: (f: string, c: string) => {
    CALLS.order.push("stepUp");
    return mfa.stepUpWithCode(f, c);
  },
  removeTotpFactor: (f: string) => {
    CALLS.order.push("unenroll");
    return mfa.removeTotpFactor(f);
  },
}));

beforeEach(() => {
  CALLS.order.length = 0;
  mfa.fetchVerifiedFactor.mockReset();
  mfa.fetchVerifiedFactor.mockResolvedValue(null);
  mfa.beginTotpEnrolment.mockClear();
  mfa.confirmTotpEnrolment.mockReset();
  mfa.confirmTotpEnrolment.mockResolvedValue(null);
  mfa.stepUpWithCode.mockReset();
  mfa.stepUpWithCode.mockResolvedValue(null);
  mfa.removeTotpFactor.mockReset();
  mfa.removeTotpFactor.mockResolvedValue(null);
});

describe("MfaSection", () => {
  it("no factor: offers setup; enrolment shows the QR AND the manual key", async () => {
    render(<MfaSection />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Turn on two-factor" }));
    expect(await screen.findByAltText(/QR code/i)).toBeInTheDocument();
    // The manual key is not decoration: a desktop browser cannot scan itself.
    expect(screen.getByText("S3CRETKEY")).toBeInTheDocument();
  });

  it("verifying the code is what turns it ON — a scanned-but-unverified factor is not 'on'", async () => {
    render(<MfaSection />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Turn on two-factor" }));
    await screen.findByLabelText("Six-digit code");
    // Before the code: nothing claims the account is protected.
    expect(screen.queryByText(/is on/i)).toBeNull();
    await user.type(screen.getByLabelText("Six-digit code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify and turn on" }));
    await waitFor(() =>
      expect(mfa.confirmTotpEnrolment).toHaveBeenCalledWith("f-new", "123456")
    );
    expect(await screen.findByText(/two-factor authentication is on/i)).toBeInTheDocument();
  });

  it("a refused enrolment code stays on the form with the refusal — never a false 'on'", async () => {
    mfa.confirmTotpEnrolment.mockResolvedValue("Invalid TOTP code entered");
    render(<MfaSection />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Turn on two-factor" }));
    await user.type(await screen.findByLabelText("Six-digit code"), "000000");
    await user.click(screen.getByRole("button", { name: "Verify and turn on" }));
    expect(await screen.findByText(/invalid totp code/i)).toBeInTheDocument();
    expect(screen.queryByText(/two-factor authentication is on/i)).toBeNull();
  });

  it("a verified factor renders ON, and removal demands a current code before unenrolling", async () => {
    mfa.fetchVerifiedFactor.mockResolvedValue({
      id: "f1",
      factor_type: "totp",
      status: "verified",
    });
    render(<MfaSection />);
    const user = userEvent.setup();
    // The on-state's unambiguous marker: the off switch exists, setup doesn't.
    await screen.findByRole("button", { name: "Turn off two-factor" });
    expect(screen.queryByRole("button", { name: "Turn on two-factor" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Turn off two-factor" }));
    // No unenroll yet — the code comes first.
    expect(CALLS.order).toEqual([]);
    await user.type(await screen.findByLabelText("Six-digit code"), "123456");
    await user.click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(screen.getByText(/two-factor authentication is off/i)).toBeInTheDocument());
    // The step-up precedes the unenroll: turning it off requires having it.
    expect(CALLS.order).toEqual(["stepUp", "unenroll"]);
    expect(mfa.stepUpWithCode).toHaveBeenCalledWith("f1", "123456");
  });

  it("a refused removal code removes NOTHING", async () => {
    mfa.fetchVerifiedFactor.mockResolvedValue({
      id: "f1",
      factor_type: "totp",
      status: "verified",
    });
    mfa.stepUpWithCode.mockResolvedValue("Invalid TOTP code entered");
    render(<MfaSection />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Turn off two-factor" }));
    await user.type(await screen.findByLabelText("Six-digit code"), "000000");
    await user.click(screen.getByRole("button", { name: "Turn off" }));
    expect(await screen.findByText(/invalid totp code/i)).toBeInTheDocument();
    expect(mfa.removeTotpFactor).not.toHaveBeenCalled();
  });

  it("a failed status read is 'unavailable' with a retry — never 'off'", async () => {
    // "Off" here would render the setup button on an account whose factor we
    // simply could not see — and a second enrolment attempt against a live
    // factor fails worse, one step deeper.
    mfa.fetchVerifiedFactor.mockRejectedValueOnce(new Error("network down"));
    render(<MfaSection />);
    const user = userEvent.setup();
    expect(await screen.findByText(/network down/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn on two-factor" })).toBeNull();
    mfa.fetchVerifiedFactor.mockResolvedValue(null);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Turn on two-factor" })).toBeInTheDocument();
  });
});
