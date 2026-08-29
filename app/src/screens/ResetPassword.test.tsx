import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Session } from "@supabase/supabase-js";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ResetPassword from "./ResetPassword";

/**
 * Review L16. The screen a password-reset email lands on.
 *
 * The interesting part is not the form, it is the two ways this screen can lie
 * to somebody who is locked out: telling them their link expired when it did
 * not (the session arrives asynchronously and the first `getSession()` resolves
 * to null), and accepting a password the server will refuse.
 */

const AUTH = vi.hoisted(() => ({
  session: null as Session | null,
  /** Set by `onAuthStateChange`, so a test can deliver a session late. */
  emit: null as ((session: Session | null) => void) | null,
  updateUser: vi.fn(async (_: { password: string }) => ({ error: null as { message: string } | null })),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: AUTH.session } }),
      onAuthStateChange: (cb: (e: string, s: Session | null) => void) => {
        AUTH.emit = (s) => cb("PASSWORD_RECOVERY", s);
        return { data: { subscription: { unsubscribe: () => { AUTH.emit = null; } } } };
      },
      updateUser: AUTH.updateUser,
    },
  },
}));

const SESSION = { access_token: "t", user: { id: "u1" } } as unknown as Session;

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={["/reset-password"]}>
      <ResetPassword />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  AUTH.session = null;
  AUTH.emit = null;
  AUTH.updateUser.mockClear();
  AUTH.updateUser.mockResolvedValue({ error: null });
});

describe("ResetPassword", () => {
  it("shows the form when the recovery link produced a session", async () => {
    AUTH.session = SESSION;
    renderScreen();
    expect(await screen.findByLabelText("New password")).toBeTruthy();
  });

  it("says the link cannot be used when there is no session", async () => {
    renderScreen();
    expect(await screen.findByText("This reset link can't be used")).toBeTruthy();
    // Not a dead end: the whole point of the screen is getting back in.
    expect(screen.getByRole("link", { name: "Back to sign in" })).toBeTruthy();
  });

  it("recovers when the session arrives after the first check", async () => {
    // The race that makes this screen worth testing. `getSession()` resolves
    // before supabase-js has finished parsing the URL fragment, so the first
    // answer is null for a link that is perfectly good. Without the
    // `onAuthStateChange` subscription the screen settles on "link expired"
    // and the person gives up holding a working link.
    renderScreen();
    expect(await screen.findByText("This reset link can't be used")).toBeTruthy();
    AUTH.emit?.(SESSION);
    expect(await screen.findByLabelText("New password")).toBeTruthy();
  });

  it("refuses a password the server would refuse, without a round trip", async () => {
    AUTH.session = SESSION;
    renderScreen();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("New password"), "short1A");
    await user.type(screen.getByLabelText("Confirm password"), "short1A");
    await user.click(screen.getByRole("button", { name: "Save password" }));
    expect(await screen.findByText("Use at least 12 characters.")).toBeTruthy();
    expect(AUTH.updateUser).not.toHaveBeenCalled();
  });

  it("refuses a mismatch before checking anything else", async () => {
    AUTH.session = SESSION;
    renderScreen();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("New password"), "Correct-Horse-9");
    await user.type(screen.getByLabelText("Confirm password"), "Correct-Horse-8");
    await user.click(screen.getByRole("button", { name: "Save password" }));
    expect(await screen.findByText("Those don't match.")).toBeTruthy();
    expect(AUTH.updateUser).not.toHaveBeenCalled();
  });

  it("saves a valid password and confirms", async () => {
    AUTH.session = SESSION;
    renderScreen();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("New password"), "Correct-Horse-9");
    await user.type(screen.getByLabelText("Confirm password"), "Correct-Horse-9");
    await user.click(screen.getByRole("button", { name: "Save password" }));
    await waitFor(() => expect(AUTH.updateUser).toHaveBeenCalledWith({ password: "Correct-Horse-9" }));
    expect(await screen.findByText("Password updated")).toBeTruthy();
  });

  it("surfaces the server's refusal rather than swallowing it", async () => {
    // `secure_password_change` is on (review H2), so GoTrue can refuse a
    // change it considers stale. Leaving somebody staring at a form that does
    // nothing is the failure this branch exists to avoid.
    AUTH.session = SESSION;
    AUTH.updateUser.mockResolvedValue({ error: { message: "New password should be different." } });
    renderScreen();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("New password"), "Correct-Horse-9");
    await user.type(screen.getByLabelText("Confirm password"), "Correct-Horse-9");
    await user.click(screen.getByRole("button", { name: "Save password" }));
    expect(await screen.findByText("New password should be different.")).toBeTruthy();
    expect(screen.queryByText("Password updated")).toBeNull();
  });
});
