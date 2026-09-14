import { describe, expect, it, vi } from "vitest";

/**
 * Gate 8d reads `weekendWalkCost` in `walk-cost.ts` and compares it with the
 * two SQL copies of the surcharge arithmetic — but Booking calls
 * `effectiveWalkCost` in `credits.ts`, and the only thing that makes the leaf
 * "what Booking quotes" is the one-line delegation between them. With the
 * formula re-inlined in `credits.ts` (the shape the file had before
 * `fix(walk-cost)`) the gate stays green while a fourth copy drifts untied,
 * which is the exact class the gate exists to catch, at the seam it cannot
 * see (review of PR 2). So the delegation is pinned: the leaf is mocked to a
 * sentinel and `effectiveWalkCost` must hand back that sentinel, with the
 * service's two figures and the date forwarded unchanged.
 *
 * Its own file because `vi.mock` is hoisted per module and `credits.test.ts`
 * needs the real arithmetic.
 */

const leaf = vi.hoisted(() => ({ weekendWalkCost: vi.fn(() => 4242) }));
vi.mock("./walk-cost", () => leaf);

const { effectiveWalkCost } = await import("./credits");

describe("effectiveWalkCost delegates to the leaf gate 8d reads", () => {
  it("returns the leaf's answer and forwards the service figures and the date", () => {
    expect(effectiveWalkCost({ credit_cost: 3, weekend_surcharge_credits: 2 }, "2026-07-04")).toBe(4242);
    expect(leaf.weekendWalkCost).toHaveBeenCalledWith(3, 2, "2026-07-04");
  });
});
