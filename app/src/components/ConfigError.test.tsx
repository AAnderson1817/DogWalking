import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConfigError } from "./ConfigError";

/**
 * Review H22. Measured before the fix: a bundle built with no `VITE_*` served
 * `#root.innerHTML.length === 0` and one uncaught page error. After: 954 bytes
 * and no page errors.
 *
 * The build gate (`scripts/verify-env.mjs`, exercised in both directions by
 * CI) is what should stop that bundle existing. This panel is the safety net
 * for the case the gate is bypassed — a hosting provider building outside
 * `npm run build`, or a variable that is present but wrong.
 */
describe("ConfigError", () => {
  it("names every missing variable, so the fix is actionable", () => {
    render(<ConfigError missing={["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"]} />);
    expect(screen.getByText("VITE_SUPABASE_URL")).toBeInTheDocument();
    expect(screen.getByText("VITE_SUPABASE_ANON_KEY")).toBeInTheDocument();
  });

  it("is a landmark with a heading, not a bare div", () => {
    render(<ConfigError missing={["VITE_SUPABASE_URL"]} />);
    // The one screen a misconfigured deploy shows should not also be the one
    // screen with no landmark and no heading (spec 05).
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
  });

  it("says the data is untouched, because that is the first question", () => {
    render(<ConfigError missing={["VITE_SUPABASE_ANON_KEY"]} />);
    expect(screen.getByText(/nobody's data is affected/i)).toBeInTheDocument();
  });

  it("pluralises honestly", () => {
    const { unmount } = render(<ConfigError missing={["VITE_SUPABASE_URL"]} />);
    expect(screen.getByText("Missing variable:")).toBeInTheDocument();
    unmount();
    render(<ConfigError missing={["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"]} />);
    expect(screen.getByText("Missing variables:")).toBeInTheDocument();
  });
});
