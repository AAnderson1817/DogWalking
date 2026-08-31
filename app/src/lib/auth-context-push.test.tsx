// The two push repairs are wired to the auth transition, and this is what
// keeps them wired (Codex review on PR #85).
//
// Both are `void`-ed fire-and-forget calls inside `AuthProvider`, so nothing
// downstream observes them and nothing else fails if one is deleted. That is
// the "a rule written down and connected to nothing" shape this repository
// keeps finding — most recently a `select` naming a column that does not
// exist, which no test could see because the fixtures asserted the invented
// shape.
//
// They cover opposite ends of the same hazard and neither replaces the other:
//
//   forgetPushDeviceOnSignedOut  the session is gone NOW. Push delivery does
//                                not care about the page's auth state, so a
//                                surviving subscription keeps putting the
//                                previous account's client names on the lock
//                                screen of a signed-out device.
//   reclaimPushDevice            somebody else has signed in on a device
//                                whose subscription survived. The row still
//                                belongs to the previous account, and the UI
//                                cannot repair it because `on` offers only
//                                OFF.
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PUSH = vi.hoisted(() => ({
  forgetPushDeviceOnSignedOut: vi.fn(async () => {}),
  reclaimPushDevice: vi.fn(async () => {}),
  forgetPushDeviceBeforeSignOut: vi.fn(async () => {}),
}));
const AUTH = vi.hoisted(() => ({
  session: null as { user: { id: string } } | null,
}));

vi.mock("./push", () => PUSH);
vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: AUTH.session } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signOut: () => Promise.resolve({ error: null }),
    },
    // resolveRole's queries. An operator with no billing row resolves fine and
    // is enough to reach the reclaim.
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: {
                id: "op-1",
                trial_ends_at: null,
                platform_subscription_status: "active",
                platform_customer_id: null,
              },
              error: null,
            }),
        }),
      }),
    }),
  },
}));

import { AuthProvider } from "./auth-context";

beforeEach(() => {
  PUSH.forgetPushDeviceOnSignedOut.mockClear();
  PUSH.reclaimPushDevice.mockClear();
});
afterEach(() => {
  AUTH.session = null;
});

describe("the auth transition drives both push repairs", () => {
  it("drops this browser's subscription the moment there is no session", async () => {
    AUTH.session = null;
    render(<AuthProvider>ready</AuthProvider>);
    await waitFor(() => expect(PUSH.forgetPushDeviceOnSignedOut).toHaveBeenCalled());
    expect(PUSH.reclaimPushDevice, "reclaimed with no session to claim for").not.toHaveBeenCalled();
  });

  it("claims a surviving subscription once a session resolves", async () => {
    AUTH.session = { user: { id: "op-1" } };
    render(<AuthProvider>ready</AuthProvider>);
    await waitFor(() => expect(PUSH.reclaimPushDevice).toHaveBeenCalled());
    expect(
      PUSH.forgetPushDeviceOnSignedOut,
      "unsubscribed a device belonging to the person who just signed in",
    ).not.toHaveBeenCalled();
  });
});
