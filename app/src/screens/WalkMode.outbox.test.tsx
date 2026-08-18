import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Review M7, the visible half. `gps-outbox.test.ts` proves the queue no longer
 * destroys route data; this proves the operator is told when it is behind, and
 * when something has been lost.
 *
 * The banner used to read `navigator.onLine` and nothing else, so a phone on a
 * captive portal — or on one bar with no throughput — showed "CURRENT" while
 * batches piled up unsent and were eventually given up on. The screen and the
 * truth were unrelated.
 */

const status = vi.hoisted(() => ({ value: { pending: 0, lostPoints: 0 } }));
const online = vi.hoisted(() => ({ value: true }));

vi.mock("@/hooks/useGeolocation", () => ({
  useGeolocation: () => ({ points: [], error: null, permission: "granted", lastFixAt: null }),
}));
vi.mock("@/hooks/useWakeLock", () => ({ useWakeLock: () => ({ held: true, supported: true }) }));
vi.mock("@/hooks/useOnline", () => ({ useOnline: () => online.value }));
vi.mock("@/hooks/useWalkChannel", () => ({
  useWalkChannel: () => ({
    sendPoint: vi.fn(),
    pendingPoints: async () => [],
    end: vi.fn(),
    outboxStatus: status.value,
  }),
}));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ operatorId: "op-1", session: null }) }));
vi.mock("@/components/MapView", () => ({ MapView: () => <div data-testid="map" /> }));

const WALK = {
  id: "walk-1",
  status: "in_progress",
  started_at: new Date("2026-08-18T14:00:00Z").toISOString(),
  service_type_id: "svc-1",
  notes: null,
  credits_debited: 0,
  is_overage: false,
};

vi.mock("@/lib/api", () => ({
  getWalk: async () => WALK,
  listWalkPets: async () => [],
  listWalkGpsPoints: async () => [],
  listWalkPhotos: async () => [],
  listServiceTypes: async () => [{ id: "svc-1", duration_minutes: 30 }],
  signedPhotoUrl: async () => "",
  insertWalkPhoto: vi.fn(),
  uploadWalkPhoto: vi.fn(),
  updateWalk: vi.fn(),
  completeWalk: vi.fn(),
}));

const { default: WalkMode } = await import("./WalkMode");

async function mount() {
  render(
    <MemoryRouter initialEntries={["/walks/walk-1/live"]}>
      <Routes>
        <Route path="/walks/:id/live" element={<WalkMode />} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByTestId("map")).toBeInTheDocument());
}

describe("Walk Mode sync state", () => {
  beforeEach(() => {
    status.value = { pending: 0, lostPoints: 0 };
    online.value = true;
  });

  it("says CURRENT only when online with nothing waiting", async () => {
    await mount();
    expect(screen.getByText("CURRENT")).toBeInTheDocument();
  });

  it("does NOT say CURRENT while batches are still unsent", async () => {
    // The exact bug: `navigator.onLine` true, queue backing up, screen calm.
    status.value = { pending: 3, lostPoints: 0 };
    await mount();
    expect(screen.queryByText("CURRENT")).toBeNull();
    expect(screen.getByText("SAVING")).toBeInTheDocument();
    expect(screen.getByText(/3 route updates still saving/)).toBeInTheDocument();
  });

  it("still says OFFLINE when the device is offline", async () => {
    online.value = false;
    status.value = { pending: 2, lostPoints: 0 };
    await mount();
    expect(screen.getByText("OFFLINE")).toBeInTheDocument();
  });

  it("says so when route data has been given up on", async () => {
    // Before M7 these points were deleted outright — no log, no counter, no
    // flag — so the route lost a stretch and the distance under-reported with
    // nothing anywhere saying why.
    status.value = { pending: 0, lostPoints: 14 };
    await mount();
    expect(await screen.findByText(/14 location updates could not be saved/)).toBeInTheDocument();
    expect(screen.getByText("Route incomplete")).toBeInTheDocument();
  });

  it("stays quiet about lost data when there is none", async () => {
    await mount();
    expect(screen.queryByText("Route incomplete")).toBeNull();
  });
});
