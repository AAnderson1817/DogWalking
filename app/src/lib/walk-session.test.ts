import { describe, expect, it } from "vitest";
import {
  FALLBACK_DURATION_MINUTES,
  OVERRUN_CAP_MS,
  OVERRUN_GRACE_MS,
  walkSessionBound,
} from "./walk-session";

const START = Date.UTC(2026, 7, 18, 14, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const minutes = (n: number) => n * 60_000;

/**
 * Review M28. Every case here is about a BOUNDARY, not about the prompt
 * appearing: a rule that fires too eagerly takes the GPS away from an operator
 * who is still on the walk, which is a worse product than the bug it replaces.
 */
describe("walkSessionBound", () => {
  const base = { durationMinutes: 30, now: START, snoozedAt: null };

  it("has no bound before the walk starts", () => {
    expect(walkSessionBound({ ...base, startedAt: null })).toBeNull();
  });

  it("ignores an unparseable started_at rather than prompting immediately", () => {
    // `new Date("nonsense").getTime()` is NaN, and every comparison against
    // NaN is false — so a naive implementation reads as "not prompting" by
    // accident. Returning null says so on purpose.
    expect(walkSessionBound({ ...base, startedAt: "not a date" })).toBeNull();
  });

  it("does not prompt inside the booked duration", () => {
    const b = walkSessionBound({
      ...base,
      startedAt: iso(START),
      now: START + minutes(29),
    });
    expect(b?.prompting).toBe(false);
    expect(b?.capped).toBe(false);
  });

  it("does not prompt inside the grace period after the booked duration", () => {
    // The single most important case: 30 minutes booked, 55 elapsed. Dogs are
    // slow, doors stick, and a walk running over is not a fault.
    const b = walkSessionBound({
      ...base,
      startedAt: iso(START),
      now: START + minutes(55),
    });
    expect(b?.prompting).toBe(false);
  });

  it("prompts exactly at duration + grace", () => {
    const at = START + minutes(30) + OVERRUN_GRACE_MS;
    expect(walkSessionBound({ ...base, startedAt: iso(START), now: at - 1 })?.prompting).toBe(false);
    expect(walkSessionBound({ ...base, startedAt: iso(START), now: at })?.prompting).toBe(true);
  });

  it("keeps recording while the prompt is up", () => {
    const b = walkSessionBound({
      ...base,
      startedAt: iso(START),
      now: START + minutes(30) + OVERRUN_GRACE_MS + minutes(5),
    });
    expect(b?.prompting).toBe(true);
    // The whole point of stage one. Stopping GPS the moment the prompt appears
    // would punish the operator who is still walking and simply hasn't looked
    // at their phone in the last five minutes.
    expect(b?.capped).toBe(false);
  });

  it("caps recording once the prompt has gone unanswered", () => {
    const at = START + minutes(30) + OVERRUN_GRACE_MS + OVERRUN_CAP_MS;
    expect(walkSessionBound({ ...base, startedAt: iso(START), now: at - 1 })?.capped).toBe(false);
    expect(walkSessionBound({ ...base, startedAt: iso(START), now: at })?.capped).toBe(true);
  });

  it("scales with the booked duration rather than using one fixed ceiling", () => {
    const long = walkSessionBound({
      ...base,
      durationMinutes: 120,
      startedAt: iso(START),
      now: START + minutes(90),
    });
    expect(long?.prompting).toBe(false);
  });

  it("falls back to a known duration when the walk's own is unavailable", () => {
    // The offline resume path restores from a local snapshot and cannot read
    // `service_types` at all.
    const b = walkSessionBound({
      ...base,
      durationMinutes: null,
      startedAt: iso(START),
      now: START + minutes(FALLBACK_DURATION_MINUTES) + OVERRUN_GRACE_MS,
    });
    expect(b?.prompting).toBe(true);
    expect(
      walkSessionBound({
        ...base,
        durationMinutes: null,
        startedAt: iso(START),
        now: START + minutes(FALLBACK_DURATION_MINUTES) + OVERRUN_GRACE_MS - 1,
      })?.prompting,
    ).toBe(false);
  });

  it("treats a nonsensical duration as unknown, not as zero", () => {
    // A zero or negative duration would put the bound in the past and prompt
    // on the first tick of every walk.
    for (const durationMinutes of [0, -30]) {
      const b = walkSessionBound({
        ...base,
        durationMinutes,
        startedAt: iso(START),
        now: START + minutes(1),
      });
      expect(b?.prompting).toBe(false);
    }
  });

  it("restarts the clock from the answer, not from the start of the walk", () => {
    // The button has to actually do something. Measuring the snooze from
    // `started_at` would leave a walk that is already past its bound prompting
    // again on the very next tick — an unanswerable dialog on a screen the
    // operator needs.
    const answeredAt = START + minutes(30) + OVERRUN_GRACE_MS + minutes(2);
    const b = walkSessionBound({
      ...base,
      startedAt: iso(START),
      snoozedAt: answeredAt,
      now: answeredAt + 1_000,
    });
    expect(b?.prompting).toBe(false);
    expect(b?.promptAt).toBe(answeredAt + OVERRUN_GRACE_MS);
  });

  it("prompts again once the snooze runs out", () => {
    const answeredAt = START + minutes(30) + OVERRUN_GRACE_MS;
    const b = walkSessionBound({
      ...base,
      startedAt: iso(START),
      snoozedAt: answeredAt,
      now: answeredAt + OVERRUN_GRACE_MS,
    });
    expect(b?.prompting).toBe(true);
    expect(b?.capped).toBe(false);
  });

  it("caps a snoozed walk too, so one tap is not a permanent exemption", () => {
    const answeredAt = START + minutes(30) + OVERRUN_GRACE_MS;
    const b = walkSessionBound({
      ...base,
      startedAt: iso(START),
      snoozedAt: answeredAt,
      now: answeredAt + OVERRUN_GRACE_MS + OVERRUN_CAP_MS,
    });
    expect(b?.capped).toBe(true);
  });
});
