// The plan form's readiness rule, pure and shared with its submit path.
//
// The server (create-plan) refuses an overage rate that is not a positive
// whole number of cents — 0026's `plans_overage_rate_positive`: a walk
// credits cannot cover is charged in full at that rate, and a rate of zero is
// a free walk, not a price. The button used to enable on ANY non-empty text,
// so "0" reached the server, minted a Stripe Price and then failed on the
// CHECK with no rule named (PR C of the spec-drift audit). The cents the
// gate reasons about are the cents the submit sends: both go through
// `centsFrom`, so the two cannot disagree about what "0.004" rounds to.

/** Whole cents from a dollars string, or null when it is not a finite number. */
export function centsFrom(dollars: string): number | null {
  const trimmed = dollars.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export interface PlanDraft {
  name: string;
  price: string;
  overage: string;
}

/** True only for a draft the server will accept: a name, a price of zero
 * or more cents, and an overage rate of at least one cent. */
export function planFormReady(draft: PlanDraft): boolean {
  const price = centsFrom(draft.price);
  const overage = centsFrom(draft.overage);
  return draft.name.trim() !== "" && price !== null && price >= 0 && overage !== null && overage > 0;
}
