/**
 * Money for humans, in edge functions.
 *
 * The frontend has `app/src/lib/format.ts`; nothing on the Deno side did, and
 * before review H12 nothing needed it — no edge function ever put an amount in
 * front of a person. `payment_taken` does, and an off-session charge announced
 * without its amount is barely an announcement.
 *
 * Integer minor units in, per the money invariant. The `*_pence` names are
 * historical and hold cents.
 */
export function formatMoney(minorUnits: number, currency = "USD"): string {
  // `Intl` rather than `(n/100).toFixed(2)` with a `$` glued on: the currency
  // is a column, so a project billing in anything else would silently print
  // dollars for euros. Deno ships full ICU.
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(minorUnits / 100);
}
