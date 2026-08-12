import { paymentStatusTreatment } from "./status-treatment";
import type { PaymentStatus as PaymentStatusValue } from "@/lib/types";

const MARKS: Record<PaymentStatusValue, string> = {
  succeeded: "✓",
  pending: "…",
  failed: "!",
  refunded: "↩",
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
