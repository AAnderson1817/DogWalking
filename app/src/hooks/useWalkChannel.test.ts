import { describe, expect, it } from "vitest";
import { channelState } from "./useWalkChannel";

/**
 * Review M10. `channel.subscribe()` took no status callback, so a failed join
 * was MUTE — and that matters more since migration 0020 made the walk topic
 * private and authorization real. A rejected join now looks exactly like a
 * walk where nothing has happened yet: the operator's screen says it is
 * broadcasting, the client's portal shows a map that will never move, and
 * neither is told.
 *
 * This file exists because a sabotage found it missing: flipping the fallback
 * from "joining" to "live" broke nothing, since `channelState` had no test at
 * all.
 */
describe("channelState", () => {
  it("is live only on SUBSCRIBED", () => {
    expect(channelState("SUBSCRIBED")).toBe("live");
  });

  it("reports the three ways a join fails", () => {
    // supabase-js distinguishes them; the screens do not need to.
    expect(channelState("CHANNEL_ERROR")).toBe("error");
    expect(channelState("TIMED_OUT")).toBe("error");
    expect(channelState("CLOSED")).toBe("error");
  });

  it("treats anything it does not recognise as still joining, never as live", () => {
    // The load-bearing direction. Reading an unknown status as healthy is what
    // makes this defect come back: the screen would claim a live connection it
    // has no evidence for. "Joining" is honest and self-correcting — the next
    // callback replaces it.
    for (const unknown of ["", "JOINING", "SUBSCRIBING", "something-new"]) {
      expect(channelState(unknown), `${unknown} must not read as live`).toBe("joining");
    }
  });
});
