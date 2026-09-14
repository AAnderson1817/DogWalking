// Client-side credit helpers (spec 06). The server (fn_walk_cost /
// fn_debit_walk) is authoritative; these mirror its arithmetic for display.
//
// Two callers, two rules. Since 0043 a walk's credit cost is SNAPSHOTTED on
// the row at creation (`walks.cost_credits`) and the server charges that
// snapshot first — so the live arithmetic below is for exactly ONE thing: the
// walk a client is still composing on the Booking screen, which has no row
// yet and therefore no snapshot. A walk that already exists is priced from
// its own `cost_credits`, live arithmetic only when that is null (rows
// predating 0043), which is the coalesce `fn_walk_cost` performs. Booking's
// committed sum used to run the live formula over persisted walks while the
// snapshot sat unread in the same rows, and disagreed with the server on any
// walk whose service had been re-priced since it was booked.
import type { CreditLedger, ServiceTypes } from "./types";
import { weekendWalkCost } from "./walk-cost";

/**
 * Effective cost: credit_cost + weekend surcharge when date is Sat/Sun.
 *
 * For a walk that does not exist yet. The arithmetic lives in `walk-cost.ts`
 * so gate 8d can read it from deno and check it against the two SQL copies.
 */
export function effectiveWalkCost(
  service: Pick<ServiceTypes, "credit_cost" | "weekend_surcharge_credits">,
  scheduledDate: string,
): number {
  return weekendWalkCost(service.credit_cost, service.weekend_surcharge_credits, scheduledDate);
}

/** Spec 02: low credit when balance ≤ the operator's threshold. */
export function isLowCredit(balance: number, threshold: number): boolean {
  return balance <= threshold;
}

const ENTRY_LABELS: Record<CreditLedger["entry_type"], string> = {
  grant: "Cycle grant",
  debit: "Walk",
  adjust: "Adjustment",
  rollover: "Rollover",
  expiry: "Expired",
};

export interface LedgerLine {
  label: string;
  amount: string; // signed, e.g. "+5" / "−1"
  balanceAfter: number;
  note: string | null;
  createdAt: string;
}

export function formatLedgerEntry(entry: CreditLedger): LedgerLine {
  const sign = entry.amount > 0 ? "+" : "−";
  return {
    label: ENTRY_LABELS[entry.entry_type],
    amount: `${sign}${Math.abs(entry.amount)}`,
    balanceAfter: entry.balance_after,
    note: entry.note,
    createdAt: entry.created_at,
  };
}

/**
 * Credits already spoken for by walks that are booked but have not happened
 * yet (review H12).
 *
 * Billing happens at COMPLETION, from the balance at that moment — but the
 * booking screen compared a walk's cost against the balance at BOOKING time
 * and consulted nothing else. So a client holding two credits could book three
 * walks and see the overage confirmation on none of them: each is individually
 * affordable when booked, and the third completes as an off-session charge
 * they were never shown.
 *
 * A scheduled walk is a claim on the balance even though nothing has been
 * debited yet. Counting those claims is what makes the disclosure match what
 * will actually happen.
 *
 * Deliberately counts `scheduled` only. An `in_progress` walk has already been
 * debited or flagged overage by `fn_debit_walk`, so counting it again would
 * double-count and over-warn — and warning about a charge that will not happen
 * teaches people to dismiss the warning.
 *
 * Generic over the row so `costOf` sees the WHOLE walk it is pricing. The
 * callback used to be typed `(walk: { status: string })`, which is why Booking
 * cast its way to `service_type_id` and `scheduled_date` and never reached
 * `cost_credits` at all — the type hid the snapshot that was already in hand.
 */
export function committedCredits<W extends { status: string; is_overage?: boolean | null }>(
  walks: W[],
  costOf: (walk: W) => number,
): number {
  return walks
    .filter((w) => w.status === "scheduled" && !w.is_overage)
    .reduce((total, w) => total + costOf(w), 0);
}

/**
 * What is left to spend once already-booked walks are honoured. Floored at
 * zero: a negative figure would be arithmetic leaking into copy, and the
 * client's answer to "how many can I still book on credit" is none.
 */
export function availableCredits(balance: number, committed: number): number {
  return Math.max(0, balance - committed);
}
