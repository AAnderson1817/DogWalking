import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The wiring of the edit surface, as opposed to its rules.
 *
 * `client-edit.test.ts` pins what `isEditable` and `propertyPatch` decide.
 * What this pins is that ClientDetail actually asks — a guard that is correct
 * in `lib/` and not consulted in the screen is the shape of guard this
 * repository has recorded more than once.
 */

const state = vi.hoisted(() => ({
  client: {} as Record<string, unknown>,
  properties: [] as unknown[],
}));
const updateProperty = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
  // The real state machine — the edit sheet's copy is a function of it.
  inviteState: actual.inviteState,
  getClient: async () => state.client,
  getMyOperator: async () => ({ id: "op-1", display_name: "Op" }),
  isNotFound: () => false,
  listPets: async () => [],
  listProperties: async () => state.properties,
  listCredentials: async () => [],
  listLedger: async () => [],
  listPlans: async () => [],
  listWalksDetailed: async () => [],
  walkPetNames: () => [],
  updateProperty: (...a: unknown[]) => updateProperty(...a),
  createProperty: vi.fn(),
  createPet: vi.fn(),
  updatePet: vi.fn(),
  uploadPetPhoto: vi.fn(),
  adjustCredits: vi.fn(),
  createCheckout: vi.fn(),
  createSetupCheckout: vi.fn(),
  createTopupCheckout: vi.fn(),
  updateClient: vi.fn(),
  };
});
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ session: { user: { id: "op-1" } }, operatorId: "op-1" }),
}));
// The panels around the header each fetch on their own; they are not what is
// under test here.
vi.mock("@/components/InvitePanel", () => ({ InvitePanel: () => null }));
vi.mock("@/components/ClientDataPanel", () => ({ ClientDataPanel: () => null }));
vi.mock("@/components/ScheduleEditor", () => ({ ScheduleTab: () => null }));
// Records a mount per open, so the `key` that remounts it is testable at all.
// The real sheet holds a DOOR CODE in local state; without a key it is the same
// element across property cards and keeps the previous property's draft.
const credMounts = vi.hoisted(() => ({ ids: [] as Array<string | undefined> }));
vi.mock("@/components/VaultFlows", () => ({
  CredentialRow: () => null,
  PutCredentialSheet: ({ open, propertyId }: { open: boolean; propertyId?: string }) => {
    const [mountedFor] = useState(propertyId);
    useEffect(() => {
      credMounts.ids.push(mountedFor);
    }, [mountedFor]);
    return open ? <div data-testid="cred-sheet">{String(mountedFor)}</div> : null;
  },
}));

const { default: ClientDetail } = await import("./ClientDetail");

const CLIENT = {
  id: "c-1",
  operator_id: "op-1",
  auth_user_id: null,
  full_name: "Amelia Hart",
  email: "amelia@sanpo.test",
  phone: "+1 555-0101",
  status: "active",
  credit_balance: 4,
  subscription_status: "none",
  purged_at: null,
  updated_at: "2026-08-01T00:00:00Z",
  invite_token: "tok",
  invite_expires_at: null,
  invite_revoked_at: null,
};

const PROPERTY = {
  id: "p-1",
  operator_id: "op-1",
  client_id: "c-1",
  label: "Old Town loop",
  address_line1: "12 Wabash Ave",
  city: "Chicago",
  postcode: "60601",
  access_notes_public: null,
};

async function show() {
  render(
    <MemoryRouter initialEntries={["/clients/c-1"]}>
      <Routes>
        <Route path="/clients/:id" element={<ClientDetail />} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByRole("heading", { name: "Amelia Hart" })).toBeTruthy());
}

beforeEach(() => {
  state.client = { ...CLIENT };
  state.properties = [{ ...PROPERTY }];
  updateProperty.mockReset().mockResolvedValue({});
});

