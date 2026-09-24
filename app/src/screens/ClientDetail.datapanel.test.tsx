import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { MemoryRouter, Routes, Route, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The erasure panel holds a typed confirmation, a notice and an erasure
 * status, none of which belongs to the next client. Moving between two
 * clients reuses this route's element, so without a key the panel would be
 * the same instance with the last client's state in it (Codex on #106).
 */

const clients = vi.hoisted(() => ({
  byId: {} as Record<string, Record<string, unknown>>,
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    inviteState: actual.inviteState,
    getClient: async (id: string) => clients.byId[id],
    getMyOperator: async () => ({ id: "op-1", display_name: "Op" }),
    isNotFound: () => false,
    listPets: async () => [],
    listProperties: async () => [],
    listCredentials: async () => [],
    listLedger: async () => [],
    listPlans: async () => [],
    listWalksDetailed: async () => [],
    walkPetNames: () => [],
    clientEmailSuppressed: async () => null,
  };
});
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ session: { user: { id: "op-1" } }, operatorId: "op-1" }),
}));
vi.mock("@/components/InvitePanel", () => ({ InvitePanel: () => null }));
vi.mock("@/components/ScheduleEditor", () => ({ ScheduleTab: () => null }));
vi.mock("@/components/VaultFlows", () => ({ CredentialRow: () => null, PutCredentialSheet: () => null }));

// Records which client each mounted panel was created for.
const mounts = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock("@/components/ClientDataPanel", () => ({
  ClientDataPanel: ({ client }: { client: { id: string } }) => {
    const [createdFor] = useState(client.id);
    useEffect(() => {
      mounts.ids.push(createdFor);
    }, [createdFor]);
    return <div data-testid="data-panel">{createdFor}</div>;
  },
}));

const { default: ClientDetail } = await import("./ClientDetail");

const client = (id: string, name: string) => ({
  id,
  operator_id: "op-1",
  auth_user_id: null,
  full_name: name,
  email: null,
  phone: null,
  status: "archived",
  credit_balance: 0,
  subscription_status: "none",
  purged_at: "2026-09-24T10:00:00Z",
  updated_at: "2026-09-24T10:00:00Z",
  invite_token: "tok",
  invite_expires_at: null,
  invite_revoked_at: null,
});

function Jump() {
  const navigate = useNavigate();
  return <button onClick={() => navigate("/clients/c-2")}>next client</button>;
}

beforeEach(() => {
  mounts.ids.length = 0;
  clients.byId = { "c-1": client("c-1", "First Erased"), "c-2": client("c-2", "Second Erased") };
});

describe("ClientDetail and the erasure panel", () => {
  it("gives each client a panel of its own", async () => {
    render(
      <MemoryRouter initialEntries={["/clients/c-1"]}>
        <Jump />
        <Routes>
          <Route path="/clients/:id" element={<ClientDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("data-panel").textContent).toBe("c-1"));
    await userEvent.click(screen.getByRole("button", { name: "next client" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Second Erased" })).toBeTruthy());
    expect(screen.getByTestId("data-panel").textContent).toBe("c-2");
    expect(mounts.ids).toEqual(["c-1", "c-2"]);
  });
});
