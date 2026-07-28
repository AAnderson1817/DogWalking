import type { ApprovedIconName } from "./approved-icons";

export const OPERATOR_NAV_ITEMS: ReadonlyArray<{
  to: string;
  label: string;
  icon: ApprovedIconName;
  end?: boolean;
}> = [
  { to: "/", label: "Today", icon: "day", end: true },
  { to: "/calendar", label: "Calendar", icon: "calendar" },
  { to: "/roster", label: "Clients", icon: "clients" },
  { to: "/billing", label: "Money", icon: "payments" },
];
