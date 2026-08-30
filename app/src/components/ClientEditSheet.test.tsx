import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  // `inviteState` is the real one on purpose (the InvitePanel precedent): the
  // consequence copy is a function of the invite's lifecycle, and mocking that
  // would leave these tests asserting against a fixture of their own answer.
  return { inviteState: actual.inviteState, updateClient: (...a: unknown[]) => updateClient(...a) };
});

const client = (over: Partial<ClientRecord> = {}): ClientRecord => ({
  id: "client-1",
  auth_user_id: null,
  full_name: "Amelia Hart",
  email: "amelia@sanpo.test",
  phone: "+1 555-0101",
  updated_at: "2026-08-01T00:00:00Z",
  // A live invite unless a case says otherwise — that is what makes the three
  // invite sentences the right ones to expect.
  invite_revoked_at: null,
  invite_expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
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

/** Owns `open` for real, so a dismissal that IS allowed actually closes. */
function Host() {
  const [isOpen, setIsOpen] = useState(true);
  return (
    <ClientEditSheet
      open={isOpen}
      client={client()}
      onClose={() => setIsOpen(false)}
      onSaved={() => setIsOpen(false)}
    />
  );
}

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

  it("keeps the live region mounted before it has anything to say", async () => {
    // The FormError rule, applied to the note: `role="status"` on an element
    // that appears together with its text is announced far less reliably than
    // one already in the accessibility tree. It is empty, not absent.
    open();
    const note = screen.getByRole("status");
    expect(note.textContent).toBe("");
    expect(note.className).toContain("form-note");
  });

  it("says nothing at all when the change is only capitalisation", async () => {
    const user = userEvent.setup();
    open();
    await user.clear(field("Email"));
    await user.type(field("Email"), "Amelia@Sanpo.TEST");
    // Both ladders compare lower(trim(...)), so this admits exactly the same
    // claimant. A warning here would train the operator to ignore the one
    // that matters.
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("does not claim a withdrawn link still works", async () => {
    const user = userEvent.setup();
    open({ invite_revoked_at: "2026-08-02T00:00:00Z" });
    await user.clear(field("Email"));
    // The panel above this form shows "Invite withdrawn". Telling the operator
    // that anyone holding the link can claim would contradict it.
    expect(await screen.findByText(/isn't live/i)).toBeTruthy();
    expect(screen.queryByText(/anyone who has the invite link can claim/i)).toBeNull();
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

  it("keeps the attention rule for the notes that change who may claim", async () => {
    // Painting the Kaki rule on reassurance too would teach the operator that
    // it means nothing in particular — the erosion spec 05's status vocabulary
    // exists to prevent. So: ladder changes get it, explanations do not.
    const user = userEvent.setup();
    open();
    await user.clear(field("Email"));
    expect(screen.getByRole("status").className).toContain("form-note--attention");
  });

  it("does not paint the attention rule on reassurance", async () => {
    const user = userEvent.setup();
    open({ auth_user_id: "user-9" });
    await user.clear(field("Email"));
    await user.type(field("Email"), "moved@sanpo.test");
    const note = screen.getByRole("status");
    expect(note.textContent).toMatch(/does not change how they sign in/);
    expect(note.className).not.toContain("form-note--attention");
  });

  it("cannot be dismissed while the save is in flight", async () => {
    // Rendered with a real `open` owner: with a no-op `onClose` the sheet
    // never closes whatever the guard does, and the assertion below could not
    // fail. (It could not, in the first version of this test.)
    // The only confirmation a save worked is the header re-rendering, which an
    // operator who tapped the backdrop is not watching — so a PATCH that failed
    // after dismissal was indistinguishable from one that succeeded, on the
    // column that decides who may claim the invite.
    const user = userEvent.setup();
    let release: (v: unknown) => void = () => {};
    updateClient.mockImplementation(() => new Promise((r) => { release = r; }));
    render(<Host />);
    await user.clear(field("Phone"));
    await user.type(field("Phone"), "+1 555-0000");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateClient).toHaveBeenCalled());

    await user.keyboard("{Escape}");
    expect(screen.getByLabelText("Phone")).toBeTruthy(); // still open
    release({});
  });

  it("points the email field at the consequence it is describing", async () => {
    // The copy is the whole reason this form has prose. Without the link a
    // screen-reader user gets it once, unreliably, and can never return to it
    // from the field it is about.
    open();
    const note = screen.getByRole("status");
    expect(field("Email").getAttribute("aria-describedby")).toContain(note.id);
  });

  it("refuses to save an empty name", async () => {
    const user = userEvent.setup();
    open();
    await user.clear(field("Full name"));
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", true);
    expect(updateClient).not.toHaveBeenCalled();
  });
});
