// The credit proration's only input, extracted so it can be tested at all
// (review M35).
//
// This lived inline in `index.ts`, which has no handler seam, so the Deno
// suite could not reach it. What it computed when Stripe's shape changed:
//
//   const start = itemAny.current_period_start ?? subAny.current_period_start ?? 0;
//   const end   = itemAny.current_period_end   ?? subAny.current_period_end   ?? 0;
//   fraction = end > start ? clamp(…) : 0;
//
// Both fall through to 0, `end > start` is false, and the function returns
// **fraction 0** — the client is prorated to zero credits and the call answers
// 200 with no error anywhere. Stripe has already moved this field once, which
// is exactly why both shapes are read; the next move would have been silent.
//
// A zero fraction is legitimate when the period has genuinely elapsed, so the
// fix is not "reject zero". It is to distinguish a COMPUTED zero from an
// ABSENT period, which the `?? 0` made indistinguishable.

export interface PeriodBounds {
  current_period_start?: number | null;
  current_period_end?: number | null;
}

export type PeriodResult =
  /** `periodEnd` is the same epoch-seconds value the fraction was computed
   *  from. Returned rather than re-read at the call site: caching a
   *  `current_period_end` that disagrees with the proration it was derived
   *  from would print a confident renewal date for a different period. */
  | { ok: true; fraction: number; periodEnd: number }
  | { ok: false; reason: "period_missing" | "period_degenerate" };

/**
 * Remaining fraction of the current billing period, in [0, 1].
 *
 * Newer Stripe API versions carry the period on the subscription ITEM; older
 * ones on the subscription. Both are read, item first, and a missing period is
 * an error rather than a zero.
 */
export function remainingFraction(
  item: PeriodBounds | null | undefined,
  sub: PeriodBounds | null | undefined,
  nowSeconds: number,
): PeriodResult {
  const start = item?.current_period_start ?? sub?.current_period_start ?? null;
  const end = item?.current_period_end ?? sub?.current_period_end ?? null;

  // Neither shape carried it. This is the case that used to return 0.
  if (start == null || end == null) return { ok: false, reason: "period_missing" };

  // Present but nonsensical — a zero-length or inverted period. Distinct from
  // missing because it means something different: Stripe gave us a period and
  // it is unusable, rather than Stripe not giving us one.
  if (!(end > start)) return { ok: false, reason: "period_degenerate" };

  // Clamped, so a period that has already elapsed yields a legitimate 0 and a
  // clock skew ahead of `start` yields a legitimate 1.
  const raw = (end - nowSeconds) / (end - start);
  return { ok: true, fraction: Math.min(1, Math.max(0, raw)), periodEnd: end };
}
