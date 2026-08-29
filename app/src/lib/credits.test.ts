import { describe, expect, it } from "vitest";
import {
  availableCredits,
  committedCredits,
  effectiveWalkCost,
  formatLedgerEntry,
  isLowCredit,
} from "./credits";
import type { CreditLedger } from "./types";

const service30 = { credit_cost: 1, weekend_surcharge_credits: 1 };

describe("effectiveWalkCost", () => {
  it("charges base cost on weekdays", () => {
    expect(effectiveWalkCost(service30, "2026-07-01")).toBe(1); // Wednesday
  });
  it("adds the weekend surcharge on Sat/Sun", () => {
    expect(effectiveWalkCost(service30, "2026-07-04")).toBe(2); // Saturday
    expect(effectiveWalkCost(service30, "2026-07-05")).toBe(2); // Sunday
  });
});

describe("isLowCredit", () => {
  it("is low at or below the threshold (spec 02: ≤)", () => {
    expect(isLowCredit(2, 2)).toBe(true);
    expect(isLowCredit(0, 2)).toBe(true);
    expect(isLowCredit(3, 2)).toBe(false);
  });
});

describe("formatLedgerEntry", () => {
  const base: CreditLedger = {
    id: "x",
    seq: 1,
    operator_id: "op",
    client_id: "c",
    entry_type: "debit",
    amount: -2,
    balance_after: 3,
    walk_id: null,
    expires_at: null,
    note: "walk debit",
    created_at: "2026-07-01T12:00:00Z",
    stripe_invoice_id: null,
  };
  it("signs amounts and labels entry types", () => {
    expect(formatLedgerEntry(base)).toMatchObject({ label: "Walk", amount: "−2", balanceAfter: 3 });
    expect(formatLedgerEntry({ ...base, entry_type: "grant", amount: 5 })).toMatchObject({
      label: "Cycle grant",
      amount: "+5",
    });
  });
});

// ── H12: credits already spoken for ────────────────────────────────────────
//
// Booking compared a walk's cost against the RAW balance, so a client holding
// two credits could book three walks and see the overage confirmation on NONE
// of them — each is individually affordable at the moment it is booked, and
// billing happens at completion. The third fired an off-session charge they
// had never been shown.

describe("committedCredits", () => {
  const oneCredit = () => 1;

  it("counts scheduled walks as a claim on the balance", () => {
    const walks = [{ status: "scheduled" }, { status: "scheduled" }];
    expect(committedCredits(walks, oneCredit)).toBe(2);
  });

  /**
   * The review's own scenario, end to end: two credits, three walks. The third
   * must be disclosed as an overage at booking time.
   */
  it("makes the third walk on two credits show as an overage", () => {
    const balance = 2;
    const alreadyBooked = [{ status: "scheduled" }, { status: "scheduled" }];
    const available = availableCredits(balance, committedCredits(alreadyBooked, oneCredit));
    expect(available).toBe(0);
    expect(1 > available).toBe(true); // a 1-credit walk is now an overage
  });

  /**
   * An in_progress walk has already been debited or flagged by fn_debit_walk.
   * Counting it again would over-warn, and a warning about a charge that will
   * not happen teaches people to dismiss the warning.
   */
  it("does not double-count a walk that has already been debited", () => {
    const walks = [{ status: "in_progress" }, { status: "completed" }, { status: "cancelled" }];
    expect(committedCredits(walks, oneCredit)).toBe(0);
  });

  /** A walk already flagged as overage is not a claim on credits. */
  it("ignores a scheduled walk already marked overage", () => {
    const walks = [{ status: "scheduled", is_overage: true }, { status: "scheduled" }];
    expect(committedCredits(walks, oneCredit)).toBe(2 - 1);
  });

  it("uses the per-walk cost rather than assuming one credit each", () => {
    const walks = [{ status: "scheduled" }, { status: "scheduled" }];
    expect(committedCredits(walks, () => 3)).toBe(6);
  });
});

describe("availableCredits", () => {
  it("subtracts what is already booked", () => {
    expect(availableCredits(5, 2)).toBe(3);
  });

  /**
   * Floored at zero. A negative figure is arithmetic leaking into copy, and
   * the client's answer to "how many can I still book on credit" is none.
   */
  it("never reports a negative balance", () => {
    expect(availableCredits(1, 4)).toBe(0);
  });
});
