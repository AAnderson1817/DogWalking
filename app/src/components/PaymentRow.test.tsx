import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MoneyValueRail } from "./MoneyValueRail";
import { PaymentRow } from "./PaymentRow";
import { PaymentStatus } from "./PaymentStatus";
import type { PaymentDetailed } from "@/lib/api";
import type { Payments } from "@/lib/types";

const PAYMENT: PaymentDetailed = {
  id: "payment-1",
  operator_id: "operator-1",
  client_id: "client-1",
  walk_id: "walk-1",
  type: "overage",
  amount_pence: 4250,
  currency: "usd",
  stripe_payment_intent_id: null,
  stripe_invoice_id: null,
  superseded_at: null,
  status: "succeeded",
  receipt_url: "https://example.com/receipt",
  created_at: "2026-07-15T14:00:00Z",
  updated_at: "2026-07-15T14:00:00Z",
  refunded_amount_pence: 0,
  reversed_at: null,
  reversal_reason: null,
  credits_reversed: 0,
  credits_unrecovered: 0,
  reversal_needs_review: false,
  stripe_charge_id: null,
  client: { full_name: "Amelia Hart" },
  walk: {
    service: { name: "Private walk 60" },
    walk_pets: [{ pets: { name: "Biscuit" } }],
  },
};

describe("PaymentRow", () => {
  it("shows payment context in logical reading order with an accessible receipt", () => {
    const html = renderToStaticMarkup(<PaymentRow payment={PAYMENT} showClient />);
    expect(html.indexOf("Biscuit")).toBeLessThan(html.indexOf("Private walk 60"));
    expect(html.indexOf("Private walk 60")).toBeLessThan(html.indexOf("Amelia Hart"));
    expect(html).toContain("Collected");
    expect(html).toContain("$42.50");
    expect(html).toContain('aria-label="Receipt for Biscuit, $42.50"');
    expect(html).not.toContain(">overage<");
  });

  it("uses readable payment type labels", () => {
    const overage = renderToStaticMarkup(
      <PaymentRow payment={{ ...PAYMENT, walk: null, type: "overage" }} />,
    );
    const subscription = renderToStaticMarkup(
      <PaymentRow payment={{ ...PAYMENT, walk: null, type: "subscription" }} />,
    );
    expect(overage).toContain("Walk overage");
    expect(subscription).toContain("Subscription");
  });
});

describe("PaymentStatus", () => {
  it("keeps a distinct mark and visible label for every state", () => {
    expect(renderToStaticMarkup(<PaymentStatus status="succeeded" />)).toContain("✓");
    expect(renderToStaticMarkup(<PaymentStatus status="pending" />)).toContain("Processing");
    expect(renderToStaticMarkup(<PaymentStatus status="failed" />)).toContain("Needs attention");
    expect(renderToStaticMarkup(<PaymentStatus status="refunded" />)).toContain("Refunded");
  });
});

describe("MoneyValueRail", () => {
  it("totals the three operational money states", () => {
    const payments = [
      PAYMENT,
      { ...PAYMENT, id: "payment-2", status: "pending", amount_pence: 1200 },
      { ...PAYMENT, id: "payment-3", status: "failed", amount_pence: 800 },
    ] satisfies Payments[];
    const html = renderToStaticMarkup(<MoneyValueRail payments={payments} />);
    expect(html).toContain("$42.50");
    expect(html).toContain("$12.00");
    expect(html).toContain("$8.00");
  });
});
