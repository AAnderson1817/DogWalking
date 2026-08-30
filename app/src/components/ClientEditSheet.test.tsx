import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClientEditSheet } from "./ClientEditSheet";
import type { ClientRecord } from "@/lib/api";

/**
 * Client records were create-only: `updateClient` shipped with zero importers,
 * so a mistyped email could not be corrected from the product at all. Two
 * designs already assumed otherwise — spec 04 calls editing the roster email
 * the recovery for a wrongly-reserved invite, and `fn_unbind_invite` leaves
 * `email` set when it releases a wrongly-claimed account.
 *
 * The behaviour worth pinning is not that the form saves. It is that the form
 * says what saving DOES: on an unclaimed client `clients.email` is the last
 * rung of the claim ladder, so it decides who may become the account.
 */

const updateClient = vi.fn();

vi.mock("@/lib/api", () => ({
  updateClient: (...a: unknown[]) => updateClient(...a),
}));

const client = (over: Partial<ClientRecord> = {}): ClientRecord => ({
  id: "client-1",
  auth_user_id: null,
  full_name: "Amelia Hart",
  email: "amelia@sanpo.test",
  phone: "+1 555-0101",
  updated_at: "2026-08-01T00:00:00Z",
  ...over,
} as ClientRecord);

function open(over: Partial<ClientRecord> = {}) {
  const onSaved = vi.fn();
  render(
    <ClientEditSheet open client={client(over)} onClose={() => {}} onSaved={onSaved} />,
  );
  return onSaved;
}

const field = (name: string) => screen.getByLabelText(name);

beforeEach(() => {
  updateClient.mockReset().mockResolvedValue({});
});

describe("ClientEditSheet", () => {
  it("sends only the field that changed", async () => {
    const user = userEvent.setup();
    const onSaved = open();
    await user.clear(field("Phone"));
    await user.type(field("Phone"), "+1 555-0199");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(updateClient).toHaveBeenCalledWith("client-1", { phone: "+1 555-0199" });
  });

  it("writes null for a cleared field rather than an empty string", async () => {
    const user = userEvent.setup();
    open();
    await user.clear(field("Phone"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateClient).toHaveBeenCalled());
    expect(updateClient).toHaveBeenCalledWith("client-1", { phone: null });
  });

  it("does not write at all when nothing changed", async () => {
    const user = userEvent.setup();
    const onSaved = open();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    // `email` is the column the invite ladder reads. A save that rewrites it
    // on an untouched form is an effect the operator did not ask for.
    expect(updateClient).not.toHaveBeenCalled();
  });

  it("warns that clearing the email re-opens the invite to anyone with the link", async () => {
    const user = userEvent.setup();
    open();
    await user.clear(field("Email"));
    expect(
      await screen.findByText(/anyone who has the invite link can claim/i),
    ).toBeTruthy();
  });

  it("says a changed address transfers the invite", async () => {
    const user = userEvent.setup();
    open();
    await user.clear(field("Email"));
    await user.type(field("Email"), "fixed@sanpo.test");
    expect(await screen.findByText(/stop working for the old address/i)).toBeTruthy();
  });

  it("says an added address binds an invite that accepted anyone", async () => {
    const user = userEvent.setup();
    open({ email: null });
    await user.type(field("Email"), "amelia@sanpo.test");
    expect(await screen.findByText(/only that address can claim it/i)).toBeTruthy();
  });

  it("tells a claimed client's operator that the login does not change", async () => {
    const user = userEvent.setup();
    open({ auth_user_id: "user-9" });
    await user.clear(field("Email"));
    await user.type(field("Email"), "moved@sanpo.test");
    // The ladder stops at `already_claimed`; the login is auth.users.email,
    // which nothing in this repo updates after signup.
    expect(await screen.findByText(/does not change how they sign in/i)).toBeTruthy();
    expect(screen.queryByText(/invite link/i)).toBeNull();
  });

  it("says nothing at all when the change is only capitalisation", async () => {
    const user = userEvent.setup();
    open();
    await user.clear(field("Email"));
    await user.type(field("Email"), "Amelia@Sanpo.TEST");
    // Both ladders compare lower(trim(...)), so this admits exactly the same
    // claimant. A warning here would train the operator to ignore the one
    // that matters.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("surfaces a failed save instead of reporting success", async () => {
    const user = userEvent.setup();
    updateClient.mockRejectedValue(new Error("permission denied for table clients"));
    const onSaved = open();
    await user.clear(field("Phone"));
    await user.type(field("Phone"), "+1 555-0000");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/permission denied/i)).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("refuses to save an empty name", async () => {
    const user = userEvent.setup();
    open();
    await user.clear(field("Full name"));
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", true);
    expect(updateClient).not.toHaveBeenCalled();
  });
});
