import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Session } from "@supabase/supabase-js";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { RequireRole } from "./RequireRole";
import type { AuthState, Role } from "@/lib/auth-context";

/**
 * Review H18: the whole suite ran in `environment: "node"` and every
 * `.test.tsx` rendered through `renderToStaticMarkup`, so no route guard was
 * ever exercised as a guard — a `<Navigate>` returned by a component is just
 * markup until a router does something with it.
 *
 * This is the first test in the repository that actually navigates. It matters
 * here in particular because two of this guard's branches are historical
 * defects, both found by hand: users stranded at the onboarding form when role
 * resolution merely errored, and infinite spinners in place of a retry.
 */

const AUTH_MOCK = vi.hoisted(() => ({ value: null as AuthState | null }));
vi.mock("@/lib/auth-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-context")>()),
  useAuth: () => AUTH_MOCK.value as AuthState,
}));

const SESSION = { access_token: "t", user: { id: "u1" } } as unknown as Session;

function authState(over: Partial<AuthState>): AuthState {
  return {
    session: null,
    role: null,
    operatorId: null,
    clientId: null,
    loading: false,
    roleError: false,
    reauth: vi.fn(async () => null),
    refreshRole: vi.fn(async () => null as Role),
    signOut: vi.fn(async () => undefined),
    ...over,
  };
}

/** Renders the guard inside a real router and reports where it lands. */
function renderGuard(state: AuthState, role: "operator" | "client" = "operator") {
  AUTH_MOCK.value = state;
  return render(
    <MemoryRouter initialEntries={["/protected"]}>
      <Routes>
        <Route
          path="/protected"
          element={
            <RequireRole role={role}>
              <div>protected content</div>
            </RequireRole>
          }
        />
        <Route path="/signin" element={<div>sign in screen</div>} />
        <Route path="/onboard" element={<div>onboarding form</div>} />
        <Route path="/" element={<div>operator home</div>} />
        <Route path="/portal" element={<div>client portal</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RequireRole", () => {
  it("lets the right persona through", () => {
    renderGuard(authState({ session: SESSION, role: "operator" }));
    expect(screen.getByText("protected content")).toBeInTheDocument();
  });

  it("sends an unauthenticated visitor to sign-in", () => {
    renderGuard(authState({}));
    expect(screen.getByText("sign in screen")).toBeInTheDocument();
    expect(screen.queryByText("protected content")).not.toBeInTheDocument();
  });

  it("sends a signed-in user with no persona row to onboarding", () => {
    renderGuard(authState({ session: SESSION, role: null }));
    expect(screen.getByText("onboarding form")).toBeInTheDocument();
  });

  it("sends the wrong persona to their own home rather than to a dead end", () => {
    renderGuard(authState({ session: SESSION, role: "client" }), "operator");
    expect(screen.getByText("client portal")).toBeInTheDocument();

    renderGuard(authState({ session: SESSION, role: "operator" }), "client");
    expect(screen.getByText("operator home")).toBeInTheDocument();
  });

  /**
   * The defect this branch exists for. A query error is not "this user has no
   * persona": sending them to onboarding invites an operator to create a
   * SECOND tenant because their network blipped.
   */
  it("shows a retry on a resolution error instead of routing to onboarding", async () => {
    const refreshRole = vi.fn(async () => "operator" as Role);
    renderGuard(authState({ session: SESSION, role: null, roleError: true, refreshRole }));

    expect(screen.queryByText("onboarding form")).not.toBeInTheDocument();
    expect(screen.getByText("Couldn't load your account")).toBeInTheDocument();

    // And the retry is wired to something. `renderToStaticMarkup` can see the
    // button exists; only a DOM can press it.
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refreshRole).toHaveBeenCalledTimes(1);
  });

  /**
   * A resolved role wins over a stale error flag from a concurrent attempt —
   * otherwise a slow first request that fails after a fast second one
   * succeeded would show a retry to a user who is already resolved.
   */
  it("prefers a resolved role over a stale error flag", () => {
    renderGuard(authState({ session: SESSION, role: "operator", roleError: true }));
    expect(screen.getByText("protected content")).toBeInTheDocument();
  });

  it("shows a loading state, not a redirect, while resolution is in flight", () => {
    renderGuard(authState({ session: SESSION, loading: true }));
    // The bug in the other direction: redirecting on `loading` bounces every
    // signed-in user through /signin on a cold start.
    expect(screen.queryByText("sign in screen")).not.toBeInTheDocument();
    expect(screen.queryByText("onboarding form")).not.toBeInTheDocument();
    expect(screen.getByText(/loading your account/i)).toBeInTheDocument();
  });
});
