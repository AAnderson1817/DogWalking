import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MoneyValueRail } from "./MoneyValueRail";
import type { Payments } from "@/lib/types";

/**
 * Review M3. "Needs attention" summed every failed row ever written, so an
 * invoice that failed once and was then paid sat in both columns forever: $90
 * Collected and $90 Needs attention for one settled invoice. The operator's
 * only options were to remember which failures were stale, or to chase a
 * client who had already paid.
 *
 * Migration 0034 sets `superseded_at` when a later succeeded payment settles
 * the same invoice or walk. The row keeps `status = 'failed'` — it did fail —
 * and stops counting as outstanding.
 */

function payment(over: Partial<Payments>): Payments {
  return {
    id: crypto.randomUUID(),
    operator_id: "op",
    client_id: "cl",
    walk_id: null,
    type: "subscription",
    amount_pence: 1000,
    currency: "USD",
    status: "succeeded",
    stripe_payment_intent_id: null,
    stripe_invoice_id: null,
    stripe_charge_id: null,
    receipt_url: null,
    superseded_at: null,
    refunded_amount_pence: 0,
    reversed_at: null,
    reversal_reason: null,
    credits_reversed: 0,
    credits_unrecovered: 0,
    reversal_needs_review: false,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    ...over,
  } as Payments;
}

const attention = () =>
  within(screen.getByText("Needs attention").closest("div")!).getByText(/\$/).textContent;

describe("MoneyValueRail", () => {
  it("counts an unsettled failure", () => {
    render(<MoneyValueRail payments={[payment({ status: "failed", amount_pence: 9000 })]} />);
    expect(attention()).toBe("$90.00");
  });

  it("does not count a failure a later payment settled", () => {
    render(
      <MoneyValueRail
        payments={[
          payment({ status: "failed", amount_pence: 9000, superseded_at: "2026-08-02T00:00:00Z" }),
          payment({ status: "succeeded", amount_pence: 9000 }),
        ]}
      />,
    );
    // The exact defect: $90 collected and $90 still "needing attention" for
    // one invoice that is fully paid.
    expect(attention()).toBe("$0.00");
    expect(
      within(screen.getByText("Collected").closest("div")!).getByText(/\$/).textContent,
    ).toBe("$90.00");
  });

  it("still counts a DIFFERENT failure that nothing settled", () => {
    // The other direction. A filter that hid every failure once any payment
    // succeeded would pass the test above and hide real unpaid invoices —
    // which is worse than the bug, because it is silent.
    render(
      <MoneyValueRail
        payments={[
          payment({ status: "failed", amount_pence: 9000, superseded_at: "2026-08-02T00:00:00Z" }),
          payment({ status: "failed", amount_pence: 4200 }),
          payment({ status: "succeeded", amount_pence: 9000 }),
        ]}
      />,
    );
    expect(attention()).toBe("$42.00");
  });

  it("leaves Collected and Processing unfiltered", () => {
    // Only the attention total is filtered. A superseded FAILURE never appears
    // in either of the others, so filtering them would filter nothing while
    // implying it did something.
    render(
      <MoneyValueRail
        payments={[
          payment({ status: "succeeded", amount_pence: 5000 }),
          payment({ status: "pending", amount_pence: 2500 }),
        ]}
      />,
    );
    expect(
      within(screen.getByText("Collected").closest("div")!).getByText(/\$/).textContent,
    ).toBe("$50.00");
    expect(
      within(screen.getByText("Processing").closest("div")!).getByText(/\$/).textContent,
    ).toBe("$25.00");
  });
});
