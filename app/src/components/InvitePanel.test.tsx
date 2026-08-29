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
});

describe("InvitePanel", () => {
  it("renders nothing once the client has claimed", () => {
    const { container } = render(
      <InvitePanel client={client({ auth_user_id: "user-9" })} onChanged={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
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
