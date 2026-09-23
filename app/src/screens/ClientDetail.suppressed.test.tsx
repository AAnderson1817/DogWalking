import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 0052: the operator is told when a client's address has
 * opted out of email.
 *
 * `suppressedEmailNotice` (client-edit.test.ts) pins what the notice SAYS.
 * This pins that ClientDetail asks, asks again when the address changes, never
 * shows one address's answer against another, and that an advisory check
 * cannot take the client record down with it.
 */

const state = vi.hoisted(() => ({
  // The row as the database holds it. `getClient` and the suppression check
  // both read it at call time, as the real ones do.
  client: {} as Record<string, unknown>,
  // What `fn_client_email_suppressed` answers, by address. A promise per
  // address so a test can hold one back and choose when it arrives.
  answers: {} as Record<string, Promise<boolean>>,
  asked: [] as string[],
}));
const updateClient = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    inviteState: actual.inviteState,
    getClient: async () => ({ ...state.client }),
    getMyOperator: async () => ({ id: "op-1", display_name: "Op" }),
    isNotFound: () => false,
    listPets: async () => [],
    listProperties: async () => [],
    listCredentials: async () => [],
    listLedger: async () => [],
    listPlans: async () => [],
    listWalksDetailed: async () => [],
    walkPetNames: () => [],
    updateProperty: vi.fn(),
    createProperty: vi.fn(),
    createPet: vi.fn(),
    updatePet: vi.fn(),
    uploadPetPhoto: vi.fn(),
    adjustCredits: vi.fn(),
    createCheckout: vi.fn(),
    createSetupCheckout: vi.fn(),
    createTopupCheckout: vi.fn(),
    updateClient: (...a: unknown[]) => updateClient(...a),
    clientEmailSuppressed: (id: string) => {
      const email = String(state.client.email);
      state.asked.push(`${id} ${email}`);
      return state.answers[email] ?? Promise.resolve(false);
    },
  };
});
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ session: { user: { id: "op-1" } }, operatorId: "op-1" }),
}));
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

const NOTICE = /Email to this address is turned off/;

