// Role resolution (phase 04 acceptance): operator row / client row /
// neither, with mocked queries. Since review H31 the operator lookup also
// carries the billing state the subscription gate reads, fetched IN the
// role query so the gate can never see "no data" from a failure the
// resolver would have surfaced as roleError.
import { describe, expect, it } from "vitest";
import { resolveRole } from "./auth-context";
import type { OperatorBillingState } from "./operator-access";

const BILLING: OperatorBillingState = {
  trialEndsAt: "2026-09-13T00:00:00Z",
  platformSubscriptionStatus: "none",
};

function queries(opts: { operator?: boolean; clientId?: string | null }) {
  const calls: string[] = [];
  return {
    calls,
    operatorBilling: (id: string) => {
      calls.push(`operatorBilling:${id}`);
      return Promise.resolve(opts.operator ? BILLING : null);
    },
    clientIdFor: (userId: string) => {
      calls.push(`clientIdFor:${userId}`);
      return Promise.resolve(opts.clientId ?? null);
    },
  };
}

describe("resolveRole", () => {
  it("resolves an operators row to the operator persona, billing attached", async () => {
    const q = queries({ operator: true });
    const result = await resolveRole("uid-1", q);
    expect(result).toEqual({
      role: "operator",
      operatorId: "uid-1",
      clientId: null,
      billing: BILLING,
    });
    // Short-circuits: no client lookup needed.
    expect(q.calls).toEqual(["operatorBilling:uid-1"]);
  });

  it("resolves a linked clients row to the client persona, no billing", async () => {
    const q = queries({ clientId: "client-9" });
    const result = await resolveRole("uid-2", q);
    expect(result).toEqual({
      role: "client",
      operatorId: null,
      clientId: "client-9",
      billing: null,
    });
    expect(q.calls).toEqual(["operatorBilling:uid-2", "clientIdFor:uid-2"]);
  });

  it("resolves neither to a null role (fresh signup → Onboard)", async () => {
    const result = await resolveRole("uid-3", queries({}));
    expect(result).toEqual({ role: null, operatorId: null, clientId: null, billing: null });
  });

  it("prefers operator when a uid somehow matches both", async () => {
    const result = await resolveRole("uid-4", queries({ operator: true, clientId: "client-1" }));
    expect(result.role).toBe("operator");
    expect(result.billing).toEqual(BILLING);
  });
});
