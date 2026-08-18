import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OVERRUN_CAP_MS, OVERRUN_GRACE_MS } from "@/lib/walk-session";

/**
 * Review M28. `walk-session.test.ts` proves the RULE; this proves the WIRING,
 * which is where the rule can be right and the screen still wrong. In
 * particular it asserts what the pure test structurally cannot: that reaching
 * the cap actually stops the geolocation watch. A banner that says recording
 * has stopped while the watch runs on is the same defect with better copy.
 */

const STARTED = Date.UTC(2026, 7, 18, 14, 0, 0);
const DURATION_MINUTES = 30;

const geoActive = vi.hoisted(() => ({ calls: [] as boolean[] }));
vi.mock("@/hooks/useGeolocation", () => ({
  useGeolocation: (on: boolean) => {
    geoActive.calls.push(on);
    return { points: [], error: null, permission: "granted", lastFixAt: null };
  },
}));
vi.mock("@/hooks/useWakeLock", () => ({
  useWakeLock: () => ({ held: true, supported: true }),
}));
vi.mock("@/hooks/useOnline", () => ({ useOnline: () => true }));
vi.mock("@/hooks/useWalkChannel", () => ({
  useWalkChannel: () => ({
    sendPoint: vi.fn(),
    pendingPoints: async () => [],
    end: vi.fn(),
  }),
}));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ operatorId: "op-1", session: null }),
}));
vi.mock("@/components/MapView", () => ({ MapView: () => <div data-testid="map" /> }));

const WALK = {
  id: "walk-1",
  status: "in_progress",
  started_at: new Date(STARTED).toISOString(),
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
  listServiceTypes: async () => [{ id: "svc-1", duration_minutes: DURATION_MINUTES }],
  signedPhotoUrl: async () => "",
  insertWalkPhoto: vi.fn(),
  uploadWalkPhoto: vi.fn(),
  updateWalk: vi.fn(),
  completeWalk: vi.fn(),
}));

const { default: WalkMode } = await import("./WalkMode");

/** Mounts Walk Mode with the wall clock pinned `elapsedMs` after the start. */
async function mountAt(elapsedMs: number) {
  vi.setSystemTime(STARTED + elapsedMs);
  render(
    <MemoryRouter initialEntries={["/walks/walk-1/live"]}>
      <Routes>
        <Route path="/walks/:id/live" element={<WalkMode />} />
      </Routes>
    </MemoryRouter>,
  );
  // The duration comes from a second, deliberately non-blocking request.
  await waitFor(() => expect(screen.getByTestId("map")).toBeInTheDocument());
  await waitFor(() => expect(geoActive.calls.length).toBeGreaterThan(0));
}

const minutes = (n: number) => n * 60_000;
const stillWalking = () => screen.queryByText(/Still walking\?/i);
const stopped = () => screen.queryByText(/Recording stopped/i);
/** What the watch was last told — the assertion the pure test cannot make. */
const watchOn = () => geoActive.calls[geoActive.calls.length - 1];

describe("Walk Mode overrun bound", () => {
  beforeEach(() => {
    geoActive.calls.length = 0;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says nothing and keeps recording on a walk running normally", async () => {
    await mountAt(minutes(20));
    expect(stillWalking()).toBeNull();
    expect(stopped()).toBeNull();
    expect(watchOn()).toBe(true);
  });

  it("says nothing while the walk is merely running over", async () => {
    await mountAt(minutes(DURATION_MINUTES) + OVERRUN_GRACE_MS - minutes(1));
    expect(stillWalking()).toBeNull();
    expect(watchOn()).toBe(true);
  });

  it("asks once past the booked duration plus grace, without stopping GPS", async () => {
    await mountAt(minutes(DURATION_MINUTES) + OVERRUN_GRACE_MS + minutes(1));
    await waitFor(() => expect(stillWalking()).not.toBeNull());
    expect(stopped()).toBeNull();
    // The half that matters. An operator who is genuinely still out must not
    // lose the route because they had not looked at their phone.
    expect(watchOn()).toBe(true);
  });

  it("stops the watch once the question has gone unanswered", async () => {
    await mountAt(minutes(DURATION_MINUTES) + OVERRUN_GRACE_MS + OVERRUN_CAP_MS + minutes(1));
    await waitFor(() => expect(stopped()).not.toBeNull());
    await waitFor(() => expect(watchOn()).toBe(false));
    // One message, not two: the prompt is superseded by the outcome.
    expect(stillWalking()).toBeNull();
  });

  it("resumes recording when the operator answers", async () => {
    await mountAt(minutes(DURATION_MINUTES) + OVERRUN_GRACE_MS + OVERRUN_CAP_MS + minutes(1));
    await waitFor(() => expect(stopped()).not.toBeNull());

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole("button", { name: "Resume recording" }));

    await waitFor(() => expect(stopped()).toBeNull());
    await waitFor(() => expect(watchOn()).toBe(true));
    // And the prompt does not immediately return. Measuring the snooze from
    // `started_at` rather than from the answer would put it straight back on
    // screen — a button that visibly does nothing.
    expect(stillWalking()).toBeNull();
  });
});
