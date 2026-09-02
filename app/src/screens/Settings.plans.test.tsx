import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { PlansSection } from "./Settings";

/**
 * The wiring of the plan form, as opposed to its rule.
 *
 * `lib/plan-form.test.ts` pins what `planFormReady` decides. What this pins
 * is that the Create button actually asks it: with an overage rate of "0" the
 * button is disabled and `createPlan` is never called, so the zero-rate body
 * that used to mint an orphan Stripe Price and then die on the 0026 CHECK
 * never leaves the browser (PR C of the spec-drift audit).
 */

const api = vi.hoisted(() => ({
  createPlan: vi.fn(async (body: Record<string, unknown>) => ({
    plan: { id: "plan_1", name: body.name, active: true, ...body },
  })),
  updatePlan: vi.fn(),
}));
vi.mock("@/lib/api", async () => ({
  ...(await vi.importActual<typeof import("@/lib/api")>("@/lib/api")),
  createPlan: api.createPlan,
  updatePlan: api.updatePlan,
}));

function renderSection() {
  const onChanged = vi.fn();
  const onError = vi.fn();
  // The section renders router links, so it needs a router around it.
  render(
    <MemoryRouter>
      <PlansSection plans={[]} onChanged={onChanged} onError={onError} />
    </MemoryRouter>,
  );
  return { onChanged, onError };
}

describe("PlansSection", () => {
  it("keeps Create disabled on a zero overage rate and never calls the server", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.type(screen.getByLabelText("Plan name"), "Weekly walks");
    await user.type(screen.getByLabelText("Price ($)"), "40");
    await user.type(screen.getByLabelText("Overage rate ($ per walk)"), "0");
    const button = screen.getByRole("button", { name: /create plan/i });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(api.createPlan).not.toHaveBeenCalled();
  });

  it("enables Create once the rate is positive and sends whole cents", async () => {
    const user = userEvent.setup();
    const { onChanged } = renderSection();
    await user.type(screen.getByLabelText("Plan name"), "Weekly walks");
    await user.type(screen.getByLabelText("Price ($)"), "40");
    const overage = screen.getByLabelText("Overage rate ($ per walk)");
    await user.type(overage, "0");
    expect(screen.getByRole("button", { name: /create plan/i })).toBeDisabled();
    await user.clear(overage);
    await user.type(overage, "2.50");
    const button = screen.getByRole("button", { name: /create plan/i });
    expect(button).toBeEnabled();
    await user.click(button);
    await waitFor(() => expect(api.createPlan).toHaveBeenCalledTimes(1));
    expect(api.createPlan.mock.calls[0]?.[0]).toMatchObject({
      name: "Weekly walks",
      price_pence: 4000,
      overage_rate_pence: 250,
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});
