// The wall's recovery rules (review H31, adversarial review). Billing state
// is fetched once per session, so the wall can be showing STALE data — a
// paying subscriber locked by a long-lived tab. Every rule here is a way
// back OUT: the mount-time refresh, the always-available re-check, the
// already-subscribed refusal treated as good news, and affordances that
// cover the locked states that CARRY a subscription.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BillingLocked } from "./BillingLocked";
import { EdgeError } from "@/lib/api";
import type { AuthState, Role } from "@/lib/auth-context";
import type { OperatorBillingState } from "@/lib/operator-access";

const API = vi.hoisted(() => ({
  checkout: vi.fn(async (): Promise<{ url: string | null }> => ({ url: "https://stripe/x" })),
  portal: vi.fn(async () => ({ url: "https://stripe/portal" })),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  createOperatorCheckout: () => API.checkout(),
  createOperatorPortal: () => API.portal(),
}));

const AUTH = vi.hoisted(() => ({
  value: null as AuthState | null,
}));
vi.mock("@/lib/auth-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-context")>()),
  useAuth: () => AUTH.value as AuthState,
}));

function mountWall(billing: Partial<OperatorBillingState>) {
  const refreshRole = vi.fn(async () => "operator" as Role);
  AUTH.value = {
    session: { access_token: "t" } as never,
    role: "operator",
    operatorId: "u1",
    clientId: null,
    operatorBilling: {
      trialEndsAt: "2020-01-01T00:00:00Z",
      platformSubscriptionStatus: "none",
      hasBilling: false,
      ...billing,
    },
    loading: false,
    roleError: false,
    reauth: vi.fn(async () => null),
    refreshRole,
    signOut: vi.fn(async () => undefined),
  };
  render(<MemoryRouter><BillingLocked /></MemoryRouter>);
  return { refreshRole };
}

beforeEach(() => {
  API.checkout.mockClear();
  API.checkout.mockResolvedValue({ url: "https://stripe/x" });
  API.portal.mockClear();
  vi.spyOn(window, "open").mockReturnValue(null);
});

describe("BillingLocked", () => {
  it("refreshes billing state on arrival — the wall is where stale data is catastrophic", async () => {
    const { refreshRole } = mountWall({});
    await waitFor(() => expect(refreshRole).toHaveBeenCalledTimes(1));
  });

  it("offers check-again unconditionally, not only after a checkout was opened", async () => {
    const { refreshRole } = mountWall({});
    await waitFor(() => expect(refreshRole).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: /check again/i }));
    await waitFor(() => expect(refreshRole).toHaveBeenCalledTimes(2));
  });

  it("treats already_subscribed as good news: refresh, not a refusal", async () => {
    // The server sees a live subscription this screen's stale state does
    // not — the person has PAID. Showing them the 409 as an error for
    // pressing Subscribe would be a dead end.
    API.checkout.mockRejectedValueOnce(
      new EdgeError("You already have a Sanpo subscription", "already_subscribed"),
    );
    const { refreshRole } = mountWall({});
    await waitFor(() => expect(refreshRole).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "Subscribe" }));
    expect(await screen.findByText(/already active — rechecking/i)).toBeInTheDocument();
    await waitFor(() => expect(refreshRole).toHaveBeenCalledTimes(2));
  });

  it("a paused subscription gets its own heading and the portal, never a doomed Subscribe", () => {
    mountWall({ platformSubscriptionStatus: "paused", hasBilling: true });
    expect(screen.getByRole("heading", { name: /subscription is paused/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Subscribe" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /manage billing/i })).toBeInTheDocument();
  });

  it("Manage billing appears whenever Sanpo billing exists — not only for cancelled", () => {
    mountWall({ platformSubscriptionStatus: "none", hasBilling: true });
    expect(screen.getByRole("button", { name: /manage billing/i })).toBeInTheDocument();
  });

  it("no billing yet: Subscribe and pricing, no portal button", () => {
    mountWall({});
    expect(screen.getByRole("button", { name: "Subscribe" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /manage billing/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /what's included/i })).toHaveAttribute("href", "/pricing");
  });
});
