import calendarIconUrl from "@/assets/icons/sanpo-calendar-icon-approved-v1.svg";
import clientsIconUrl from "@/assets/icons/sanpo-clients-icon-approved-v1.svg";
import dayIconUrl from "@/assets/icons/sanpo-day-icon-approved-v1.svg";
import inboxIconUrl from "@/assets/icons/sanpo-inbox-icon-approved-v1.svg";
import paymentsIconUrl from "@/assets/icons/sanpo-payments-icon-approved-v1.svg";
import routeIconUrl from "@/assets/icons/sanpo-route-icon-approved-v1.svg";

export const APPROVED_ICON_URLS = {
  calendar: calendarIconUrl,
  clients: clientsIconUrl,
  day: dayIconUrl,
  inbox: inboxIconUrl,
  payments: paymentsIconUrl,
  route: routeIconUrl,
} as const;

export type ApprovedIconName = keyof typeof APPROVED_ICON_URLS;
