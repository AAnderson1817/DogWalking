import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InvitePanel } from "./InvitePanel";
import type { Clients } from "@/lib/types";

/**
 * Review H4. Before this panel there was no way to reissue or withdraw an
 * invite at all — `invite_token` was in no UPDATE column grant, no RPC rotated
 * it, and the client row could not be deleted once it had any child. A pet
 * owner who forwarded a link by mistake was told it was not possible.
 */

const rotateInvite = vi.fn();
const revokeInvite = vi.fn();
const unbindInvite = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    // inviteState and inviteUrlFor are the real ones on purpose: the state
    // machine is the thing under test, and mocking it would leave the
    // component asserting against a fixture of its own conclusion.
    inviteState: actual.inviteState,
    inviteUrlFor: actual.inviteUrlFor,
    rotateInvite: (...a: unknown[]) => rotateInvite(...a),
    revokeInvite: (...a: unknown[]) => revokeInvite(...a),
    unbindInvite: (...a: unknown[]) => unbindInvite(...a),
  };
});

const HOUR = 3600_000;

function client(over: Partial<Clients> = {}): Clients {
  return {
    id: "client-1",
    auth_user_id: null,
    invite_token: "tok-original",
    invite_expires_at: new Date(Date.now() + 24 * HOUR).toISOString(),
    invite_revoked_at: null,
    full_name: "Amelia Hart",
    ...over,
  } as Clients;
}

beforeEach(() => {
  rotateInvite.mockReset().mockResolvedValue("tok-fresh");
  revokeInvite.mockReset().mockResolvedValue(undefined);
  unbindInvite.mockReset().mockResolvedValue("tok-reissued");
});

describe("InvitePanel", () => {
  it("renders nothing for a purged client", () => {
    // "Send a new invite" on an erased record mints a live 14-day token whose
    // client row has a NULL email — the rung that admits ANY address — so one
    // click would make a purged client claimable. The database does not refuse
    // it: fn_unbind_invite has a purged_at guard, fn_rotate_invite does not.
    const { container } = render(
      <InvitePanel client={client({ purged_at: "2026-08-02T00:00:00Z" })} onChanged={() => {}} />,
    );
    expect(container.innerHTML).toBe("");
  });

  /**
   * A claimed invite is the case H4 had no answer for: revoke and rotate both
   * require an UNCLAIMED invite, and the row cannot be deleted because every
   * child FK restricts. The operator's only route was the service role.
   */
  it("offers release, and only release, once the client has claimed", () => {
    render(<InvitePanel client={client({ auth_user_id: "user-9" })} onChanged={() => {}} />);
    expect(screen.getByText("Claimed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Release this account" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
    // No live link on screen for an account that already exists.
    expect(screen.queryByText(/\/claim\//)).toBeNull();
  });

  it("releases a wrongly-claimed account and reissues", async () => {
    const onChanged = vi.fn();
    render(<InvitePanel client={client({ auth_user_id: "user-9" })} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole("button", { name: "Release this account" }));
    await waitFor(() => expect(unbindInvite).toHaveBeenCalledWith("client-1"));
    expect(onChanged).toHaveBeenCalled();
  });

  it("surfaces a refused release rather than appearing to succeed", async () => {
    unbindInvite.mockRejectedValue(new Error("no claimed invite to release for this client"));
    render(<InvitePanel client={client({ auth_user_id: "user-9" })} onChanged={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Release this account" }));
    await waitFor(() =>
      expect(screen.getByText(/no claimed invite to release/)).toBeTruthy()
    );
  });

  it("shows the live link and its expiry while the invite is active", () => {
    render(<InvitePanel client={client()} onChanged={() => {}} />);
    expect(screen.getByText("Invite active")).toBeTruthy();
    expect(screen.getByText(/\/claim\/tok-original$/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeTruthy();
  });

  /**
   * An expired invite must not offer Copy. The link is dead, and putting it on
   * the clipboard sends the client to a screen that refuses them.
   */
  it("does not offer to copy a dead link", () => {
    const expired = client({ invite_expires_at: new Date(Date.now() - HOUR).toISOString() });
    render(<InvitePanel client={expired} onChanged={() => {}} />);
    expect(screen.getByText("Invite expired")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send a new invite" })).toBeTruthy();
  });

  /** A withdrawn invite hides the URL entirely — it is not a thing to send. */
  it("hides the link once withdrawn", () => {
    render(
      <InvitePanel client={client({ invite_revoked_at: new Date().toISOString() })} onChanged={() => {}} />,
    );
    expect(screen.getByText("Invite withdrawn")).toBeTruthy();
    expect(screen.queryByText(/\/claim\//)).toBeNull();
  });

  /**
   * Revocation is precedence-sensitive: a revoked invite that has ALSO expired
   * is still "withdrawn", because that was somebody's decision and telling the
   * operator it merely lapsed misdescribes what they did.
   */
  it("reports a revoked-and-expired invite as withdrawn, not expired", () => {
    render(
      <InvitePanel
        client={client({
          invite_revoked_at: new Date().toISOString(),
          invite_expires_at: new Date(Date.now() - HOUR).toISOString(),
        })}
        onChanged={() => {}}
      />,
    );
    expect(screen.getByText("Invite withdrawn")).toBeTruthy();
  });

  /**
   * The panel shows the token it just minted, not the one it was rendered
   * with. Re-reading the row instead would race the operator pressing Copy and
   * hand them the old, still-dead link.
   */
  it("shows the newly minted link after a reissue", async () => {
    const onChanged = vi.fn();
    render(<InvitePanel client={client()} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole("button", { name: "Send a new link" }));
    await waitFor(() => expect(screen.getByText(/\/claim\/tok-fresh$/)).toBeTruthy());
    expect(rotateInvite).toHaveBeenCalledWith("client-1");
    expect(onChanged).toHaveBeenCalled();
  });

  it("surfaces a refusal instead of silently doing nothing", async () => {
    revokeInvite.mockRejectedValue(new Error("no unclaimed invite for this client"));
    render(<InvitePanel client={client()} onChanged={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    await waitFor(() =>
      expect(screen.getByText(/no unclaimed invite for this client/)).toBeTruthy()
    );
  });
});
