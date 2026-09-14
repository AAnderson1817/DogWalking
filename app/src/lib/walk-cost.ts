// The weekend-surcharge arithmetic, on its own with ZERO imports — on purpose.
//
// This expression exists three times: here, in `fn_walk_cost`'s live fallback
// (0043) and in the `fn_snapshot_walk_price` trigger (0044). Gate 8d
// (`scripts/check-walk-cost-parity.sh`) asks all three the same questions from
// one case list, and the TypeScript half of that is a deno script
// (`scripts/walk-cost-answers.ts`) reading this file straight off the disk.
// Deno resolves imports by exact path, so `credits.ts` — with its
// extensionless `import type … from "./types"` — cannot be loaded that way;
// a leaf with no imports can. The `platform-price.test.ts` precedent, one
// runtime further along. Keep it a leaf: an import added here is what breaks
// the gate, and the gate is the only thing tying the three copies together.
//
// `T12:00:00Z` + `getUTCDay`: the calendar day of the DATE, whatever zone
// the device is in. The trap is a LOCAL read — `new Date(isoDate).getDay()`
// is UTC midnight read back in the device's zone, which is still Friday for
// a Saturday walk everywhere west of Greenwich, so a client in Chicago would
// be quoted the weekday price. `getUTCDay` reads the same day everywhere;
// the noon suffix keeps the instant clear of both edges of the day (the
// `format.ts` convention) and is immaterial under a UTC read. Postgres reads
// `isodow` off the DATE and has no such trap. Gate 8d pins this by running
// the TypeScript side under two zones either side of the day boundary — the
// cases in `scripts/walk-cost-cases.txt` cannot see a zone themselves.

/** Effective credit cost: `creditCost`, plus `surcharge` when `isoDate` (YYYY-MM-DD) is a Saturday or Sunday. */
export function weekendWalkCost(creditCost: number, surcharge: number, isoDate: string): number {
  const day = new Date(`${isoDate}T12:00:00Z`).getUTCDay(); // 0=Sun, 6=Sat
  const weekend = day === 0 || day === 6;
  return creditCost + (weekend ? surcharge : 0);
}
