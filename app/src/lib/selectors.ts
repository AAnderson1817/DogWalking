// Dashboard data selectors (phase 05) — pure, tested against fixtures.
// Generics are structural (string-typed) so both generated Row types and
// plain test fixtures satisfy them.

const DISPLAY_TZ = "America/Chicago";

/** Today's calendar date in US Central as YYYY-MM-DD. */
export function todayLocal(nowMs: number = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
}

/** Today's walks in route order (v1 = time order), cancelled/no-show last. */
export function todaysWalks<
  W extends { scheduled_date: string; window_start: string; status: string },
>(walks: readonly W[], today: string): W[] {
  const rank = (w: W) => (w.status === "cancelled" || w.status === "no_show" ? 1 : 0);
  return walks
    .filter((w) => w.scheduled_date === today)
    .sort((a, b) =>
      rank(a) - rank(b) || a.window_start.localeCompare(b.window_start),
    );
}

/** The walk to surface in the LiveWalkBanner (most recently started). */
export function liveWalk<W extends { status: string; started_at: string | null }>(
  walks: readonly W[],
): W | null {
  const live = walks
    .filter((w) => w.status === "in_progress" && w.started_at)
    .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
  return live[0] ?? null;
}

/** Clients at or below the operator's low-credit threshold (spec 02: ≤). */
export function lowCreditClients<
  C extends { credit_balance: number; status: string; subscription_status: string },
>(clients: readonly C[], threshold: number): C[] {
  return clients
    .filter((c) => c.status !== "archived")
    .filter((c) => c.subscription_status === "active" || c.subscription_status === "past_due")
    .filter((c) => c.credit_balance <= threshold)
    .sort((a, b) => a.credit_balance - b.credit_balance);
}

/** Failed payments needing attention, newest first. */
export function failedPayments<P extends { status: string; created_at: string }>(
  payments: readonly P[],
): P[] {
  return payments
    .filter((p) => p.status === "failed")
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function unreadCount<N extends { read_at: string | null }>(
  notifications: readonly N[],
): number {
  return notifications.filter((n) => n.read_at === null).length;
}
