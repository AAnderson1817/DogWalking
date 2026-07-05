// Role resolution (phase 04 acceptance): operator row / client row /
// neither, with mocked queries.
import { describe, expect, it } from "vitest";
import { resolveRole } from "./auth-context";

function queries(opts: { operator?: boolean; clientId?: string | null }) {
  const calls: string[] = [];
  return {
    calls,
    operatorExists: (id: string) => {
      calls.push(`operatorExists:${id}`);
      return Promise.resolve(opts.operator ?? false);
    },
    clientIdFor: (userId: string) => {
      calls.push(`clientIdFor:${userId}`);
      return Promise.resolve(opts.clientId ?? null);
    },
  };
}

describe("resolveRole", () => {
  it("resolves an operators row to the operator persona", async () => {
    const q = queries({ operator: true });
    const result = await resolveRole("uid-1", q);
    expect(result).toEqual({ role: "operator", operatorId: "uid-1", clientId: null });
    // Short-circuits: no client lookup needed.
    expect(q.calls).toEqual(["operatorExists:uid-1"]);
  });

  it("resolves a linked clients row to the client persona", async () => {
    const q = queries({ clientId: "client-9" });
    const result = await resolveRole("uid-2", q);
    expect(result).toEqual({ role: "client", operatorId: null, clientId: "client-9" });
    expect(q.calls).toEqual(["operatorExists:uid-2", "clientIdFor:uid-2"]);
  });

  it("resolves neither to a null role (fresh signup → Onboard)", async () => {
    const result = await resolveRole("uid-3", queries({}));
    expect(result).toEqual({ role: null, operatorId: null, clientId: null });
  });

  it("prefers operator when a uid somehow matches both", async () => {
    const result = await resolveRole("uid-4", queries({ operator: true, clientId: "client-1" }));
    expect(result.role).toBe("operator");
  });
});
