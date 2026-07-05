import { describe, expect, it } from "vitest";
import { effectiveWalkCost, formatLedgerEntry, isLowCredit } from "./credits";
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
  };
  it("signs amounts and labels entry types", () => {
    expect(formatLedgerEntry(base)).toMatchObject({ label: "Walk", amount: "−2", balanceAfter: 3 });
    expect(formatLedgerEntry({ ...base, entry_type: "grant", amount: 5 })).toMatchObject({
      label: "Cycle grant",
      amount: "+5",
    });
  });
});
