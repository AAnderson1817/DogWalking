// /pricing (review H31): "a public page that states the price". The test
// pins that the price it states is the constant the checkout charges — the
// figure a person reads and the figure Stripe collects must be one value.
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import Pricing from "./Pricing";
import { money } from "@/lib/format";
import { PLATFORM_PRICE_PENCE, TRIAL_DAYS } from "@/lib/operator-access";

describe("Pricing", () => {
  it("states the price and the trial, from the same constants the checkout uses", () => {
    render(<MemoryRouter><Pricing /></MemoryRouter>);
    expect(screen.getByText(money(PLATFORM_PRICE_PENCE))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`${TRIAL_DAYS}-day free trial`))).toBeInTheDocument();
  });

  it("routes to the signup door", () => {
    render(<MemoryRouter><Pricing /></MemoryRouter>);
    expect(screen.getByRole("link", { name: /start your free trial/i }))
      .toHaveAttribute("href", "/signup");
  });
});
