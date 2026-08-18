import { describe, expect, it } from "vitest";
import { reversalNote } from "./reversal";
import type { PaymentDetailed } from "./api";

function payment(over: Partial<PaymentDetailed> = {}): PaymentDetailed {
  return {
    id: "pay-1",
    operator_id: "op-1",
    client_id: "cli-1",
    walk_id: null,
    type: "subscription",
    amount_pence: 9000,
    currency: "USD",
    stripe_payment_intent_id: null,
    stripe_invoice_id: "in_1",
    status: "succeeded",
    receipt_url: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    refunded_amount_pence: 0,
    reversed_at: null,
    reversal_reason: null,
    credits_reversed: 0,
    credits_unrecovered: 0,
    reversal_needs_review: false,
    stripe_charge_id: null,
    client: null,
    walk: null,
    ...over,
  } as PaymentDetailed;
}

describe("reversalNote", () => {
  it("says nothing about a payment that was never reversed", () => {
    expect(reversalNote(payment())).toBeNull();
  });

  it("surfaces a partial refund, which the status alone cannot show", () => {
    // A half-refunded payment keeps status 'succeeded' — there is no partial
    // status — so without this line the operator sees a clean 'succeeded' row
    // for a charge that is half returned.
    const note = reversalNote(payment({
      refunded_amount_pence: 4500,
      reversed_at: "2026-08-02T00:00:00Z",
      credits_reversed: 1,
      credits_unrecovered: 4,
    }));
    expect(note).toContain("$45.00 of $90.00 returned");
  });

  it("names the credits that could NOT be reclaimed", () => {
    const note = reversalNote(payment({
      reversed_at: "2026-08-02T00:00:00Z",
      refunded_amount_pence: 9000,
      credits_reversed: 1,
      credits_unrecovered: 4,
    }));
    expect(note).toContain("1 credit reclaimed");
    expect(note).toContain("4 already spent and unrecoverable");
  });

  it("does not imply a clean recovery when nothing was reclaimable", () => {
    const note = reversalNote(payment({
      reversed_at: "2026-08-02T00:00:00Z",
      refunded_amount_pence: 9000,
      reversal_needs_review: true,
    })) ?? "";
    expect(note).toContain("check by hand");
    expect(note).not.toContain("reclaimed,");
  });

  it("pluralises a single credit correctly", () => {
    const note = reversalNote(payment({
      reversed_at: "2026-08-02T00:00:00Z",
      refunded_amount_pence: 9000,
      credits_reversed: 1,
    }));
    expect(note).toContain("1 credit reclaimed");
    const many = reversalNote(payment({
      reversed_at: "2026-08-02T00:00:00Z",
      refunded_amount_pence: 9000,
      credits_reversed: 3,
    }));
    expect(many).toContain("3 credits reclaimed");
  });

  it("reports an overage reversal without inventing credits", () => {
    // Overage buys no credits (invariant 3), so there is nothing to reclaim
    // and the line must not read as though zero were recovered from some.
    const note = reversalNote(payment({
      type: "overage",
      amount_pence: 2500,
      refunded_amount_pence: 2500,
      reversed_at: "2026-08-02T00:00:00Z",
      status: "disputed",
      reversal_reason: "dispute: fraudulent",
    }));
    expect(note).toBe("dispute: fraudulent");
  });
});
