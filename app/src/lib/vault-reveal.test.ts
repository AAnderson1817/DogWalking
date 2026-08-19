import { describe, expect, it } from "vitest";
import {
  MAX_EXTENSIONS,
  REVEAL_SECONDS,
  canExtend,
  extendReveal,
  shouldAnnounce,
  startReveal,
  tickReveal,
} from "./vault-reveal";

/**
 * Review M14. A revealed door code cleared after a fixed 30 s with no way to
 * extend, so a timeout forced the whole re-auth + purpose + reveal cycle
 * again — writing another `credential_access_log` row each time. The trail H3
 * built to make a real intrusion visible filled with repeated reads of the
 * same door minutes apart, which is the shape a real intrusion has.
 *
 * Both directions matter here. Too short is the reported defect; unbounded is
 * the timer removed with extra steps, on the one screen in the product that
 * shows somebody's door code.
 */
describe("vault reveal timer", () => {
  it("starts at the documented window with no extensions used", () => {
    expect(startReveal()).toEqual({ countdown: REVEAL_SECONDS, extensions: 0 });
  });

  it("counts down a second at a time", () => {
    expect(tickReveal({ countdown: 30, extensions: 0 })?.countdown).toBe(29);
    expect(tickReveal({ countdown: 2, extensions: 0 })?.countdown).toBe(1);
  });

  it("clears at the end rather than resting at zero", () => {
    // `null` is the signal to drop the secret. A timer that sat at 0 would
    // leave the code on screen with a spent countdown beside it.
    expect(tickReveal({ countdown: 1, extensions: 0 })).toBeNull();
  });

  it("extending restores the full window", () => {
    const t = extendReveal({ countdown: 3, extensions: 0 });
    expect(t.countdown).toBe(REVEAL_SECONDS);
    expect(t.extensions).toBe(1);
  });

  it("stops extending at the cap", () => {
    let t = startReveal();
    for (let i = 0; i < MAX_EXTENSIONS; i++) {
      expect(canExtend(t)).toBe(true);
      t = extendReveal(t);
    }
    expect(canExtend(t)).toBe(false);
  });

  it("refuses past the cap even if the caller does not check", () => {
    // Belt and braces: the control is hidden when `canExtend` is false, but a
    // second entry point must not be able to grant an unbounded reveal.
    const capped = { countdown: 5, extensions: MAX_EXTENSIONS };
    expect(extendReveal(capped)).toEqual(capped);
  });

  it("bounds total exposure to a stated number of seconds", () => {
    // The property that matters, stated as a number rather than left implicit:
    // a code cannot sit on an unattended screen for longer than this.
    expect(REVEAL_SECONDS * (MAX_EXTENSIONS + 1)).toBe(120);
  });

  it("announces at ten seconds and through the last five, not every tick", () => {
    // An assertive stream of numbers is unusable, and a polite region that
    // updates every second is only marginally better.
    expect(shouldAnnounce(30)).toBe(false);
    expect(shouldAnnounce(11)).toBe(false);
    expect(shouldAnnounce(10)).toBe(true);
    expect(shouldAnnounce(9)).toBe(false);
    expect(shouldAnnounce(6)).toBe(false);
    for (const n of [5, 4, 3, 2, 1]) expect(shouldAnnounce(n)).toBe(true);
  });
});
