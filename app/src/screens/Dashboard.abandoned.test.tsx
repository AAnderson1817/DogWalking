import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Review M28. The sweep marking a walk is only half a fix; this is the half
 * that makes it visible. Today asks for `{ date: today }`, so a walk started
 * yesterday and never ended appeared on no screen in the product — not billed,
 * not reported, and with nothing anywhere to tell the operator it existed.
 *
 * The load being date-unfiltered is therefore the thing under test, and it is
 * asserted on a walk whose `scheduled_date` is NOT today. A version that
 * merged the flagged walks into the same day-filtered query would pass any
 * test using today's date, and would fix nothing.
 */

const YESTERDAY = "2026-08-17";

const walk = (over: Record<string, unknown> = {}) => ({
  id: "w-stale",
  client_id: "c-1",
  scheduled_date: YESTERDAY,
  window_start: "10:00:00",
  status: "in_progress",
  started_at: `${YESTERDAY}T15:00:00.000Z`,
  abandoned_at: "2026-08-18T09:00:00.000Z",
  distance_m: null,
  is_overage: false,
  walk_pets: [{ pets: { name: "Luna" } }],
  property: { label: "Old Town loop" },
  client: { full_name: "Amelia" },
  ...over,
});

const abandoned = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock("@/lib/api", () => ({
  getMyOperator: async () => ({ id: "op-1", display_name: "Op", low_credit_threshold: 2 }),
  listWalksDetailed: async () => [],
  listAbandonedWalks: async () => abandoned.rows,
  listClients: async () => [],
  listPayments: async () => [],
  walkPetNames: (w: { walk_pets: { pets: { name: string } | null }[] }) =>
    w.walk_pets.flatMap((wp) => (wp.pets ? [wp.pets.name] : [])),
}));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ session: null, signOut: vi.fn() }),
}));
vi.mock("@/components/NotificationInbox", () => ({ NotificationBell: () => null }));

const { default: Dashboard } = await import("./Dashboard");

async function renderToday() {
  render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.queryByText(/Loading today/i)).toBeNull());
}

describe("Today · unfinished walks", () => {
  beforeEach(() => {
    abandoned.rows = [];
  });

  it("shows nothing when no walk was left unfinished", async () => {
    await renderToday();
    expect(screen.queryByText("Unfinished walks")).toBeNull();
  });

  it("surfaces a walk from another day, which Today's own query cannot see", async () => {
    abandoned.rows = [walk()];
    await renderToday();
    expect(await screen.findByText("Unfinished walks")).toBeInTheDocument();
    expect(screen.getByText(/Luna/)).toBeInTheDocument();
  });

  it("links to Walk Mode, the one place the walk can actually be finished", async () => {
    abandoned.rows = [walk()];
    await renderToday();
    // Not the client record, which is where the schedule rows go: finishing
    // the walk is what bills it and sends the report, and END WALK lives here.
    const link = await screen.findByRole("link", { name: /Luna/ });
    expect(link).toHaveAttribute("href", "/walks/w-stale/live");
  });
});
