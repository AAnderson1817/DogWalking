// Persona-aware bottom navigation (spec 05). Operator: Today · Calendar ·
// Roster · Vault; portal: Home · Book · Walks · Billing. Collapses to a
// left rail on desktop for the operator (components.css).
import { NavLink } from "react-router-dom";

interface NavItem {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
}

const OPERATOR_ITEMS: NavItem[] = [
  { to: "/", label: "Today", icon: "☀", end: true },
  { to: "/calendar", label: "Calendar", icon: "▦" },
  { to: "/roster", label: "Roster", icon: "☰" },
  { to: "/vault", label: "Vault", icon: "⚿" },
];

const PORTAL_ITEMS: NavItem[] = [
  { to: "/portal", label: "Home", icon: "⌂", end: true },
  { to: "/portal/book", label: "Book", icon: "＋" },
  { to: "/portal/walks", label: "Walks", icon: "➤" },
  { to: "/portal/billing", label: "Billing", icon: "£" },
];

export function BottomNav({ persona }: { persona: "operator" | "client" }) {
  const items = persona === "operator" ? OPERATOR_ITEMS : PORTAL_ITEMS;
  return (
    <nav
      className={`bottom-nav${persona === "operator" ? " bottom-nav--rail" : ""}`}
      aria-label="Primary"
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
