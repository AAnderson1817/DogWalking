// ClaimInvite's account-creation rewire (review H31). The screen had no test
// while it was a thin wrapper over public signUp; now that the invite
// decides whether an account may exist, the rules worth pinning are the
// ordering (claim-signup, never supabase.auth.signUp), the differentiated
// dead-ends surviving the move off the RPC path, and the resend flow for
// admin-created accounts on confirmations-on deployments.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ClaimInvite from "./ClaimInvite";
import { EdgeError, INVITE_CLAIM_MESSAGE, InviteClaimError } from "@/lib/api";
import type { AuthState, Role } from "@/lib/auth-context";

const TOKEN = "99999999-0000-4000-e000-000000000001";

const CALLS = vi.hoisted(() => ({ order: [] as string[] }));

const API = vi.hoisted(() => ({
  claimSignup: vi.fn(async (_t: string, _e: string, _p: string) => undefined),
  previewInviteAuthed: vi.fn(async () => ({
    full_name: "Amelia",
    business_name: "Old Town Dog Care",
    already_claimed: false,
  })),
  claimInvite: vi.fn(async () => "client-1"),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  claimSignup: (...args: [string, string, string]) => {
    CALLS.order.push("claimSignup");
    return API.claimSignup(...args);
  },
  previewInviteAuthed: API.previewInviteAuthed,
  claimInvite: API.claimInvite,
}));

