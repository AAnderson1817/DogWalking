import { money } from "@/lib/format";
import type { Payments } from "@/lib/types";

/**
 * "Needs attention" excludes settled failures (review M3, migration 0034).
 *
 * A `failed` row keeps that status forever — it did fail, and rewriting the
 * status would be rewriting history — but once a later succeeded payment
 * settles the same invoice or walk, `superseded_at` is set and it stops being
 * something the operator has to act on. Without this the screen showed $90 in
 * Collected and $90 in Needs attention for one invoice that was fully paid,
 * and the operator's only options were to remember which failures were stale
 * or to chase a client who had already paid.
 */
function unresolved(payments: Payments[]): Payments[] {
  return payments.filter((payment) => payment.superseded_at == null);
}

export function MoneyValueRail({ payments }: { payments: Payments[] }) {
  const total = (status: Payments["status"]) => {
    // Only the attention total is filtered. Collected and Processing are
    // sums of what happened, and a superseded FAILURE never appears in
    // either — filtering them would be filtering nothing while implying
    // otherwise.
    const rows = status === "failed" ? unresolved(payments) : payments;
    return rows
      .filter((payment) => payment.status === status)
      .reduce((sum, payment) => sum + payment.amount_pence, 0);
  };

  return (
    <dl className="money-value-rail" aria-label="Payment totals">
      <div className="money-value money-value--collected">
        <dt>Collected</dt>
        <dd className="numeral">{money(total("succeeded"))}</dd>
      </div>
      <div className="money-value money-value--processing">
        <dt>Processing</dt>
        <dd className="numeral">{money(total("pending"))}</dd>
      </div>
      <div className="money-value money-value--attention">
        <dt>Needs attention</dt>
        <dd className="numeral">{money(total("failed"))}</dd>
      </div>
    </dl>
  );
}
