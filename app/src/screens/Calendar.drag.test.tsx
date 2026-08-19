import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POINTER_FINE } from "@/hooks/usePointerFine";

/**
 * Review M11. The hook test proves the media query; this proves the Calendar
 * uses it — which is where a correct rule can still leave the affordance on.
 *
 * Playwright declares only Desktop Chrome, so nothing in the e2e suite would
 * ever have caught this either. The Calendar needs a backend, so it cannot
 * join the backend-free e2e suite; this is the layer that can see it.
 */

const pointerFine = vi.hoisted(() => ({ value: true }));

const WALK = {
  id: "w-1",
  client_id: "c-1",
  scheduled_date: "2026-08-19",
  window_start: "10:00:00",
  window_end: "11:00:00",
  status: "scheduled",
  is_overage: false,
  distance_m: null,
  walk_pets: [{ pets: { name: "Luna" } }],
  property: { label: "Old Town loop" },
  client: { full_name: "Amelia" },
};

vi.mock("@/lib/api", () => ({
  listWalksDetailed: async () => [WALK],
  listClients: async () => [],
  listProperties: async () => [],
  listServiceTypes: async () => [],
  listPets: async () => [],
  createWalk: vi.fn(),
  setWalkPets: vi.fn(),
  updateWalk: vi.fn(),
  materializeWalks: vi.fn(),
  walkPetNames: (w: { walk_pets: { pets: { name: string } | null }[] }) =>
    w.walk_pets.flatMap((wp) => (wp.pets ? [wp.pets.name] : [])),
}));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ operatorId: "op-1", session: null }) }));

const { default: Calendar } = await import("./Calendar");

async function renderWeek() {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <Calendar />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.queryByText(/Loading/i)).toBeNull());
  // Drag-to-reschedule lives in the week view only.
  await user.click(screen.getByRole("tab", { name: "Week" }));
  return screen.getByRole("button", { name: /Luna/ });
}

describe("Calendar drag affordance", () => {
  beforeEach(() => {
    pointerFine.value = true;
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === POINTER_FINE ? pointerFine.value : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  });

  it("offers the drag on a device that can drag", async () => {
    const chip = await renderWeek();
    expect(chip).toHaveAttribute("draggable", "true");
    expect(chip.className).toContain("calendar-walk--draggable");
  });

  it("does NOT offer it on touch, where the drag cannot fire at all", async () => {
    // The whole finding: HTML5 drag-and-drop emits no events on touch, so the
    // grab cursor and the drag styling were advertising an interaction the
    // primary device cannot perform.
    pointerFine.value = false;
    const chip = await renderWeek();
    expect(chip).not.toHaveAttribute("draggable", "true");
    expect(chip.className).not.toContain("calendar-walk--draggable");
  });

  it("still opens the action sheet on touch, which is the path that works", async () => {
    // Removing the affordance is only correct because there is a working way
    // to reschedule — the same button, the same `reschedule()`.
    pointerFine.value = false;
    const chip = await renderWeek();
    await userEvent.setup().click(chip);
    expect(await screen.findByText(/Reschedule/i)).toBeInTheDocument();
  });
});
