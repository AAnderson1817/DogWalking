// Pay-per-visit pricing helpers (review H32), extracted pure so the rules are
// testable without mounting a screen — the same split geo.ts and credits.ts
// made for their screens' logic.

/** Parse the Settings "visit price" field: dollars typed by the operator.
 * Empty means "this service is not offered pay-per-visit" (NULL in the
 * schema), which is different from zero — a zero price is a misconfiguration
 * the schema refuses (0044), so it is refused here with words instead of a
 * check-constraint message. */
export function parseVisitPriceInput(
  raw: string,
): { ok: true; pence: number | null } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, pence: null };
  const dollars = Number(trimmed.replace(/^\$/, ""));
  if (!Number.isFinite(dollars)) {
    return { ok: false, reason: "Enter the visit price in dollars, like 25 or 27.50." };
  }
  const pence = Math.round(dollars * 100);
  if (pence <= 0) {
    return {
      ok: false,
      reason: "A visit price has to be more than zero — leave it empty to not offer pay-per-visit.",
    };
  }
  return { ok: true, pence };
}

/**
 * What a booking that cannot be credit-funded will be charged, mirroring the
 * charge path's resolution (overage.ts): the plan's overage rate when the
 * client is on a plan, else the service's visit price. Null means the charge
 * would be REFUSED at completion (operator config gap), so the disclosure has
 * no figure to show — the caller falls back to the no-figure wording.
 */
export function bookingChargePence(
  plan: { overage_rate_pence: number } | null,
  service: { visit_price_pence: number | null } | null,
): number | null {
  return plan?.overage_rate_pence ?? service?.visit_price_pence ?? null;
}
