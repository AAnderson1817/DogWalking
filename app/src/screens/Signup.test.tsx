// /signup (review H31): the explicit operator front door, and deliberately
// the ONE public supabase.auth.signUp left in the tree — the call the GoTrue
// signup toggle now governs.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Signup from "./Signup";
import type { AuthState, Role } from "@/lib/auth-context";

const SUPA = vi.hoisted(() => ({
  signUp: vi.fn(async () => ({
    data: { session: null as { access_token: string } | null },
    error: null as { message: string } | null,
  })),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { signUp: SUPA.signUp } },
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
  return render(
    <MemoryRouter initialEntries={["/signup"]}>
      <Routes>
        <Route path="/signup" element={<Signup />} />
        <Route path="/onboard" element={<div>onboarding form</div>} />
        <Route path="/pricing" element={<div>pricing page</div>} />
        <Route path="/signin" element={<div>sign in screen</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  SUPA.signUp.mockClear();
  SUPA.signUp.mockResolvedValue({ data: { session: null }, error: null } as never);
});

describe("Signup", () => {
  it("states the terms up front and links the pricing page", () => {
    renderScreen();
    expect(screen.getByText(/14 days free/)).toBeInTheDocument();
    expect(screen.getByText(/\$49\.00\/month/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /what's included/i }))
      .toHaveAttribute("href", "/pricing");
  });

  it("signs up and hands an instant session to onboarding", async () => {
    SUPA.signUp.mockResolvedValueOnce({
      data: { session: { access_token: "t" } },
      error: null,
    } as never);
    renderScreen();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "walker@sanpo.test");
    await user.type(screen.getByLabelText("Choose a password"), "correct-horse-battery");
    await user.click(screen.getByRole("button", { name: "Create my account" }));
    await waitFor(() => expect(SUPA.signUp).toHaveBeenCalledWith({
      email: "walker@sanpo.test",
      password: "correct-horse-battery",
    }));
    expect(await screen.findByText("onboarding form")).toBeInTheDocument();
  });

  it("with confirmations on, says check your email instead of pretending", async () => {
    renderScreen();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "walker@sanpo.test");
    await user.type(screen.getByLabelText("Choose a password"), "correct-horse-battery");
    await user.click(screen.getByRole("button", { name: "Create my account" }));
    expect(await screen.findByText(/confirm your email/i)).toBeInTheDocument();
  });

  it("surfaces a refusal — the signup toggle turning this screen off must be visible", async () => {
    SUPA.signUp.mockResolvedValueOnce({
      data: { session: null },
      error: { message: "Signups not allowed for this instance" },
    } as never);
    renderScreen();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "walker@sanpo.test");
    await user.type(screen.getByLabelText("Choose a password"), "correct-horse-battery");
    await user.click(screen.getByRole("button", { name: "Create my account" }));
    expect(await screen.findByText(/signups not allowed/i)).toBeInTheDocument();
  });
});
