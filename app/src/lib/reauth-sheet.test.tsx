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

vi.mock("./api", () => ({ accountHasPassword: () => hasPassword() }));
vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      updateUser: (args: unknown) => updateUser(args),
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
  });

  it("asks for the existing password when there is one", async () => {
    hasPassword.mockResolvedValue(true);
    const { user, onResolve } = await openSheet();
    await screen.findByLabelText("Password");
    expect(screen.queryByLabelText("Confirm password")).toBeNull();
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onResolve).toHaveBeenCalledWith("hunter2");
    // Nothing was changed about the account — this is a confirmation.
    expect(updateUser).not.toHaveBeenCalled();
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
