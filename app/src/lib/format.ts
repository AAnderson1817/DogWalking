// Display formatting (spec 06). Money is integer cents (USD); all display
// times are US Central (America/Chicago — Intl handles CST/CDT) regardless
// of the device timezone (UTC in the DB).

const DISPLAY_TZ = "America/Chicago";

/** 12345 → "$123.45" (integer cents; *_pence columns hold cents since the USD switch) */
export function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars.toLocaleString("en-US")}.${rem}`;
}

/** "2026-07-05T11:30:00Z" → "Jul 5, 2026" (Central calendar date). */
export function dateLocal(ts: string | Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: DISPLAY_TZ,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(typeof ts === "string" ? new Date(ts) : ts);
}

/** "2026-07-05T16:30:00Z" → "11:30 AM" (Central wall clock, 12h). */
export function timeLocal(ts: string | Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: DISPLAY_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(typeof ts === "string" ? new Date(ts) : ts)
    .replace(/\u202f/g, " "); // ICU 72+ emits a narrow no-break space before AM/PM
}

/**
 * UTC epoch ms for a wall-clock date+time interpreted in the business
 * timezone (America/Chicago), independent of the device timezone. Used for
 * cutoff math so a traveling client isn't gated by their local clock.
 */
export function businessWallClockToMs(dateStr: string, timeStr: string): number {
  const dp = dateStr.split("-").map(Number);
  const tp = timeStr.split(":").map(Number);
  const y = dp[0] ?? 1970, mo = dp[1] ?? 1, d = dp[2] ?? 1;
  const h = tp[0] ?? 0, mi = tp[1] ?? 0, s = tp[2] ?? 0;
  const guessUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  // Correct the guess by the zone's offset at that instant.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DISPLAY_TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(guessUtc));
  const p: Record<string, number> = {};
  for (const part of parts) if (part.type !== "literal") p[part.type] = Number(part.value);
  const hour = (p.hour ?? 0) === 24 ? 0 : (p.hour ?? 0); // Intl can emit "24" at midnight
  const asIfUtc = Date.UTC(p.year ?? y, (p.month ?? mo) - 1, p.day ?? d, hour, p.minute ?? mi, p.second ?? s);
  return guessUtc - (asIfUtc - guessUtc);
}

/** Wall-clock walk-window time "13:00:00" → "1:00 PM" (stored as plain time). */
export function time12(t: string): string {
  const [hStr = "0", m = "00"] = t.split(":");
  const h = Number(hStr);
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m} ${suffix}`;
}

/**
 * Walk slot label: scheduled date + window (wall-clock times).
 * ("2026-07-06", "12:00:00", "13:00:00") → "Mon, Jul 6, 12:00 PM–1:00 PM"
 */
export function walkTime(date: string, windowStart: string, windowEnd: string): string {
  const day = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
  return `${day}, ${time12(windowStart)}–${time12(windowEnd)}`;
}

/** 2140 → "2.1 km"; 640 → "0.6 km"; null-safe for unset distances. */
export function distanceKm(m: number | null | undefined): string {
  if (m == null) return "—";
  return `${(m / 1000).toFixed(1)} km`;
}

/** Elapsed mm:ss (or h:mm:ss past the hour) since an ISO start time. */
export function elapsed(startIso: string, nowMs: number = Date.now()): string {
  const total = Math.max(0, Math.floor((nowMs - new Date(startIso).getTime()) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
