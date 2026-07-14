// Credit balance meter (spec 05): display-font numeral, bar fill, amber
// under the operator's low-credit threshold.
import { isLowCredit } from "@/lib/credits";

export function CreditMeter({
  balance,
  threshold,
  cycleCredits,
  label = "Credits",
}: {
  balance: number;
  threshold: number;
  /** Full-cycle grant used as the bar's 100% reference. */
  cycleCredits?: number;
  label?: string;
}) {
  const low = isLowCredit(balance, threshold);
  const reference = Math.max(cycleCredits ?? Math.max(balance, threshold * 2), 1);
  const pct = Math.max(0, Math.min(100, (balance / reference) * 100));
  return (
    <div className={`credit-meter${low ? " credit-meter--low" : ""}`}>
      <div className="credit-meter__row">
        <span className="section-label">{label}</span>
        <span className="credit-meter__value" aria-label={`${balance} credits`}>
          {balance}
        </span>
      </div>
      <div className="credit-meter__track" role="meter" aria-valuenow={balance} aria-valuemin={0}>
        <div className="credit-meter__fill" style={{ width: `${pct}%` }} />
      </div>
      {low && (
        <span style={{ fontSize: "var(--fs-12)", color: "var(--orange-deep)", fontWeight: 800 }}>
          Low balance — {balance} left
        </span>
      )}
    </div>
  );
}
