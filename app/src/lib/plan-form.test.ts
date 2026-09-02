import { describe, expect, it } from "vitest";
import { centsFrom, planFormReady } from "./plan-form";

const draft = (over: Partial<{ name: string; price: string; overage: string }> = {}) => ({
  name: "Weekly walks",
  price: "40",
  overage: "12.50",
  ...over,
});

describe("centsFrom", () => {
  it("rounds dollars to whole cents", () => {
    expect(centsFrom("12.50")).toBe(1250);
    expect(centsFrom(" 0.5 ")).toBe(50);
    expect(centsFrom("0.004")).toBe(0);
  });
  it("is null for anything that is not a number", () => {
    expect(centsFrom("")).toBeNull();
    expect(centsFrom("abc")).toBeNull();
    expect(centsFrom("1e999")).toBeNull();
  });
});

describe("planFormReady", () => {
  it("is ready for a named plan with a price and a positive overage rate", () => {
    expect(planFormReady(draft())).toBe(true);
    expect(planFormReady(draft({ price: "0" }))).toBe(true); // a free plan is legal
    expect(planFormReady(draft({ overage: "0.01" }))).toBe(true);
  });
  it("refuses an overage rate of zero — the rule the server enforces", () => {
    expect(planFormReady(draft({ overage: "0" }))).toBe(false);
    expect(planFormReady(draft({ overage: "0.00" }))).toBe(false);
    // Rounds to zero cents, which is what the submit would send.
    expect(planFormReady(draft({ overage: "0.004" }))).toBe(false);
    expect(planFormReady(draft({ overage: "-1" }))).toBe(false);
  });
  it("refuses a blank name, a blank or negative price, and unparseable text", () => {
    expect(planFormReady(draft({ name: "  " }))).toBe(false);
    expect(planFormReady(draft({ price: "" }))).toBe(false);
    expect(planFormReady(draft({ price: "-5" }))).toBe(false);
    expect(planFormReady(draft({ overage: "" }))).toBe(false);
    expect(planFormReady(draft({ overage: "two" }))).toBe(false);
  });
});
