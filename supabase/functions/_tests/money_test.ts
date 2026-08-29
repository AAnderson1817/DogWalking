// The first money-in-front-of-a-person formatter on the Deno side (review
// H12). `payment_taken` announces an off-session charge, and an announcement
// without its amount is barely one.
import { assertEquals } from "./asserts.ts";
import { formatMoney } from "../_lib/money.ts";

Deno.test("formatMoney renders integer minor units as currency", () => {
  assertEquals(formatMoney(2200), "$22.00");
  assertEquals(formatMoney(0), "$0.00");
  assertEquals(formatMoney(5), "$0.05");
  assertEquals(formatMoney(123456), "$1,234.56");
});

/**
 * The currency is a column, so a `$` glued to a number would print dollars for
 * euros the first time anyone bills in one.
 */
Deno.test("formatMoney honours the currency it is given", () => {
  assertEquals(formatMoney(2200, "EUR"), "€22.00");
  assertEquals(formatMoney(2200, "usd"), "$22.00");
});

/** Rounding is the currency's, not ours — no half-cent artefacts. */
Deno.test("formatMoney does not invent precision", () => {
  assertEquals(formatMoney(1), "$0.01");
  assertEquals(formatMoney(999), "$9.99");
});
