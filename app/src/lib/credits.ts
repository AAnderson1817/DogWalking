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
