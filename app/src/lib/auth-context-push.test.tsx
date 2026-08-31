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
  // The predicate each repair is handed is captured, so a test can ask — after
  // the next transition has arrived — whether a repair ALREADY RUNNING would
  // learn it had been superseded. That is the whole of the thirteenth round's
  // finding, and it is not visible from call counts.
  const superseded: Record<string, () => boolean> = {};
  const slow = (name: string, ms = 20) =>
    vi.fn(async (isSuperseded: () => boolean = () => false) => {
      superseded[name] = isSuperseded;
      log.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${name}:end`);
    });
  return {
    log,
    superseded,
    // A function, not `delete PUSH.superseded.forget` at the call sites: the
    // delete narrows the property to `never` for the rest of the test and the
    // later read stops compiling. `tsc` caught it; vitest did not.
    clearSupersede: () => {
      for (const key of Object.keys(superseded)) delete superseded[key];
    },
    forgetPushDeviceOnSignedOut: slow("forget"),
    reclaimPushDevice: slow("reclaim"),
    forgetPushDeviceBeforeSignOut: vi.fn(async () => {}),
  };
});
const AUTH = vi.hoisted(() => ({
  session: null as { user: { id: string } } | null,
  listener: null as null | ((event: string, session: unknown) => void),
  // How long the ROLE QUERY takes. Codex's fifteenth-round finding named this
  // directly: resolving it immediately hid the window the repairs race in.
  // Real role resolution is a database round trip; a repair is two
  // service-worker lookups, so in production the query is the SLOW one and a
  // test that pretends otherwise proves the opposite of what it claims.
  roleQueryMs: 60,
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
            new Promise((resolve) =>
              setTimeout(
                () =>
                  resolve({
                    data: {
                      id: "op-1",
                      trial_ends_at: null,
                      platform_subscription_status: "active",
                      platform_customer_id: null,
                    },
                    error: null,
                  }),
                AUTH.roleQueryMs,
              )
            ),
        }),
      }),
    }),
  },
}));

import { AuthProvider, useAuth } from "./auth-context";

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

  it("a cleanup already running learns that the sign-in superseded it", async () => {
    // `applyRole` awaits a database query before queueing the reclaim, so the
    // sign-out's cleanup has always STARTED by then and the runner's
    // pre-start check can never reach it. Without the signal it unsubscribes,
    // the reclaim then finds nothing, and the newly signed-in account is left
    // with push silently off — the account-switch case 0049's reassigning
    // upsert exists for.
    AUTH.session = null;
    render(<AuthProvider>ready</AuthProvider>);
    await waitFor(() => expect(AUTH.listener).not.toBeNull());
    await waitFor(() => expect(PUSH.log).toContain("forget:end"));
    PUSH.log.length = 0;
    PUSH.reclaimPushDevice.mockClear();
    // Or the assertions below read the MOUNT's predicate, which is superseded
    // for an unrelated reason — a vacuous pass, found by running.
    PUSH.clearSupersede();

    AUTH.listener!("SIGNED_OUT", null);
    // Long enough for the cleanup to actually START. Back to back, the
    // sign-in's transition arrives first and the cleanup is DROPPED rather
    // than run — rule 2, and the better outcome — so there would be no
    // running repair to tell.
    await waitFor(() => expect(PUSH.log).toContain("forget:start"));
    AUTH.listener!("SIGNED_IN", { user: { id: "op-1" } });
    await waitFor(() => expect(PUSH.reclaimPushDevice).toHaveBeenCalled());

    const wasSuperseded = PUSH.superseded.forget;
    expect(wasSuperseded, "the cleanup was handed no supersede signal").toBeTypeOf("function");
    expect(
      wasSuperseded!(),
      "a cleanup running when the sign-in arrived was not told it had been superseded",
    ).toBe(true);
  });

  it("tells it the moment the sign-in ARRIVES, not when the role query finishes", async () => {
    // The fifteenth round's first half. The role query is a database round
    // trip and a repair is two service-worker lookups, so keyed on scheduling
    // the cleanup had always finished before the reclaim was queued and
    // `superseded()` was never true — the stand-down was inert in production
    // while passing here, because the mock resolved instantly.
    //
    // This asks BEFORE the reclaim could possibly have been scheduled.
    AUTH.session = null;
    render(<AuthProvider>ready</AuthProvider>);
    await waitFor(() => expect(AUTH.listener).not.toBeNull());
    await waitFor(() => expect(PUSH.log).toContain("forget:end"));
    PUSH.log.length = 0;
    PUSH.reclaimPushDevice.mockClear();
    PUSH.clearSupersede();

    AUTH.listener!("SIGNED_OUT", null);
    await waitFor(() => expect(PUSH.superseded.forget).toBeTypeOf("function"));
    AUTH.listener!("SIGNED_IN", { user: { id: "op-1" } });

    expect(
      PUSH.reclaimPushDevice,
      "the role query resolved too fast for this test to mean anything",
    ).not.toHaveBeenCalled();
    expect(
      PUSH.superseded.forget!(),
      "the cleanup was not told until the reclaim was scheduled — too late to stop it",
    ).toBe(true);
  });

  it("a role lookup that finishes AFTER a sign-out does not claim the device", async () => {
    // The dangerous direction, and a leak the stand-down introduced: a lookup
    // begun before the sign-out finishes after it, queues its reclaim as the
    // newest repair, and the sign-out's cleanup stands down — leaving the
    // PREVIOUS account's live subscription on a signed-out device.
    AUTH.session = null;
    render(<AuthProvider>ready</AuthProvider>);
    await waitFor(() => expect(AUTH.listener).not.toBeNull());
    await waitFor(() => expect(PUSH.log).toContain("forget:end"));
    PUSH.log.length = 0;
    PUSH.reclaimPushDevice.mockClear();
    PUSH.forgetPushDeviceOnSignedOut.mockClear();
    PUSH.clearSupersede();

    AUTH.listener!("SIGNED_IN", { user: { id: "op-1" } }); // slow role query starts
    await new Promise((r) => setTimeout(r, 10));
    AUTH.listener!("SIGNED_OUT", null); // …and is overtaken
    await new Promise((r) => setTimeout(r, 200)); // long enough for it to land

    expect(
      PUSH.reclaimPushDevice,
      "a reclaim from a superseded transition ran and kept the old account's device",
    ).not.toHaveBeenCalled();
    expect(PUSH.forgetPushDeviceOnSignedOut, "the sign-out's cleanup did not run").toHaveBeenCalled();
    expect(
      PUSH.superseded.forget!(),
      "the cleanup was told to stand down by a repair it should have outranked",
    ).toBe(false);
  });
});

describe("sign-out is never held up by its own cleanup", () => {
  it("proceeds once the bounded cleanup times out", async () => {
    // `forgetPushDeviceBeforeSignOut` catches rejections, but a promise that
    // never SETTLES is not a rejection (Codex review on PR #85). A stalled
    // unsubscribe or hung RPC left the await pending forever: the button did
    // nothing, said nothing, and the person walked away from a shared device
    // still signed in — the exact hazard the cleanup exists to prevent,
    // caused by the cleanup.
    PUSH.forgetPushDeviceBeforeSignOut.mockImplementation(() => new Promise<void>(() => {}));
    AUTH.session = { user: { id: "op-1" } };
    let signOut: (() => Promise<void>) | null = null;
    function Probe() {
      signOut = useAuth().signOut;
      return null;
    }
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(signOut).not.toBeNull());

    let done = false;
    const pending = signOut!().then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(done, "sign-out completed before the cleanup deadline — the bound is not real").toBe(
      false,
    );
    await new Promise((r) => setTimeout(r, 3200));
    await pending;
    expect(done, "a hung cleanup kept the session alive").toBe(true);
    PUSH.forgetPushDeviceBeforeSignOut.mockImplementation(async () => {});
  }, 10_000);
});
