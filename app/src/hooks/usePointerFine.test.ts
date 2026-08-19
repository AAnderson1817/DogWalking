import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POINTER_FINE, queryPointerFine, usePointerFine } from "./usePointerFine";

/**
 * Review M11. Calendar's drag-to-reschedule is HTML5 drag-and-drop, which does
 * not fire on touch at all — no `dragstart`, no `drop`. The walk chip
 * nevertheless rendered `draggable` with a grab cursor on a phone, so the
 * phase-06 headline interaction advertised itself and did nothing on the
 * primary device.
 */

const listeners = new Map<string, () => void>();

function stubMatchMedia(matches: boolean) {
  listeners.clear();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === POINTER_FINE ? matches : false,
    media: query,
    addEventListener: (_t: string, fn: () => void) => listeners.set(query, fn),
    removeEventListener: (_t: string) => listeners.delete(query),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("usePointerFine", () => {
  it("is true with a mouse or trackpad", () => {
    stubMatchMedia(true);
    expect(renderHook(() => usePointerFine()).result.current).toBe(true);
  });

  it("is false on a touch-only device", () => {
    stubMatchMedia(false);
    expect(renderHook(() => usePointerFine()).result.current).toBe(false);
  });

  it("subscribes, because a tablet gains a pointer when a keyboard is attached", () => {
    stubMatchMedia(false);
    renderHook(() => usePointerFine());
    expect(listeners.has(POINTER_FINE)).toBe(true);
  });

  it("unsubscribes on unmount", () => {
    stubMatchMedia(false);
    renderHook(() => usePointerFine()).unmount();
    expect(listeners.has(POINTER_FINE)).toBe(false);
  });

  it("defaults to FALSE where the query cannot run", () => {
    // The safe direction: a device wrongly treated as touch keeps a working
    // tap flow, while one wrongly treated as mouse gets the affordance that
    // does nothing — which is the defect itself.
    vi.stubGlobal("matchMedia", undefined);
    expect(queryPointerFine()).toBe(false);
  });
});
