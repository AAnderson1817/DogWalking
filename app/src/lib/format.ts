// Display formatting (spec 06). Money is integer cents (USD); all display times
// are Europe/London regardless of the device timezone (UTC in the DB).

const LONDON = "Europe/London";

/** 12345 → "$123.45" (integer cents; *_pence columns hold cents since the USD switch) */
export function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars.toLocaleString("en-US")}.${rem}`;
}

/** "2026-07-05T11:30:00Z" → "5 Jul 2026" (London calendar date). */
export function dateLondon(ts: string | Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: LONDON,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(typeof ts === "string" ? new Date(ts) : ts);
}

/** "2026-07-05T11:30:00Z" → "12:30" (London wall clock, 24h). */
export function timeLondon(ts: string | Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: LONDON,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(typeof ts === "string" ? new Date(ts) : ts);
}

/**
 * Walk slot label: scheduled date + window.
 * ("2026-07-06", "12:00:00", "13:00:00") → "Mon 6 Jul, 12:00–13:00"
 */
export function walkTime(date: string, windowStart: string, windowEnd: string): string {
  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone: LONDON,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(`${date}T12:00:00Z`));
  return `${day}, ${hhmm(windowStart)}–${hhmm(windowEnd)}`;
}

function hhmm(t: string): string {
  return t.slice(0, 5);
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
