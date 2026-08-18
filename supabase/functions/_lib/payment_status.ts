/**
 * The status sets that a partial unique index on `payments` filters on.
 *
 * Both of these indexes are PARTIAL — `... where ... status in (...)` — so a
 * row only participates in its own uniqueness guarantee while its status is in
 * the set. Every code path that asks "has this already been paid / claimed?"
 * is therefore answering a question the index has already decided, and the two
 * have to agree exactly:
 *
 * - Too NARROW in code and the query returns nothing, the caller falls through
 *   to an insert, and the index raises — which surfaces to the operator as an
 *   unexplained internal error rather than "already charged".
 * - Too WIDE in code and the caller believes a row blocks it that the database
 *   would happily let it duplicate.
 *
 * They are constants here rather than array literals at the call sites so
 * `payment_status_test.ts` can compare them against the predicates actually
 * written in `supabase/migrations/`. Change one side and that test fails.
 */

/**
 * `uq_overage_payment_per_walk` — one live overage charge per walk.
 * 'failed' is excluded: a declined card must leave the walk re-chargeable.
 */
export const OVERAGE_CLAIM_STATUSES = [
  "succeeded",
  "pending",
  "refunded",
  "disputed",
] as const;

/**
 * `uq_payments_subscription_invoice` — one subscription payment per invoice.
 * 'pending' is absent because a subscription invoice is never claimed ahead of
 * the charge; 'failed' is absent because `invoice.payment_failed` writes a row
 * carrying the same invoice id that a later success must be able to sit beside.
 */
export const SUBSCRIPTION_INVOICE_STATUSES = [
  "succeeded",
  "refunded",
  "disputed",
] as const;
