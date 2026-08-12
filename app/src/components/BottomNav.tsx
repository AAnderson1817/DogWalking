// Persona-aware bottom navigation. The operator destinations and icon
// assignments are governed by Sanpo IP-2 / Utility Icons v1.1:
// Today · Calendar · Clients · Money. Inbox and Access Vault remain
// secondary utilities. The operator navigation becomes a rail on desktop.
import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { ApprovedIcon } from "./ApprovedIcon";
import { OPERATOR_NAV_ITEMS } from "./operator-navigation";

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  end?: boolean;
}

const PORTAL_ITEMS: NavItem[] = [
  { to: "/portal", label: "Home", icon: <ApprovedIcon name="day" />, end: true },
  { to: "/portal/book", label: "Book", icon: <ApprovedIcon name="calendar" /> },
  { to: "/portal/walks", label: "Walks", icon: <ApprovedIcon name="route" /> },
  { to: "/portal/billing", label: "Billing", icon: <ApprovedIcon name="payments" /> },
];

export function BottomNav({
  persona,
  activePath,
}: {
  persona: "operator" | "client";
  activePath?: string;
}) {
  const items: NavItem[] =
    persona === "operator"
      ? OPERATOR_NAV_ITEMS.map((item) => ({
          ...item,
          icon: <ApprovedIcon name={item.icon} />,
        }))
      : PORTAL_ITEMS;

  return (
    <nav
      className={`bottom-nav${persona === "operator" ? " bottom-nav--rail" : ""}`}
      aria-label="Primary"
      data-navigation-persona={persona}
    >
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            `bottom-nav__item${(activePath ? item.to === activePath : isActive) ? " bottom-nav__item--active" : ""}`
          }
        >
          <span className="bottom-nav__icon" aria-hidden>
            {item.icon}
          </span>
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
