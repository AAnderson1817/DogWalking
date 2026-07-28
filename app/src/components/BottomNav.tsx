// Persona-aware bottom navigation. The operator destinations and icon
// assignments are governed by Sanpo IP-2 / Utility Icons v1.1:
// Today · Calendar · Clients · Money. Inbox and Access Vault remain
// secondary utilities. The operator navigation becomes a rail on desktop.
import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { ApprovedIcon } from "./ApprovedIcon";
import { OPERATOR_NAV_ITEMS } from "./operator-navigation";
import { PawIcon } from "./PetAvatar";

function CirclesIcon() {
  return (
    <svg viewBox="0 0 26 20" width="21" height="16" aria-hidden>
      <circle cx="8" cy="10" r="6.5" fill="none" stroke="currentColor" strokeWidth="2.5" />
      <circle cx="17" cy="10" r="6.5" fill="none" stroke="currentColor" strokeWidth="2.5" />
    </svg>
  );
}

function DiamondIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden>
      <rect x="5" y="5" width="10" height="10" rx="2.5" fill="none" stroke="currentColor" strokeWidth="2.5" transform="rotate(45 10 10)" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden>
      <path d="M10 3v14M3 10h14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  end?: boolean;
}

const PORTAL_ITEMS: NavItem[] = [
  { to: "/portal", label: "Home", icon: <PawIcon />, end: true },
  { to: "/portal/book", label: "Book", icon: <PlusIcon /> },
  { to: "/portal/walks", label: "Walks", icon: <CirclesIcon /> },
  { to: "/portal/billing", label: "Billing", icon: <DiamondIcon /> },
];

export function BottomNav({ persona }: { persona: "operator" | "client" }) {
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
            `bottom-nav__item${isActive ? " bottom-nav__item--active" : ""}`
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