describe("ClientDetail edit affordances", () => {
  it("offers Edit details on an ordinary client", async () => {
    await show();
    expect(screen.getByRole("button", { name: "Edit details" })).toBeTruthy();
  });

  it("withholds it from a purged client", async () => {
    // fn_purge_client (H5) leaves the row in place with the tombstone name and
    // a null email, and the UPDATE grant still covers both — so the product is
    // the only thing that can stop an edit re-personalising an erasure.
    state.client = { ...CLIENT, purged_at: "2026-08-02T00:00:00Z", full_name: "Amelia Hart" };
    await show();
    expect(screen.queryByRole("button", { name: "Edit details" })).toBeNull();
  });

  it("withholds every re-personalising surface from a purged client", async () => {
    // Codex review on PR #79, correctly. `fn_purge_client` (0040:240-244)
    // redacts the property to `label = 'Removed'` with every address field
    // nulled and KEEPS the row, because retained walks reference its id — so a
    // property Edit button lets the operator type the erased address straight
    // back in and relink it to that walk history. The same is true of adding a
    // property, adding a pet (purge DELETES pets, 0040:308) and adding a
    // secret (purge blanks the ciphertext and keeps the row, 0040:227-228).
    //
    // Guarding only the header — the first version of this change — left the
    // rule spec 03 states false two tabs over. Asserted per surface so that
    // fixing one and not its siblings fails here.
    const user = userEvent.setup();
    state.client = { ...CLIENT, purged_at: "2026-08-02T00:00:00Z" };
    state.properties = [{ ...PROPERTY, label: "Removed", address_line1: null, city: null, postcode: null }];
    await show();

    // PetsTab fetches, so "Add pet" is absent for a moment on ANY client.
    // Waiting for the loaded empty state first is what stops this assertion
    // passing before the tab has rendered at all.
    await screen.findByText("No pets yet");
    expect(screen.queryByRole("button", { name: "Edit details" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add pet" })).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Access" }));
    await waitFor(() => expect(screen.getByText("Removed")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Add property" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit Removed" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add secret for Removed" })).toBeNull();
  });

  it("still offers all of them on an ordinary client", async () => {
    // The other direction: a guard that hid everything unconditionally would
    // pass the test above and ship a dead screen.
    const user = userEvent.setup();
    await show();
    await screen.findByText("No pets yet");
    expect(screen.getByRole("button", { name: "Add pet" })).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Access" }));
    expect(await screen.findByRole("button", { name: "Add property" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit Old Town loop" })).toBeTruthy();
    // Named per property like its Edit sibling: a rotor listing three
    // identical "Add secret" buttons makes the door-code action the ambiguous
    // one, and picking the wrong one files an entry code against the wrong
    // address.
    expect(screen.getByRole("button", { name: "Add secret for Old Town loop" })).toBeTruthy();
  });

  it("opens the client sheet with the record's current values", async () => {
    const user = userEvent.setup();
    await show();
    await user.click(screen.getByRole("button", { name: "Edit details" }));
    expect(await screen.findByRole("dialog", { name: "Edit Amelia Hart" })).toBeTruthy();
    expect(screen.getByLabelText("Email")).toHaveProperty("value", "amelia@sanpo.test");
  });

  it("discards an abandoned draft — Escape then reopen shows the record again", async () => {
    // Found by an adversarial review of this PR. The sheet is mounted for the
    // life of the screen, so `useState(initial)` runs once: keyed on the row
    // alone, an operator who typed a wrong address and pressed Escape to
    // abandon it reopened to find it still there, still showing the
    // consequence note, one Save click from being written — to the column that
    // decides who may claim the invite.
    const user = userEvent.setup();
    await show();
    await user.click(screen.getByRole("button", { name: "Edit details" }));
    await user.clear(screen.getByLabelText("Email"));
    await user.type(screen.getByLabelText("Email"), "typo@wrong.test");
    const sheet = () => within(screen.getByRole("dialog"));
    expect(sheet().getByRole("status").textContent).toMatch(/stop working for the old address/);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByLabelText("Email")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Edit details" }));
    expect(await screen.findByLabelText("Email")).toHaveProperty("value", "amelia@sanpo.test");
    // And the note is silent again, rather than warning about a draft that no
    // longer exists.
    expect(sheet().getByRole("status").textContent).toBe("");
  });

  it("opens Add secret on a fresh form for each property", async () => {
    // The sheet holds a door code. Two actions per property card made moving
    // between cards the ordinary flow this change created, so without a key an
    // operator interrupted while entering the lockbox code for one property
    // opens "Add secret" on the next and finds the first property's secret
    // already in the field. Asserted as a REMOUNT, which is what the key buys.
    const user = userEvent.setup();
    state.properties = [
      { ...PROPERTY },
      { ...PROPERTY, id: "p-2", label: "Lakeview" },
    ];
    await show();
    await user.click(screen.getByRole("tab", { name: "Access" }));

    credMounts.ids.length = 0;
    await user.click(await screen.findByRole("button", { name: "Add secret for Old Town loop" }));
    expect(await screen.findByTestId("cred-sheet")).toHaveProperty("textContent", "p-1");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Add secret for Lakeview" }));
    expect(await screen.findByTestId("cred-sheet")).toHaveProperty("textContent", "p-2");

    // A mount per open. Without the key the element persists and the second
    // open reuses the first property's state.
    expect(credMounts.ids).toContain("p-1");
    expect(credMounts.ids).toContain("p-2");
  });

  it("edits a property in place, sending only what changed", async () => {
    const user = userEvent.setup();
    await show();
    await user.click(screen.getByRole("tab", { name: "Access" }));
    await user.click(await screen.findByRole("button", { name: "Edit Old Town loop" }));

    const city = await screen.findByLabelText("City");
    expect(city).toHaveProperty("value", "Chicago");
    await user.clear(city);
    await user.type(city, "Evanston");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateProperty).toHaveBeenCalled());
    expect(updateProperty).toHaveBeenCalledWith("p-1", { city: "Evanston" });
  });
});
