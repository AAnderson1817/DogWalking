// Client-side credit helpers (spec 06). The server (fn_walk_cost /
// fn_debit_walk) is authoritative; these mirror its arithmetic for display.
import type { CreditLedger, ServiceTypes } from "./types";

/** Effective cost: credit_cost + weekend surcharge when date is Sat/Sun. */
export function effectiveWalkCost(
  service: Pick<ServiceTypes, "credit_cost" | "weekend_surcharge_credits">,
  scheduledDate: string,
): number {
  const day = new Date(`${scheduledDate}T12:00:00Z`).getUTCDay(); // 0=Sun, 6=Sat
  const weekend = day === 0 || day === 6;
  return service.credit_cost + (weekend ? service.weekend_surcharge_credits : 0);
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
 */
export function committedCredits(
  walks: Array<{ status: string; credits_debited?: number | null; is_overage?: boolean | null }>,
  costOf: (walk: { status: string }) => number,
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
