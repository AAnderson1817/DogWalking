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

const PUSH = vi.hoisted(() => {
  // Both repairs record when they START and when they FINISH, because the
  // question these tests ask is about OVERLAP, which a call counter cannot
  // see (Codex review on PR #85).
  const log: string[] = [];
  const slow = (name: string, ms = 20) =>
    vi.fn(async () => {
      log.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${name}:end`);
    });
  return {
    log,
    forgetPushDeviceOnSignedOut: slow("forget"),
    reclaimPushDevice: slow("reclaim"),
    forgetPushDeviceBeforeSignOut: vi.fn(async () => {}),
  };
});
const AUTH = vi.hoisted(() => ({
  session: null as { user: { id: string } } | null,
  listener: null as null | ((event: string, session: unknown) => void),
}));

vi.mock("./push", () => ({
  forgetPushDeviceOnSignedOut: PUSH.forgetPushDeviceOnSignedOut,
  reclaimPushDevice: PUSH.reclaimPushDevice,
  forgetPushDeviceBeforeSignOut: PUSH.forgetPushDeviceBeforeSignOut,
}));
vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: AUTH.session } }),
      // Captured, so a test can drive two transitions itself. Rendering twice
      // does NOT produce them: the provider's effect depends on stable
      // callbacks, so it subscribes once and a rerender re-runs nothing —
      // which is why the first version of the overlap test below passed
      // against the unserialized code it exists to catch.
      onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
        AUTH.listener = cb;
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
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
  PUSH.log.length = 0;
});
afterEach(() => {
  AUTH.session = null;
  AUTH.listener = null;
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

describe("the repairs go through the serial runner", () => {
  it("a sign-out followed straight by a sign-in never runs the two at once", async () => {
    // The WIRING, not the rules — those live in `serial-repair.test.ts`,
    // because `applyRole` is async so the provider can only ever exercise the
    // sequential case. Unwired, the sign-out's cleanup (which reads
    // `pushManager.getSubscription()` and then unsubscribes) is still in
    // flight when the sign-in's reclaim reads the same subscription, and
    // either completion order loses: the new account ends up with a dead
    // server row or with push silently off.
    AUTH.session = null;
    render(<AuthProvider>ready</AuthProvider>);
    await waitFor(() => expect(AUTH.listener).not.toBeNull());
    // The mount's own null session correctly queues a cleanup. Let it finish
    // before measuring, or the log opens with a dangling `:end`.
    await waitFor(() => expect(PUSH.log).toContain("forget:end"));
    PUSH.log.length = 0;
    PUSH.reclaimPushDevice.mockClear();

    AUTH.listener!("SIGNED_OUT", null);
    AUTH.listener!("SIGNED_IN", { user: { id: "op-1" } });
    await waitFor(() => expect(PUSH.reclaimPushDevice).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 120));

    expect(PUSH.log.length, "neither repair ran").toBeGreaterThan(0);
    let running = 0;
    for (const entry of PUSH.log) {
      if (entry.endsWith(":start")) {
        expect(running, `overlapping repairs: ${PUSH.log.join(" ")}`).toBe(0);
        running += 1;
      } else running -= 1;
    }
    expect(running, `unbalanced log: ${PUSH.log.join(" ")}`).toBe(0);
  });
});
