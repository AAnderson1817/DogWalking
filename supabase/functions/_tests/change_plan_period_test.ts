import { assertEquals } from "./asserts.ts";
import { remainingFraction } from "../change-plan/period.ts";

/**
 * Review M35. `change-plan` had no handler seam, so this logic — the only
 * input to the credit proration — was unreachable from any test. What it did
 * when Stripe's shape changed was return **fraction 0**: the client prorated
 * to zero credits, 200 OK, nothing logged.
 *
 * Stripe has already moved `current_period_*` from the subscription to the
 * subscription item once. That is why both shapes are read, and it is why the
 * next move needed to be loud.
 */

const DAY = 86_400;
const START = 1_700_000_000;
const END = START + 30 * DAY;

Deno.test("reads the period from the subscription ITEM (newer Stripe shape)", () => {
  const r = remainingFraction(
    { current_period_start: START, current_period_end: END },
    null,
    START + 15 * DAY,
  );
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(Math.round(r.fraction * 100), 50);
});

Deno.test("falls back to the SUBSCRIPTION (older Stripe shape)", () => {
  const r = remainingFraction(
    {},
    { current_period_start: START, current_period_end: END },
    START + 15 * DAY,
  );
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(Math.round(r.fraction * 100), 50);
});

Deno.test("the item wins when both carry a period", () => {
  const r = remainingFraction(
    { current_period_start: START, current_period_end: START + 10 * DAY },
    { current_period_start: START, current_period_end: END },
    START,
  );
  assertEquals(r.ok, true);
  // Full period remaining either way; what this pins is WHICH period, via the
  // end it reports back for the cached renewal date.
  if (r.ok) assertEquals(r.periodEnd, START + 10 * DAY);
});

/**
 * THE case. Against the old `?? 0` this returned `fraction: 0` and the caller
 * happily prorated the client to nothing.
 */
Deno.test("a period on NEITHER shape is an error, not a zero", () => {
  const r = remainingFraction({}, {}, START);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "period_missing");
});

Deno.test("null and undefined bounds are missing, not zero", () => {
  for (const bounds of [
    { current_period_start: null, current_period_end: null },
    { current_period_start: START, current_period_end: null },
    { current_period_start: null, current_period_end: END },
  ]) {
    const r = remainingFraction(bounds, null, START);
    assertEquals(r.ok, false, `${JSON.stringify(bounds)} should be missing`);
  }
});

Deno.test("a zero-length or inverted period is degenerate, and says so", () => {
  assertEquals(
    remainingFraction({ current_period_start: END, current_period_end: END }, null, START),
    { ok: false, reason: "period_degenerate" },
  );
  assertEquals(
    remainingFraction({ current_period_start: END, current_period_end: START }, null, START),
    { ok: false, reason: "period_degenerate" },
  );
});

/**
 * A computed zero is legitimate and must stay allowed — the point is not
 * "reject zero", it is to tell a computed zero from an absent period. Getting
 * this wrong in the other direction would refuse every plan change made in the
 * last moments of a billing period.
 */
Deno.test("an elapsed period is a legitimate zero, not an error", () => {
  const r = remainingFraction(
    { current_period_start: START, current_period_end: END },
    null,
    END + DAY,
  );
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.fraction, 0);
});

Deno.test("the fraction is clamped to [0, 1] against clock skew", () => {
  const before = remainingFraction(
    { current_period_start: START, current_period_end: END },
    null,
    START - 10 * DAY,
  );
  assertEquals(before.ok, true);
  if (before.ok) assertEquals(before.fraction, 1);
});

Deno.test("periodEnd is the end the fraction was computed from", () => {
  const r = remainingFraction({ current_period_start: START, current_period_end: END }, null, START);
  assertEquals(r.ok, true);
  // Returned rather than re-read at the call site: a cached renewal date that
  // disagrees with the proration it came from prints a confident wrong date.
  if (r.ok) assertEquals(r.periodEnd, END);
});
