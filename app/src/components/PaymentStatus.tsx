import { ApprovedIcon } from "./ApprovedIcon";
import type { ApprovedIconName } from "./approved-icons";
import { paymentStatusTreatment } from "./status-treatment";
import type { PaymentStatus as PaymentStatusValue } from "@/lib/types";

/**
 * Review M19. These marks were text glyphs — `✓ … ! ↩ ⚠` — and Nunito does
 * not contain three of them. Confirmed in Chromium through
 * `CSS.getPlatformFontsForNode`: U+2713, U+21A9 and U+26A0 render in DejaVu
 * Sans, the system fallback, so the two most important marks on the money
 * surface were drawn by whatever font the device happened to have, with
 * synthesised weight, and looked different on every platform.
 *
 * Drawn on the approved 24x24 / 1.75px grid and routed through
 * `ApprovedIcon`, so they inherit `currentColor` and the hash guard like
 * every other icon.
 */
const MARKS: Record<PaymentStatusValue, ApprovedIconName> = {
  succeeded: "check",
  pending: "pending",
  failed: "alert",
  // Distinct from the dispute triangle: a refund is money the operator
  // returned; a dispute is money the cardholder's bank took back.
  refunded: "returned",
  disputed: "disputed",
};

export function PaymentStatus({ status }: { status: PaymentStatusValue }) {
  const treatment = paymentStatusTreatment(status);
  return (
    <span className={`payment-status payment-status--${status}`}>
      {/* The bordered box is gone with the glyph. It existed to give a
          text mark a consistent footprint across fonts that drew it at
          wildly different widths — a workaround for the defect above, not a
          design element (review M19). */}
      <ApprovedIcon name={MARKS[status]} size={18} className="payment-status__mark" />
      <span>{treatment.label}</span>
    </span>
  );
}
