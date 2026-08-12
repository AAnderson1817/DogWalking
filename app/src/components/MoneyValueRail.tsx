import { money } from "@/lib/format";
import type { Payments } from "@/lib/types";

export function MoneyValueRail({ payments }: { payments: Payments[] }) {
  const total = (status: Payments["status"]) => payments
    .filter((payment) => payment.status === status)
    .reduce((sum, payment) => sum + payment.amount_pence, 0);

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
