// Per-route document title and route announcement (review M12).
//
// Every route shared one title, "Sanpo", set once in index.html and never
// assigned — so browser history, tab lists and bookmarks were fifteen
// identical entries, and a screen reader announced nothing on navigation
// because a client-side route change is not a page load.
import { useEffect } from "react";

const SUFFIX = "Sanpo";
const REGION_ID = "route-announcer";

/**
 * A single polite live region, appended to <body> rather than rendered into
 * the route tree: the announcement has to survive the unmount/mount of the
 * screen that triggered it, and a region that unmounts with its screen never
 * gets read.
 */
function announcer(): HTMLElement {
  const existing = document.getElementById(REGION_ID);
  if (existing) return existing;
  const el = document.createElement("div");
  el.id = REGION_ID;
  el.className = "sr-only";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  document.body.appendChild(el);
  return el;
}

/** Sets `<title>` and announces the new screen. Call once per route screen. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · ${SUFFIX}` : SUFFIX;
    announcer().textContent = title || SUFFIX;
  }, [title]);
}
