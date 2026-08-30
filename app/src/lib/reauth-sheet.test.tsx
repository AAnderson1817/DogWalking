import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Review M2. A magic-link operator could hold a perfectly valid session and be
 * unable to open the vault at all: `SignIn` offers a magic link,
 * `signInWithOtp` creates the account, and no operator path anywhere sets a
 * password. Every vault attempt answered "password verification failed" —
 * which reads as a typo to somebody who has nothing to mistype — and five of
 * them returned 429, locking them out of the flagship feature on a client's
 * doorstep with no way to fix it inside the product.
 *
 * The sheet is where this had to be solved: there are four `reauth()` call
 * sites, and putting it here means the doomed request is never made at all.
 */

const hasPassword = vi.fn();
const updateUser = vi.fn();
const CALLS = vi.hoisted(() => ({ order: [] as string[] }));
const mfa = vi.hoisted(() => ({
  fetchMfaGate: vi.fn(async (): Promise<{ factorId: string } | null> => null),
  stepUpWithCode: vi.fn(async (_f: string, _c: string): Promise<string | null> => null),
}));

vi.mock("./api", () => ({ accountHasPassword: () => hasPassword() }));
vi.mock("./mfa", () => ({
  fetchMfaGate: () => mfa.fetchMfaGate(),
  stepUpWithCode: (f: string, c: string) => {
    CALLS.order.push("stepUp");
    return mfa.stepUpWithCode(f, c);
  },
}));
vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      updateUser: (args: unknown) => {
        CALLS.order.push("updateUser");
        return updateUser(args);
      },
      getSession: () => Promise.resolve({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  },
}));

const { AuthProvider, useAuth } = await import("./auth-context");

/** Opens the sheet the way the vault does, and reports what it resolves to. */
function Harness({ onResolve }: { onResolve: (p: string | null) => void }) {
  const { reauth } = useAuth();
  return <button type="button" onClick={() => void reauth().then(onResolve)}>open</button>;
}

async function openSheet(onResolve = vi.fn()) {
  const user = userEvent.setup();
  render(
    <AuthProvider>
      <Harness onResolve={onResolve} />
    </AuthProvider>,
  );
  await user.click(screen.getByRole("button", { name: "open" }));
  return { user, onResolve };
}

