import { describe, expect, it } from "vitest";
import { bookingChargePence, parseVisitPriceInput } from "./visit-price";

describe("parseVisitPriceInput", () => {
  it("empty means no pay-per-visit, which is null, not zero", () => {
    expect(parseVisitPriceInput("")).toEqual({ ok: true, pence: null });
    expect(parseVisitPriceInput("   ")).toEqual({ ok: true, pence: null });
  });

  it("dollars become integer cents", () => {
    expect(parseVisitPriceInput("25")).toEqual({ ok: true, pence: 2500 });
    expect(parseVisitPriceInput("27.50")).toEqual({ ok: true, pence: 2750 });
    expect(parseVisitPriceInput("$25")).toEqual({ ok: true, pence: 2500 });
    // Float dollars must not produce fractional cents.
    expect(parseVisitPriceInput("19.99")).toEqual({ ok: true, pence: 1999 });
  });

  it("zero and negative are refused with words, not a constraint message", () => {
    for (const raw of ["0", "0.00", "-5"]) {
      const r = parseVisitPriceInput(raw);
      expect(r.ok, raw).toBe(false);
    }
  });

  it("garbage is refused", () => {
    const r = parseVisitPriceInput("twenty");
    expect(r.ok).toBe(false);
  });
});

describe("bookingChargePence", () => {
  it("the plan rate wins for a plan client", () => {
    expect(
      bookingChargePence({ overage_rate_pence: 2200 }, { visit_price_pence: 9900 }),
    ).toBe(2200);
  });

  it("a no-plan client is quoted the service's visit price", () => {
    expect(bookingChargePence(null, { visit_price_pence: 2500 })).toBe(2500);
  });

  it("no plan and no visit price has no figure to quote", () => {
    expect(bookingChargePence(null, { visit_price_pence: null })).toBeNull();
    expect(bookingChargePence(null, null)).toBeNull();
  });
});
