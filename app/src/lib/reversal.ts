import { money } from "./format";
import type { PaymentDetailed } from "./api";

/**
 * What a reversal actually cost, in one line (review B4).
 *
 * The badge alone says "Refunded" and stops there, which is the least
 * interesting part. What the operator needs is the money: a partial refund
 * against a payment still reading 'succeeded', credits that could not be
 * reclaimed because the client had already spent them, and rows the system
 * refused to reconcile on its own. Each of those is money they are out, and
 * none of them is visible from the status.
 *
 * Lives in lib rather than beside the component so it is unit-testable on
 * its own: the shortfall wording is the part that must not regress into
 * implying a clean recovery.
 */
export function reversalNote(payment: PaymentDetailed): string | null {
  const refunded = payment.refunded_amount_pence ?? 0;
  if (!payment.reversed_at && refunded === 0) return null;

  const parts: string[] = [];
  // Partial refunds keep status 'succeeded' — there is no partial status and
  // claiming the stronger one would overstate it — so the amount is the only
  // place the partial case shows up at all.
  if (refunded > 0 && refunded < payment.amount_pence) {
    parts.push(`${money(refunded)} of ${money(payment.amount_pence)} returned`);
  }
  if (payment.reversal_needs_review) {
    parts.push("credits not reclaimed automatically — check by hand");
  } else if ((payment.credits_unrecovered ?? 0) > 0) {
    parts.push(
      `${payment.credits_reversed} credit${payment.credits_reversed === 1 ? "" : "s"} reclaimed, `
      + `${payment.credits_unrecovered} already spent and unrecoverable`,
    );
  } else if ((payment.credits_reversed ?? 0) > 0) {
    parts.push(
      `${payment.credits_reversed} credit${payment.credits_reversed === 1 ? "" : "s"} reclaimed`,
    );
  }
  if (payment.reversal_reason) parts.push(payment.reversal_reason);
  return parts.length ? parts.join(" · ") : null;
}
