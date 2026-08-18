import { useRef, useState, type TouchEvent } from "react";
import { PaymentStatus } from "./PaymentStatus";
import { paymentPetNames, type PaymentDetailed } from "@/lib/api";
import { dateLocal, money } from "@/lib/format";
import { reversalNote } from "@/lib/reversal";

function paymentTypeLabel(type: PaymentDetailed["type"]): string {
  return type === "overage" ? "Walk overage" : "Subscription";
}

export function PaymentRow({
  payment,
  showClient = false,
}: {
  payment: PaymentDetailed;
  showClient?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const touchStart = useRef<number | null>(null);
  const pets = paymentPetNames(payment);
  const service = payment.walk?.service?.name ?? paymentTypeLabel(payment.type);
  const petLabel = pets.join(" & ") || paymentTypeLabel(payment.type);
  const clientLabel = payment.client?.full_name ?? "Client";
  const statusDate = payment.status === "pending"
    ? `Processing since ${dateLocal(payment.created_at)}`
    : dateLocal(payment.created_at);
  const reversal = reversalNote(payment);

  function onTouchStart(event: TouchEvent<HTMLDivElement>) {
    touchStart.current = event.touches[0]?.clientX ?? null;
  }

  function onTouchEnd(event: TouchEvent<HTMLDivElement>) {
    const start = touchStart.current;
    const end = event.changedTouches[0]?.clientX;
    touchStart.current = null;
    if (start == null || end == null || !payment.receipt_url) return;
    const delta = end - start;
    if (delta < -30) setRevealed(true);
    if (delta > 30) setRevealed(false);
  }

  return (
    <div
      className={`payment-row-shell${revealed ? " payment-row-shell--revealed" : ""}${payment.receipt_url ? " payment-row-shell--has-receipt" : ""}`}
      role="group"
      aria-label={`${petLabel}, ${service}, ${clientLabel}, ${money(payment.amount_pence)}`}
    >
      <div
        className="payment-row"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <div className="payment-row__main">
          <span className="payment-row__pet">{petLabel}</span>
          <span className="payment-row__service">{service}</span>
        </div>
        <div className="payment-row__client">
          {showClient && <span>{clientLabel}</span>}
          <time dateTime={payment.created_at}>{statusDate}</time>
        </div>
        <div className="payment-row__status"><PaymentStatus status={payment.status} /></div>
        <span className="payment-row__amount numeral">{money(payment.amount_pence)}</span>
      </div>
      {reversal && (
        <p className="payment-row__reversal">{reversal}</p>
      )}
      {payment.receipt_url && (
        <a
          className="payment-row__receipt"
          href={payment.receipt_url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Receipt for ${petLabel}, ${money(payment.amount_pence)}`}
        >
          Receipt
        </a>
      )}
    </div>
  );
}