describe("ReauthSheet", () => {
  beforeEach(() => {
    hasPassword.mockReset();
    updateUser.mockReset();
    CALLS.order.length = 0;
    mfa.fetchMfaGate.mockReset();
    mfa.fetchMfaGate.mockResolvedValue(null);
    mfa.stepUpWithCode.mockReset();
    mfa.stepUpWithCode.mockResolvedValue(null);
  });

  it("asks for the existing password when there is one", async () => {
    hasPassword.mockResolvedValue(true);
    const { user, onResolve } = await openSheet();
    await screen.findByLabelText("Password");
    expect(screen.queryByLabelText("Confirm password")).toBeNull();
    // No verified factor ⇒ no code field: the step-up is never ceremony.
    expect(screen.queryByLabelText("Two-factor code")).toBeNull();
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("hunter2"));
    // Nothing was changed about the account — this is a confirmation.
    expect(updateUser).not.toHaveBeenCalled();
    expect(mfa.stepUpWithCode).not.toHaveBeenCalled();
  });

  it("offers to SET a password when the account has none", async () => {
    hasPassword.mockResolvedValue(false);
    await openSheet();
    // The whole finding: the operator is asked for the thing that will work,
    // instead of being told their non-existent password was wrong.
    await screen.findByRole("heading", { name: "Set a password" });
    expect(screen.getByLabelText("New password")).toBeInTheDocument();
    expect(screen.getByLabelText("Confirm password")).toBeInTheDocument();
  });

  it("sets the password and continues straight to the pending action", async () => {
    hasPassword.mockResolvedValue(false);
    updateUser.mockResolvedValue({ error: null });
    const { user, onResolve } = await openSheet();
    await screen.findByLabelText("New password");
    await user.type(screen.getByLabelText("New password"), "correct-horse-battery");
    await user.type(screen.getByLabelText("Confirm password"), "correct-horse-battery");
    await user.click(screen.getByRole("button", { name: "Set password and continue" }));
    await waitFor(() => expect(updateUser).toHaveBeenCalledWith({ password: "correct-horse-battery" }));
    // Setting the password IS the re-auth; asking for it again would be
    // ceremony, and would strand the operator one step from where they started.
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("correct-horse-battery"));
  });

  it("refuses a mismatch without touching the account", async () => {
    hasPassword.mockResolvedValue(false);
    const { user, onResolve } = await openSheet();
    await screen.findByLabelText("New password");
    await user.type(screen.getByLabelText("New password"), "one-password");
    await user.type(screen.getByLabelText("Confirm password"), "another-password");
    await user.click(screen.getByRole("button", { name: "Set password and continue" }));
    expect(await screen.findByText("Those don't match.")).toBeInTheDocument();
    expect(updateUser).not.toHaveBeenCalled();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("surfaces a rejected password change instead of doing nothing", async () => {
    hasPassword.mockResolvedValue(false);
    // `secure_password_change` can require a recent sign-in. An operator who
    // has been idle needs to be told that, not left staring at a form that
    // silently does nothing.
    updateUser.mockResolvedValue({ error: { message: "For security purposes, please sign in again." } });
    const { user, onResolve } = await openSheet();
    await screen.findByLabelText("New password");
    await user.type(screen.getByLabelText("New password"), "a-good-password");
    await user.type(screen.getByLabelText("Confirm password"), "a-good-password");
    await user.click(screen.getByRole("button", { name: "Set password and continue" }));
    expect(await screen.findByText(/please sign in again/i)).toBeInTheDocument();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("asks for the TOTP code when a verified factor exists, and upgrades BEFORE settling", async () => {
    // Review H2's client half: once a factor is enrolled, the vault refuses
    // any aal1 session — after the password was verified and a rate slot
    // spent. The sheet asks up front and challengeAndVerify upgrades the
    // session in place, so the doomed request is never made (the M2 shape).
    hasPassword.mockResolvedValue(true);
    mfa.fetchMfaGate.mockResolvedValue({ factorId: "f1" });
    const { user, onResolve } = await openSheet();
    await screen.findByLabelText("Two-factor code");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    // No code yet: the submit is disabled — a passwordless submit of the
    // step-up would burn a GoTrue verify attempt on an empty string.
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
    await user.type(screen.getByLabelText("Two-factor code"), "123456");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("hunter2"));
    expect(mfa.stepUpWithCode).toHaveBeenCalledWith("f1", "123456");
  });

  it("a refused code shows the refusal and settles NOTHING", async () => {
    hasPassword.mockResolvedValue(true);
    mfa.fetchMfaGate.mockResolvedValue({ factorId: "f1" });
    mfa.stepUpWithCode.mockResolvedValue("Invalid TOTP code entered");
    const { user, onResolve } = await openSheet();
    await screen.findByLabelText("Two-factor code");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.type(screen.getByLabelText("Two-factor code"), "000000");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText(/invalid totp code/i)).toBeInTheDocument();
    // Settling the password anyway would hand the vault call a session the
    // server is guaranteed to refuse — and spend a rate slot doing it.
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("the set-password flow steps up BEFORE the password write", async () => {
    // An account with a verified factor gets its password changed by an aal2
    // session, never by the bare session whose theft the factor exists to
    // contain — the exact chain resolveAssurance was built against.
    hasPassword.mockResolvedValue(false);
    mfa.fetchMfaGate.mockResolvedValue({ factorId: "f1" });
    updateUser.mockResolvedValue({ error: null });
    const { user, onResolve } = await openSheet();
    await screen.findByLabelText("New password");
    await user.type(screen.getByLabelText("New password"), "correct-horse-battery");
    await user.type(screen.getByLabelText("Confirm password"), "correct-horse-battery");
    await user.type(screen.getByLabelText("Two-factor code"), "123456");
    await user.click(screen.getByRole("button", { name: "Set password and continue" }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("correct-horse-battery"));
    expect(CALLS.order).toEqual(["stepUp", "updateUser"]);
  });

  it("holds the loading state until the MFA check answers — a form shown early is the doomed request back", async () => {
    // If the form renders before fetchMfaGate resolves, an operator with an
    // enrolled factor can submit password-only in the gap: the vault refuses
    // second_factor_required AFTER verifying the password and spending a
    // rate slot — the exact behavior this sheet exists to prevent.
    hasPassword.mockResolvedValue(true);
    let release!: (g: { factorId: string } | null) => void;
    mfa.fetchMfaGate.mockReturnValue(
      new Promise<{ factorId: string } | null>((resolve) => { release = resolve; }),
    );
    await openSheet();
    expect(await screen.findByText("Checking your account")).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).toBeNull();
    release({ factorId: "f1" });
    expect(await screen.findByLabelText("Two-factor code")).toBeInTheDocument();
  });

  it("a refused code does NOT clear the gate — the retry is challenged again", async () => {
    // The plausible wrong edit clears the gate on any step-up exit, after
    // which the retry settles password-only and hands the vault a session
    // the server is guaranteed to refuse.
    hasPassword.mockResolvedValue(true);
    mfa.fetchMfaGate.mockResolvedValue({ factorId: "f1" });
    mfa.stepUpWithCode.mockResolvedValueOnce("Invalid TOTP code entered");
    const { user, onResolve } = await openSheet();
    await screen.findByLabelText("Two-factor code");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.type(screen.getByLabelText("Two-factor code"), "000000");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByText(/invalid totp code/i);
    await user.clear(screen.getByLabelText("Two-factor code"));
    await user.type(screen.getByLabelText("Two-factor code"), "123456");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("hunter2"));
    expect(mfa.stepUpWithCode).toHaveBeenCalledTimes(2);
    expect(mfa.stepUpWithCode).toHaveBeenLastCalledWith("f1", "123456");
  });

  it("a PASSED step-up is not demanded twice: a later failure retries without a second code", async () => {
    // Set-password flow: the step-up succeeds, the password write fails
    // (secure_password_change wants a recent sign-in, say). The session is
    // aal2 now — demanding a fresh code to retry the WRITE would be
    // ceremony, and the disabled-until-code clause would otherwise wedge
    // the form with the consumed code.
    hasPassword.mockResolvedValue(false);
    mfa.fetchMfaGate.mockResolvedValue({ factorId: "f1" });
    updateUser
      .mockResolvedValueOnce({ error: { message: "please sign in again" } })
      .mockResolvedValueOnce({ error: null });
    const { user, onResolve } = await openSheet();
    await screen.findByLabelText("New password");
    await user.type(screen.getByLabelText("New password"), "correct-horse-battery");
    await user.type(screen.getByLabelText("Confirm password"), "correct-horse-battery");
    await user.type(screen.getByLabelText("Two-factor code"), "123456");
    await user.click(screen.getByRole("button", { name: "Set password and continue" }));
    await screen.findByText(/please sign in again/i);
    await user.click(screen.getByRole("button", { name: "Set password and continue" }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("correct-horse-battery"));
    expect(mfa.stepUpWithCode).toHaveBeenCalledTimes(1);
    expect(updateUser).toHaveBeenCalledTimes(2);
  });

  it("a factor deleted since the sheet opened clears the stale gate with an honest sentence", async () => {
    // Dashboard recovery or another tab removed the factor: GoTrue answers
    // 'Factor not found', which names no remedy, and re-challenging the
    // dead factor forever is a wall. The gate clears, the sentence says
    // what happened, and the next press proceeds password-only — which the
    // server now accepts, since the factor is gone.
    hasPassword.mockResolvedValue(true);
    mfa.fetchMfaGate.mockResolvedValue({ factorId: "f1" });
    mfa.stepUpWithCode.mockResolvedValueOnce("Factor not found");
    const { user, onResolve } = await openSheet();
    await screen.findByLabelText("Two-factor code");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.type(screen.getByLabelText("Two-factor code"), "123456");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText(/changed on another device/i)).toBeInTheDocument();
    expect(onResolve).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("hunter2"));
    expect(mfa.stepUpWithCode).toHaveBeenCalledTimes(1);
  });

  it("falls back to the password form when the check itself fails", async () => {
    // Failing OPEN is deliberate. The vault still refuses safely on the
    // server, and assuming "no password" on a lookup failure would push every
    // operator through a password reset they never asked for.
    hasPassword.mockRejectedValue(new Error("network"));
    await openSheet();
    expect(await screen.findByLabelText("Password")).toBeInTheDocument();
    expect(screen.queryByLabelText("Confirm password")).toBeNull();
  });
});
