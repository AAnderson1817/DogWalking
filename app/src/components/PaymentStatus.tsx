import { paymentStatusTreatment } from "./status-treatment";
import type { PaymentStatus as PaymentStatusValue } from "@/lib/types";

const MARKS: Record<PaymentStatusValue, string> = {
  succeeded: "✓",
  pending: "…",
  failed: "!",
  refunded: "↩",
  // Distinct from the refund arrow: a dispute is money taken back by the
  // cardholder's bank, not returned by the operator.
  disputed: "⚠",
};

export function PaymentStatus({ status }: { status: PaymentStatusValue }) {
  const treatment = paymentStatusTreatment(status);
  return (
    <span className={`payment-status payment-status--${status}`}>
      <span className="payment-status__mark" aria-hidden>{MARKS[status]}</span>
      <span>{treatment.label}</span>
    </span>
  );
}
