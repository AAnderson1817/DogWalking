import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

vi.mock("@/lib/api", () => ({
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
}));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ session: { user: { id: "op-1" } }, operatorId: "op-1" }),
}));
// The panels around the header each fetch on their own; they are not what is
// under test here.
vi.mock("@/components/InvitePanel", () => ({ InvitePanel: () => null }));
vi.mock("@/components/ClientDataPanel", () => ({ ClientDataPanel: () => null }));
vi.mock("@/components/ScheduleEditor", () => ({ ScheduleTab: () => null }));
vi.mock("@/components/VaultFlows", () => ({
  CredentialRow: () => null,
  PutCredentialSheet: () => null,
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

  it("opens the client sheet with the record's current values", async () => {
    const user = userEvent.setup();
    await show();
    await user.click(screen.getByRole("button", { name: "Edit details" }));
    expect(await screen.findByRole("dialog", { name: "Edit Amelia Hart" })).toBeTruthy();
    expect(screen.getByLabelText("Email")).toHaveProperty("value", "amelia@sanpo.test");
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