function held() {
  let resolve!: (v: boolean) => void;
  const promise = new Promise<boolean>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function show() {
  render(
    <MemoryRouter initialEntries={["/clients/c-1"]}>
      <Routes>
        <Route path="/clients/:id" element={<ClientDetail />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByRole("heading", { name: "Amelia Hart" });
}

/** The live region in the client header, whatever it currently says. */
function headerStatus(): HTMLElement {
  const header = screen.getByRole("heading", { name: "Amelia Hart" }).closest("header");
  const region = header?.querySelector<HTMLElement>('[role="status"]');
  if (!region) throw new Error("the client header has no status region");
  return region;
}

async function changeEmailTo(email: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Edit details" }));
  const field = await screen.findByLabelText("Email");
  await user.clear(field);
  await user.type(field, email);
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

beforeEach(() => {
  state.client = { ...CLIENT };
  state.answers = {};
  state.asked = [];
  updateClient.mockReset().mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
    state.client = { ...state.client, ...patch, updated_at: "2026-08-02T00:00:00Z" };
    return { ...state.client };
  });
});

describe("ClientDetail — a client's address has opted out of email", () => {
  it("tells the operator, in the client header, in a live region", async () => {
    state.answers["amelia@sanpo.test"] = Promise.resolve(true);
    await show();
    await waitFor(() => expect(headerStatus().textContent).toMatch(NOTICE));
    expect(headerStatus().textContent).toMatch(/Amelia Hart won't get walk updates or billing notices by email/);
    expect(headerStatus().textContent).toMatch(/fix it with Edit details/);
  });

  it("says nothing when the address is deliverable — but the region is already there", async () => {
    // Mounted before its text can arrive, because the text usually arrives just
    // after a save, and a live region that appears together with its text is
    // announced far less reliably than one that was already in the page.
    await show();
    await waitFor(() => expect(state.asked).toEqual(["c-1 amelia@sanpo.test"]));
    expect(headerStatus().textContent).toBe("");
  });

  it("does not ask about a client with no address", async () => {
    state.client = { ...CLIENT, email: null };
    await show();
    expect(state.asked).toEqual([]);
    expect(headerStatus().textContent).toBe("");
  });

  it("leaves the record on screen when the check itself fails", async () => {
    // Advisory. Folded into `reload`, the same failure would replace the whole
    // client with "Couldn't load this client" — the M39 stranding, for a
    // notice that was never necessary to show the record.
    const failed = Promise.reject(new Error("network down"));
    // Handled here too, so the rejection is not reported as unhandled in the
    // moment before the screen attaches its own handler.
    failed.catch(() => {});
    state.answers["amelia@sanpo.test"] = failed;
    await show();
    await waitFor(() => expect(state.asked).toHaveLength(1));
    expect(screen.getByRole("heading", { name: "Amelia Hart" })).toBeTruthy();
    expect(screen.queryByText(/Couldn't load this client/)).toBeNull();
    expect(headerStatus().textContent).toBe("");
  });

  it("asks again when the operator saves a different address, and says so", async () => {
    // The flow the backlog item names: an edit to an address that has already
    // opted out. The answer lands in the same always-mounted region, so it is
    // announced right after the save that caused it.
    state.answers["typo@gmial.test"] = Promise.resolve(true);
    await show();
    await waitFor(() => expect(state.asked).toHaveLength(1));
    expect(headerStatus().textContent).toBe("");

    await changeEmailTo("typo@gmial.test");

    await waitFor(() => expect(headerStatus().textContent).toMatch(NOTICE));
    expect(state.asked).toEqual(["c-1 amelia@sanpo.test", "c-1 typo@gmial.test"]);
  });

  it("never shows one address's answer against another", async () => {
    // Suppressed address, notice showing; the operator fixes the typo. Until
    // the new address has been checked, the old answer is about an address
    // this client no longer has — showing it would tell the operator the fix
    // did not work.
    state.answers["amelia@sanpo.test"] = Promise.resolve(true);
    const pending = held();
    state.answers["amelia.hart@sanpo.test"] = pending.promise;
    await show();
    await waitFor(() => expect(headerStatus().textContent).toMatch(NOTICE));

    await changeEmailTo("amelia.hart@sanpo.test");
    await waitFor(() => expect(state.asked).toHaveLength(2));
    expect(headerStatus().textContent).toBe("");

    pending.resolve(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(headerStatus().textContent).toBe("");
  });

  it("keeps the notice through a capitalisation fix", async () => {
    // The sender lowercases the address before it looks, so "AMELIA@…" and
    // "amelia@…" are the same address to it. While the re-check is in flight
    // the answer already on screen is still true; blinking it off and on would
    // re-announce a notice about an address that did not change.
    state.answers["amelia@sanpo.test"] = Promise.resolve(true);
    const pending = held();
    state.answers["AMELIA@sanpo.test"] = pending.promise;
    await show();
    await waitFor(() => expect(headerStatus().textContent).toMatch(NOTICE));

    await changeEmailTo("AMELIA@sanpo.test");
    await waitFor(() => expect(state.asked).toHaveLength(2));
    expect(headerStatus().textContent).toMatch(NOTICE);

    pending.resolve(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(headerStatus().textContent).toMatch(NOTICE);
  });

  it("does not let a slow answer for the previous address overwrite the current one", async () => {
    // The first check is still in flight when the operator saves a new
    // address, and the new address has opted out. When the old answer finally
    // lands it belongs to an address the client no longer has; accepting it
    // would hide the notice the operator was just shown.
    const slow = held();
    state.answers["amelia@sanpo.test"] = slow.promise;
    state.answers["typo@gmial.test"] = Promise.resolve(true);
    await show();

    await changeEmailTo("typo@gmial.test");
    await waitFor(() => expect(headerStatus().textContent).toMatch(NOTICE));

    slow.resolve(false);
    // Let the late answer settle before asserting it changed nothing.
    await new Promise((r) => setTimeout(r, 0));
    expect(headerStatus().textContent).toMatch(NOTICE);
  });
});