const SUPA = vi.hoisted(() => ({
  signUp: vi.fn(async () => ({ data: { session: null }, error: null })),
  signInWithPassword: vi.fn(async () => ({
    data: { session: { access_token: "t" } },
    error: null as { code?: string; message: string } | null,
  })),
  resend: vi.fn(async () => ({ error: null })),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      signUp: SUPA.signUp,
      signInWithPassword: (...args: unknown[]) => {
        CALLS.order.push("signInWithPassword");
        return (SUPA.signInWithPassword as (...a: unknown[]) => unknown)(...args);
      },
      resend: SUPA.resend,
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
  return render(
    <MemoryRouter initialEntries={[`/claim/${TOKEN}`]}>
      <Routes>
        <Route path="/claim/:token" element={<ClaimInvite />} />
        <Route path="/portal" element={<div>portal home</div>} />
        <Route path="/signin" element={<div>sign in screen</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Email"), "amelia@sanpo.test");
  await user.type(screen.getByLabelText("Choose a password"), "Correct-Horse-9-Battery");
  await user.click(screen.getByRole("button", { name: "Create account" }));
}

beforeEach(() => {
  CALLS.order.length = 0;
  API.claimSignup.mockClear();
  API.claimSignup.mockResolvedValue(undefined);
  API.previewInviteAuthed.mockClear();
  SUPA.signUp.mockClear();
  SUPA.signInWithPassword.mockClear();
  SUPA.signInWithPassword.mockResolvedValue({
    data: { session: { access_token: "t" } },
    error: null,
  } as never);
  SUPA.resend.mockClear();
});

describe("ClaimInvite signup (H31)", () => {
  it("creates the account through claim-signup, never public signUp — and signs in after", async () => {
    renderScreen();
    const user = userEvent.setup();
    await fillAndSubmit(user);

    await waitFor(() => expect(API.claimSignup).toHaveBeenCalledTimes(1));
    expect(API.claimSignup).toHaveBeenCalledWith(TOKEN, "amelia@sanpo.test", "Correct-Horse-9-Battery");
    // The whole point of the rewire: no browser-side account creation, so
    // the GoTrue signup toggle can be off without breaking this screen.
    expect(SUPA.signUp).not.toHaveBeenCalled();
    // The invite check precedes the sign-in that would need the account.
    expect(CALLS.order).toEqual(["claimSignup", "signInWithPassword"]);
    // ...and the flow continues into the authenticated preview.
    expect(await screen.findByText("Amelia")).toBeInTheDocument();
  });

  it("a dead invite dead-ends with its own sentence, before any sign-in", async () => {
    API.claimSignup.mockRejectedValueOnce(new InviteClaimError("expired"));
    renderScreen();
    const user = userEvent.setup();
    await fillAndSubmit(user);

    expect(await screen.findByText(INVITE_CLAIM_MESSAGE.expired)).toBeInTheDocument();
    expect(SUPA.signInWithPassword).not.toHaveBeenCalled();
  });

  it("a rate-limited attempt stays on the form — it is retryable, not a dead end", async () => {
    // 0048. `claimSignup` remaps any code in INVITE_CLAIM_MESSAGE onto
    // InviteClaimError, which this screen renders as a TERMINAL dead-end with
    // no way back. The rate limit is the opposite kind of refusal: waiting
    // fixes it. So the code must never collide with an invite outcome, and
    // the proof of that is at this end — the form must still be there.
    API.claimSignup.mockRejectedValueOnce(
      new EdgeError("Too many attempts for this invite. Wait a few minutes and try again.", "rate_limited"),
    );
    renderScreen();
    const user = userEvent.setup();
    await fillAndSubmit(user);

    expect(await screen.findByText(/Too many attempts for this invite/)).toBeInTheDocument();
    // Still on the form, and still submittable — which is what "retryable"
    // means here and what the dead-end stage would have removed.
    expect(screen.getByRole("button", { name: "Create account" })).toBeEnabled();
    expect(SUPA.signInWithPassword).not.toHaveBeenCalled();
  });

  it("an unconfirmed account is resent its confirmation and told to check email", async () => {
    // admin.createUser sends no email; on confirmations-on deployments the
    // sign-in refuses with email_not_confirmed, and the resend is what puts
    // a confirmation in their inbox at all.
    SUPA.signInWithPassword.mockResolvedValueOnce({
      data: { session: null },
      error: { code: "email_not_confirmed", message: "Email not confirmed" },
    } as never);
    renderScreen();
    const user = userEvent.setup();
    await fillAndSubmit(user);

    expect(await screen.findByText(/confirm your email/i)).toBeInTheDocument();
    // The redirect points BACK AT THE INVITE: without it the confirmation
    // link lands on site_url ("/"), a role-less user is routed to the
    // OPERATOR onboarding form, and completing it dead-ends the invite for
    // good (adversarial review).
    expect(SUPA.resend).toHaveBeenCalledWith({
      type: "signup",
      email: "amelia@sanpo.test",
      options: { emailRedirectTo: expect.stringContaining(`/claim/${TOKEN}`) },
    });
  });

  it("a wrong password on an existing account surfaces GoTrue's answer in place", async () => {
    // claim-signup collapses "already registered" into success; the sign-in
    // is where an existing-account holder learns their password was wrong,
    // rate-limited by GoTrue like any sign-in.
    SUPA.signInWithPassword.mockResolvedValueOnce({
      data: { session: null },
      error: { message: "Invalid login credentials" },
    } as never);
    renderScreen();
    const user = userEvent.setup();
    await fillAndSubmit(user);

    expect(await screen.findByText(/invalid login credentials/i)).toBeInTheDocument();
    // Still on the signup form — not a dead end, they can retype.
    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
  });
});

describe("ClaimInvite recovery edges (adversarial review)", () => {
  it("a failed resend never advances to 'check your email' — that sentence would be false", async () => {
    // Admin creation sends no confirmation, so this resend is the ONLY
    // thing that ever puts one in the inbox; a rate limit here with the
    // check-email screen showing means waiting forever on an empty inbox.
    SUPA.signInWithPassword.mockResolvedValueOnce({
      data: { session: null },
      error: { code: "email_not_confirmed", message: "Email not confirmed" },
    } as never);
    SUPA.resend.mockResolvedValueOnce({
      error: { message: "For security purposes, you can only request this once every 60 seconds" },
    } as never);
    renderScreen();
    const user = userEvent.setup();
    await fillAndSubmit(user);

    expect(await screen.findByText(/once every 60 seconds/i)).toBeInTheDocument();
    expect(screen.queryByText(/confirm your email/i)).not.toBeInTheDocument();
    // Still on the form: the person can wait and resubmit.
    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
  });

  it("a signed-in client holding a LIVE foreign invite gets the honest dead-end, not a silent bounce", async () => {
    // auth_user_id is unique — this account already IS somebody's portal.
    // The old unconditional /portal redirect left the operator staring at
    // an invite that never claims, with no sentence anywhere.
    Object.assign(authState, {
      session: { access_token: "t" } as never,
      role: "client" as Role,
      clientId: "c-existing",
    });
    try {
      renderScreen();
      expect(
        await screen.findByText(/already connected to another walker/i),
      ).toBeInTheDocument();
      expect(screen.queryByText("portal home")).not.toBeInTheDocument();
    } finally {
      Object.assign(authState, { session: null, role: null, clientId: null });
    }
  });

  it("a signed-in client re-opening their CLAIMED invite still lands on their portal", async () => {
    API.previewInviteAuthed.mockResolvedValueOnce({
      full_name: "Amelia",
      business_name: "Old Town Dog Care",
      already_claimed: true,
    });
    Object.assign(authState, {
      session: { access_token: "t" } as never,
      role: "client" as Role,
      clientId: "c-existing",
    });
    try {
      renderScreen();
      expect(await screen.findByText("portal home")).toBeInTheDocument();
    } finally {
      Object.assign(authState, { session: null, role: null, clientId: null });
    }
  });
});
