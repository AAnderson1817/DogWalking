import alertIconUrl from "@/assets/icons/sanpo-alert-icon-approved-v1.svg";
import calendarIconUrl from "@/assets/icons/sanpo-calendar-icon-approved-v1.svg";
import checkIconUrl from "@/assets/icons/sanpo-check-icon-approved-v1.svg";
import clientsIconUrl from "@/assets/icons/sanpo-clients-icon-approved-v1.svg";
import dayIconUrl from "@/assets/icons/sanpo-day-icon-approved-v1.svg";
import disputedIconUrl from "@/assets/icons/sanpo-disputed-icon-approved-v1.svg";
import inboxIconUrl from "@/assets/icons/sanpo-inbox-icon-approved-v1.svg";
import paymentsIconUrl from "@/assets/icons/sanpo-payments-icon-approved-v1.svg";
import pendingIconUrl from "@/assets/icons/sanpo-pending-icon-approved-v1.svg";
import returnedIconUrl from "@/assets/icons/sanpo-returned-icon-approved-v1.svg";
import routeIconUrl from "@/assets/icons/sanpo-route-icon-approved-v1.svg";

/**
 * Review M19. The five below the navigation set are STATE MARKS, added
 * because Money and the walk surfaces were drawing them as text glyphs:
 * `✓ … ! ↩ ⚠`. Verified in Chromium via `CSS.getPlatformFontsForNode` —
 * not by comparing advance widths, which was inconclusive — that U+2713,
 * U+21A9 and U+26A0 are rendered by DejaVu Sans, the system fallback, while
 * `…`, `!` and `—` do come from Nunito. So the two most important marks on
 * the money surface, and the check beside DONE on Today and on the client's
 * own report card, were drawn by whatever font the device happened to have,
 * with synthesised weight — literally a different shape on a Mac and on a
 * Pixel.
 *
 * Same 24x24 / 1.75px round-cap grid as the navigation masters, same hash
 * guard, so they are one system rather than a second one.
 */
export const APPROVED_ICON_URLS = {
  alert: alertIconUrl,
  calendar: calendarIconUrl,
  check: checkIconUrl,
  clients: clientsIconUrl,
  day: dayIconUrl,
  disputed: disputedIconUrl,
  inbox: inboxIconUrl,
  payments: paymentsIconUrl,
  pending: pendingIconUrl,
  returned: returnedIconUrl,
  route: routeIconUrl,
} as const;

export type ApprovedIconName = keyof typeof APPROVED_ICON_URLS;
