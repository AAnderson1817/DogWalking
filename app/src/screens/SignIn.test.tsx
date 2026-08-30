import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SignIn from "./SignIn";
import type { AuthState, Role } from "@/lib/auth-context";

/**
 * Review L16. The screen had no test at all, which is how it acquired a third
 * mode without anything checking that the third mode is reachable.
 *
 * The recovery path is a lockout path: for an operator, this account holds
 * every client's entry codes. What matters here is the affordance — that
 * somebody looking for the word "forgot" finds it — and that the confirmation
 * says the same thing whether or not the address has an account.
 */

const AUTH = vi.hoisted(() => ({
  reset: vi.fn(async (_e: string, _o: unknown) => ({ error: null as { status?: number; message?: string } | null })),
  otp: vi.fn(async () => ({ error: null })),
  password: vi.fn(async () => ({ error: null as { message: string } | null })),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      resetPasswordForEmail: AUTH.reset,
      signInWithOtp: AUTH.otp,
      signInWithPassword: AUTH.password,
    },
  },
}));

const authState: AuthState = {
  session: null,
  role: null,
  operatorId: null,
  clientId: null,
  operatorBilling: null,
  loading: false,
  roleError: false,
  reauth: vi.fn(async () => null),
  refreshRole: vi.fn(async () => null as Role),
  signOut: vi.fn(async () => undefined),
};
vi.mock("@/lib/auth-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-context")>()),
  useAuth: () => authState,
}));

function renderScreen() {
  return render(<MemoryRouter initialEntries={["/signin"]}><SignIn /></MemoryRouter>);
}

beforeEach(() => {
  AUTH.reset.mockClear();
  AUTH.reset.mockResolvedValue({ error: null });
  AUTH.otp.mockClear();
  AUTH.password.mockClear();
  AUTH.password.mockResolvedValue({ error: null });
});

describe("SignIn", () => {
  it("offers recovery by the word people look for", async () => {
    // The finding: a grep for "Forgot" returned nothing, and the magic link is
    // labelled as another way to sign IN. If this assertion is ever deleted,
    // the affordance can quietly go with it.
    renderScreen();
    expect(screen.getByRole("button", { name: "Forgot your password?" })).toBeTruthy();
  });

  it("switches into reset mode and sends a link, not a sign-in", async () => {
    renderScreen();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "sam@sanpo.test");
    await user.click(screen.getByRole("button", { name: "Forgot your password?" }));

    // The password field goes away — there is nothing to sign in with.
    expect(screen.queryByLabelText("Password")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Email me a reset link" }));

    await waitFor(() => expect(AUTH.reset).toHaveBeenCalledTimes(1));
    expect(AUTH.reset).toHaveBeenCalledWith(
      "sam@sanpo.test",
      expect.objectContaining({ redirectTo: expect.stringContaining("/reset-password") }),
    );
    // Neither sign-in path fires.
    expect(AUTH.password).not.toHaveBeenCalled();
    expect(AUTH.otp).not.toHaveBeenCalled();
  });

  it("says the same thing whether or not the address has an account", async () => {
    // The oracle. GoTrue may answer a 400 for an unknown address; repeating
    // that on screen turns this form into a way of asking "is this person a
    // Sanpo customer?".
    const messages: string[] = [];
    for (const err of [null, { status: 400, message: "User not found" }]) {
      AUTH.reset.mockResolvedValue({ error: err });
      const view = renderScreen();
      const user = userEvent.setup();
      await user.type(screen.getByLabelText("Email"), "sam@sanpo.test");
      await user.click(screen.getByRole("button", { name: "Forgot your password?" }));
      await user.click(screen.getByRole("button", { name: "Email me a reset link" }));
      messages.push((await screen.findByText(/is on its way/)).textContent ?? "");
      view.unmount();
    }
    expect(messages[0]).toBe(messages[1]);
    expect(messages[1]).not.toContain("not found");
  });

  it("surfaces a rate limit instead of promising an email", async () => {
    AUTH.reset.mockResolvedValue({
      error: { status: 429, message: "For security purposes, you can only request this after 51 seconds." },
    });
    renderScreen();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "sam@sanpo.test");
    await user.click(screen.getByRole("button", { name: "Forgot your password?" }));
    await user.click(screen.getByRole("button", { name: "Email me a reset link" }));
    expect(await screen.findByText(/51 seconds/)).toBeTruthy();
    // Still on the form, so they can try again once the window passes.
    expect(screen.getByRole("button", { name: "Email me a reset link" })).toBeTruthy();
  });

  it("gets back to sign-in from the confirmation", async () => {
    // A confirmation with no way out is a dead end on the one screen somebody
    // is already stuck on.
    renderScreen();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "sam@sanpo.test");
    await user.click(screen.getByRole("button", { name: "Forgot your password?" }));
    await user.click(screen.getByRole("button", { name: "Email me a reset link" }));
    await user.click(await screen.findByRole("button", { name: "Back to sign in" }));
    expect(screen.getByLabelText("Password")).toBeTruthy();
  });

  it("still signs in with a password, and with a magic link", async () => {
    // The two paths that already worked. Adding a third mode to a chain of
    // ternaries is exactly how one of the other two stops rendering.
    renderScreen();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "sam@sanpo.test");
    await user.type(screen.getByLabelText("Password"), "Correct-Horse-9");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(AUTH.password).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "Use a magic link instead" }));
    await user.click(screen.getByRole("button", { name: "Email me a link" }));
    await waitFor(() => expect(AUTH.otp).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Check your email")).toBeTruthy();
  });

  // ── Review H31: the magic link signs in, it does not sign up ─────────────

  it("the magic link never creates an account", async () => {
    // shouldCreateUser defaults TRUE, and before H31 this line passed no
    // options at all — so the magic link silently minted an account for any
    // typed address, which was the only operator account-creation path and
    // the reason the GoTrue signup toggle could never be turned off.
    renderScreen();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Use a magic link instead" }));
    await user.type(screen.getByLabelText("Email"), "sam@sanpo.test");
    await user.click(screen.getByRole("button", { name: "Email me a link" }));
    await waitFor(() => expect(AUTH.otp).toHaveBeenCalledTimes(1));
    expect(AUTH.otp).toHaveBeenCalledWith({
      email: "sam@sanpo.test",
      options: { shouldCreateUser: false },
    });
  });

  it("an unknown address gets the same confirmation, not GoTrue's signup refusal", async () => {
    // With shouldCreateUser off, GoTrue answers an unknown address with
    // "Signups not allowed for otp" — surfacing that verbatim would make the
    // magic link an account-existence oracle, the disclosure the reset mode
    // already refuses to make.
    AUTH.otp.mockResolvedValueOnce({
      error: { code: "otp_disabled", message: "Signups not allowed for otp" },
    } as never);
    renderScreen();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Use a magic link instead" }));
    await user.type(screen.getByLabelText("Email"), "stranger@example.com");
    await user.click(screen.getByRole("button", { name: "Email me a link" }));
    expect(await screen.findByText("Check your email")).toBeTruthy();
    expect(screen.queryByText(/signups not allowed/i)).not.toBeInTheDocument();
  });

  it("offers the operator front door", () => {
    // The /signup link is also what makes the route reachable for
    // route-reachability.test.ts — a person, not just the router, can get
    // there.
    renderScreen();
    expect(screen.getByRole("link", { name: /start your free trial/i }))
      .toHaveAttribute("href", "/signup");
  });
});
