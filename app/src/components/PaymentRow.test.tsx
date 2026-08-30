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
    const topup = renderToStaticMarkup(
      <PaymentRow payment={{ ...PAYMENT, walk: null, type: "topup" }} />,
    );
    expect(overage).toContain("Walk overage");
    expect(subscription).toContain("Subscription");
    // 0044: a top-up must not render as "Subscription", which is what the
    // old binary ternary did for every non-overage type.
    expect(topup).toContain("Credit top-up");
    expect(topup).not.toContain("Subscription");
  });
});

describe("PaymentStatus", () => {
  it("keeps a distinct mark and visible label for every state", () => {
    // Review M19: the marks are drawn now, not typed. Same contract as before
    // — a mark AND a visible label, never colour alone — but the mark is a
    // masked SVG on the approved 24x24 grid, because Nunito does not contain
    // U+2713 / U+21A9 / U+26A0 and a fallback font was drawing them.
    const states = ["succeeded", "pending", "failed", "refunded", "disputed"] as const;
    const marks = new Set<string>();
    for (const status of states) {
      const html = renderToStaticMarkup(<PaymentStatus status={status} />);
      expect(html).toContain("approved-icon");
      // The mask is an inlined data URI, so it is read by the master's own
      // <title> id rather than by unpicking the URI escaping — which is what
      // the first version of this tried, and it stopped at the first entity.
      const name = /sanpo-([a-z]+)-title/.exec(html)?.[1];
      expect(name, `${status} renders no approved mask`).toBeTruthy();
      marks.add(name!);
    }
    // Distinct: two states sharing a mark is the same defect as no mark.
    expect(marks.size).toBe(states.length);

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
