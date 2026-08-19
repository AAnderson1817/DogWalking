import { useRef, type CSSProperties, type ReactNode } from "react";

/**
 * A real tablist (review M16).
 *
 * Both segmented controls declared `role="tablist"` and `role="tab"` with
 * `aria-selected` over bare `<div>` content, and that was all: no
 * `aria-controls`, no `role="tabpanel"`, no `aria-label` on ClientDetail's, no
 * roving `tabIndex` and no key handling. A screen-reader user was told "tab, 5
 * of 5, selected" for the operator's main client workspace — whose fifth tab
 * is the credential vault — reached for the arrow keys that announcement
 * implies, and nothing happened. Incorrect ARIA is worse than none: it
 * promises an interaction the widget does not have.
 *
 * Manual activation, not automatic. The APG recommends selection-follows-focus
 * "as long as their associated tab panels are displayed without noticeable
 * latency", and ClientDetail's panels each mount a component that fetches — so
 * arrowing across five tabs would fire five requests on a phone on cellular.
 * Arrows and Home/End move focus; Enter or Space selects. One behaviour for
 * both controls rather than a fast one and a slow one, because a widget that
 * behaves differently in two places is its own accessibility problem.
 */

export interface SegmentedTab<K extends string> {
  key: K;
  label: string;
}

export function SegmentedTabs<K extends string>({
  idBase,
  label,
  tabs,
  value,
  onChange,
  className = "segmented-control",
  style,
}: {
  /** Prefix for the generated tab/panel ids; must match the panels'. */
  idBase: string;
  /** Names the control for a screen reader. ClientDetail's had none. */
  label: string;
  tabs: ReadonlyArray<SegmentedTab<K>>;
  value: K;
  onChange: (key: K) => void;
  className?: string;
  style?: CSSProperties;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const focusAt = (index: number) => {
    const next = (index + tabs.length) % tabs.length;
    refs.current[next]?.focus();
  };

  return (
    <div className={className} role="tablist" aria-label={label} style={style}>
      {tabs.map((tab, i) => {
        const selected = tab.key === value;
        return (
          <button
            key={tab.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            id={`${idBase}-tab-${tab.key}`}
            className={`${className}__button`}
            role="tab"
            aria-selected={selected}
            aria-controls={`${idBase}-panel-${tab.key}`}
            // Roving tabIndex: exactly one tab is in the tab order, and the
            // arrow keys move within the group. Without it, Tab walks through
            // every tab before reaching the panel — which is what the tablist
            // role exists to avoid in the first place.
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.key)}
            onKeyDown={(e) => {
              // Horizontal control, so Left/Right. Up/Down are accepted too:
              // the bar wraps to two rows on a narrow phone, where "next" is
              // as plausibly down as right.
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                focusAt(i + 1);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                focusAt(i - 1);
              } else if (e.key === "Home") {
                e.preventDefault();
                focusAt(0);
              } else if (e.key === "End") {
                e.preventDefault();
                focusAt(tabs.length - 1);
              } else if (e.key === "Enter" || e.key === " ") {
                // A `<button>` already fires click for both, so this only has
                // to stop the space bar scrolling the page underneath.
                if (e.key === " ") e.preventDefault();
                onChange(tab.key);
              }
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The other half of the pair. A tablist with no tabpanel is the defect, not a
 * smaller version of it: `aria-controls` has to point at something, and a
 * screen reader moves from a tab into its panel.
 */
export function TabPanel({
  idBase,
  tabKey,
  children,
}: {
  idBase: string;
  tabKey: string;
  children: ReactNode;
}) {
  return (
    <div
      id={`${idBase}-panel-${tabKey}`}
      role="tabpanel"
      aria-labelledby={`${idBase}-tab-${tabKey}`}
      // Focusable so the panel itself is reachable when it holds no focusable
      // content — otherwise Tab from the selected tab skips straight past it.
      tabIndex={0}
    >
      {children}
    </div>
  );
}
