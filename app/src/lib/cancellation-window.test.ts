import { describe, expect, it } from "vitest";
import { withinCancellationWindow } from "./api";

/**
 * Review L19. This is timezone-sensitive and money-adjacent, takes `nowMs` as
 * an injectable parameter so it is trivially testable, and simply was not
 * tested.
 *
 * The 0008 guard trigger is authoritative and IS covered in smoke, which caps
 * the severity — but a disagreement at the boundary shows the client a Cancel
 * button that fails server-side, during the window that decides whether they
 * are charged. The two must agree, and only one of them was checked.
 *
 * Walk times are operator wall-clock (America/Chicago), NOT the device's. A
 * client cancelling from another timezone must be judged by the walk's clock.
 */

/** 10:00 on 2026-03-10, US Central (CDT, UTC-5) = 15:00Z. */
const START_UTC = Date.parse("2026-03-10T15:00:00Z");
const HOUR = 3600_000;

describe("withinCancellationWindow", () => {
  it("allows a cancellation comfortably before the cutoff", () => {
    expect(withinCancellationWindow("2026-03-10", "10:00", 12, START_UTC - 24 * HOUR)).toBe(true);
  });

  it("refuses one inside the cutoff", () => {
    expect(withinCancellationWindow("2026-03-10", "10:00", 12, START_UTC - 6 * HOUR)).toBe(false);
  });

  /**
   * The boundary is where a frontend/DB disagreement actually costs someone
   * money, so it is pinned exactly rather than approximately.
   */
  it("treats the cutoff instant itself as still allowed", () => {
    expect(withinCancellationWindow("2026-03-10", "10:00", 12, START_UTC - 12 * HOUR)).toBe(true);
    expect(withinCancellationWindow("2026-03-10", "10:00", 12, START_UTC - 12 * HOUR + 1)).toBe(false);
  });

  it("refuses after the walk has already started", () => {
    expect(withinCancellationWindow("2026-03-10", "10:00", 12, START_UTC + HOUR)).toBe(false);
  });

  /**
   * A cutoff of 0 means "until it starts", not "never" — an operator who wants
   * no cancellation policy should not accidentally get the strictest one.
   */
  it("with a zero cutoff, allows right up to the start", () => {
    expect(withinCancellationWindow("2026-03-10", "10:00", 0, START_UTC - 1)).toBe(true);
    expect(withinCancellationWindow("2026-03-10", "10:00", 0, START_UTC + 1)).toBe(false);
  });

  /**
   * The whole reason this reads business wall-clock rather than the device's:
   * the answer must not change with where the client is standing. Same instant,
   * same verdict, whatever the runtime's local zone would have made of
   * "10:00".
   */
  it("judges by the walk's clock, not the device's", () => {
    // 13 hours before a 10:00 Central start is outside a 12h cutoff...
    expect(withinCancellationWindow("2026-03-10", "10:00", 12, START_UTC - 13 * HOUR)).toBe(true);
    // ...and 11 hours before is inside it. If this function were reading the
    // device's zone, one of these two would flip for a client in Tokyo.
    expect(withinCancellationWindow("2026-03-10", "10:00", 12, START_UTC - 11 * HOUR)).toBe(false);
  });

  /** November: Central is CST (UTC-6), so the same wall-clock is a different instant. */
  it("follows the business zone across a DST change", () => {
    const novStart = Date.parse("2026-11-10T16:00:00Z"); // 10:00 CST
    expect(withinCancellationWindow("2026-11-10", "10:00", 12, novStart - 12 * HOUR)).toBe(true);
    expect(withinCancellationWindow("2026-11-10", "10:00", 12, novStart - 12 * HOUR + 1)).toBe(false);
  });
});
