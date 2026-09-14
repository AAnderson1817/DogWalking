import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Booking's committed sum prices PERSISTED walks from their `cost_credits`
 * snapshot (0043) — the figure `fn_debit_walk` will actually take — and falls
 * back to the live formula only for a row with no snapshot, which is the
 * coalesce `fn_walk_cost` performs. It used to run the live formula over every
 * row while the snapshot sat unread in the same rows, so a service re-priced
 * after a walk was booked moved the sum away from the server's figure; and the
 * sum decides whether the overage disclosure (review H12) is shown at all.
 *
 * The fixture makes the two answers DIFFER by design: the booked walk's
 * service costs 9 today and the walk was booked at 1. A client holding two
 * credits and composing a 1-credit walk is then either fine (snapshot: 1
 * booked, 1 left, no overage panel) or warned (live: 9 booked, 0 left, panel).
 * Against the live formula case 1 goes red on both assertions.
 */

const ids = vi.hoisted(() => ({ one: "svc-1", nine: "svc-9" }));
const fixture = vi.hoisted(() => ({ upcoming: [] as Record<string, unknown>[] }));

vi.mock("@/lib/api", () => ({
  getMyClient: async () => ({ id: "c-1", plan_id: null, credit_balance: 2 }),
  getMyOperatorView: async () => ({
    id: "op-1",
    display_name: "Op",
    business_name: "Op Walks",
    cancellation_cutoff_hours: 12,
    gps_retention_days: 365,
  }),
  // The default service is the cheap one, so the walk being composed costs
  // 1; the booked walk points at the service that has since gone up to 9.
  listServiceTypes: async () => [
    { id: ids.one, name: "Walk 30", credit_cost: 1, weekend_surcharge_credits: 0, visit_price_pence: null, is_default: true },
    { id: ids.nine, name: "Walk 60", credit_cost: 9, weekend_surcharge_credits: 0, visit_price_pence: null, is_default: false },
  ],
  listProperties: async () => [{ id: "p-1", label: "Home" }],
  listPets: async () => [{ id: "pet-1", name: "Luna" }],
  listWalksDetailed: async () => fixture.upcoming,
  getPlan: async () => null,
  bookWalk: vi.fn(),
  cancelOwnWalk: vi.fn(),
  walkPetNames: () => [],
  withinCancellationWindow: () => true,
}));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ session: null, signOut: vi.fn() }),
}));

const { default: Booking } = await import("./Booking");

/** A scheduled walk on the 9-credit service, booked when it cost `cost_credits`. */
const bookedWalk = (cost_credits: number | null) => ({
  id: "w-1",
  status: "scheduled",
  is_overage: false,
  service_type_id: ids.nine,
  scheduled_date: "2026-07-01", // a Wednesday, so the live fallback is the bare 9
  window_start: "09:00:00",
  window_end: "10:00:00",
  cost_credits,
  walk_pets: [],
  property: { label: "Home" },
  client: null,
});

async function renderBooking() {
  render(
    <MemoryRouter>
      <Booking />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.queryByText(/Loading booking options/i)).toBeNull());
  // The cost card renders only once a date is picked. A weekday, so the
  // composed walk costs exactly its service's base price: 1.
  fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-07-02" } });
  await screen.findByText("Cost");
}

/** The "Your balance: N — M already booked, K left" line, as one string. */
function balanceLine(): string {
  return screen.getByText(/already booked/).textContent ?? "";
}

describe("Booking · credits already booked", () => {
  beforeEach(() => {
    fixture.upcoming = [];
  });

  it("prices a booked walk from its snapshot, not the service's price today", async () => {
    fixture.upcoming = [bookedWalk(1)];
    await renderBooking();
    expect(balanceLine()).toMatch(/1 already booked, 1 left/);
    // Two credits, one booked at one, one being composed at one: no overage.
    expect(document.querySelector(".booking-cost")).not.toBeNull();
    expect(document.querySelector(".booking-cost--overage")).toBeNull();
  });

  /**
   * A row predating 0043 carries no snapshot and costs what the live tables
   * say — pinned the way `smoke.sql` pins the server's own fallback, because
   * "snapshot-first" with the fallback dropped prices those rows at zero.
   */
  it("falls back to the live formula for a walk with no snapshot", async () => {
    fixture.upcoming = [bookedWalk(null)];
    await renderBooking();
    expect(balanceLine()).toMatch(/9 already booked, 0 left/);
    expect(document.querySelector(".booking-cost--overage")).not.toBeNull();
  });
});
