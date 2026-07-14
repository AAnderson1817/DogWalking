// complete-walk: happy path, idempotent replay, overage path (mocked deps).
import { assert, assertEquals, assertFalse, assertRejects } from "./asserts.ts";
import {
  completeWalk,
  type CompleteWalkBody,
  type CompleteWalkDeps,
  type WalkRow,
} from "../complete-walk/handler.ts";

function baseWalk(overrides: Partial<WalkRow> = {}): WalkRow {
  return {
    id: "walk-1",
    operator_id: "op-1",
    client_id: "client-1",
    status: "in_progress",
    credits_debited: 0,
    is_overage: false,
    ...overrides,
  };
}

function body(overrides: Partial<CompleteWalkBody> = {}): CompleteWalkBody {
  return {
    walk_id: "walk-1",
    ended_at: "2026-07-01T12:38:00Z",
    distance_m: 2140,
    notes: "Good walk",
    potty_pee: true,
    photo_paths: ["op-1/walk-1/a.jpg"],
    ...overrides,
  };
}

function makeDeps(
  walk: WalkRow,
  debitOutcome: "debited" | "overage",
  opts: { hasNotification?: boolean; failDebit?: boolean } = {},
) {
  const calls: string[] = [];
  const deps: CompleteWalkDeps = {
    getWalk: (id) => {
      calls.push("getWalk");
      return Promise.resolve(id === walk.id ? walk : null);
    },
    updateWalkCompleted: (_id, fields) => {
      calls.push("updateWalkCompleted");
      return Promise.resolve({ ...walk, ...fields } as WalkRow);
    },
    insertPhotos: (_w, paths) => {
      calls.push(`insertPhotos:${paths.length}`);
      return Promise.resolve();
    },
    debitWalk: () => {
      calls.push("debitWalk");
      if (opts.failDebit) return Promise.reject(new Error("db blip"));
      return Promise.resolve(
        debitOutcome === "debited"
          ? { outcome: "debited", cost: 1, new_balance: 4 }
          : { outcome: "overage", cost: 2, new_balance: 0 },
      );
    },
    chargeOverage: () => {
      calls.push("chargeOverage");
      return Promise.resolve({ payment: { amount_pence: 2200, status: "succeeded" } });
    },
    getOveragePayment: () => {
      calls.push("getOveragePayment");
      return Promise.resolve({ amount_pence: 2200, status: "succeeded" });
    },
    insertNotification: (row) => {
      calls.push(`notify:${row.type}`);
      return Promise.resolve();
    },
    hasCompleteNotification: () => {
      calls.push("hasCompleteNotification");
      return Promise.resolve(opts.hasNotification ?? true);
    },
    notifyLowCredit: () => {
      calls.push("notifyLowCredit");
      return Promise.resolve(true);
    },
    broadcast: (_t, event) => {
      calls.push(`broadcast:${event}`);
      return Promise.resolve();
    },
  };
  return { deps, calls };
}

Deno.test("happy path: debit, notification, low-credit check, broadcast", async () => {
  const { deps, calls } = makeDeps(baseWalk(), "debited");
  const result = await completeWalk("op-1", body(), deps);
  assertEquals(result.billing, { outcome: "debited", cost_credits: 1 });
  assertEquals(result.walk.status, "completed");
  assert(calls.includes("updateWalkCompleted"));
  assert(calls.includes("insertPhotos:1"));
  assert(calls.includes("debitWalk"));
  assert(calls.includes("notify:walk_complete"));
  assert(calls.includes("notifyLowCredit"));
  assert(calls.includes("broadcast:ended"));
  assertFalse(calls.includes("chargeOverage"));
});

Deno.test("overage path charges the whole walk, skips low-credit", async () => {
  const { deps, calls } = makeDeps(baseWalk(), "overage");
  const result = await completeWalk("op-1", body(), deps);
  assertEquals(result.billing, {
    outcome: "overage",
    charged_pence: 2200,
    payment_status: "succeeded",
  });
  assert(calls.includes("chargeOverage"));
  assertFalse(calls.includes("notifyLowCredit"));
});

Deno.test("idempotent replay on a completed debited walk: no re-billing", async () => {
  const completed = baseWalk({ status: "completed", credits_debited: 1 });
  const { deps, calls } = makeDeps(completed, "debited");
  const result = await completeWalk("op-1", body(), deps);
  assertEquals(result.billing, { outcome: "debited", cost_credits: 1 });
  assertFalse(calls.includes("debitWalk"));
  assertFalse(calls.includes("updateWalkCompleted"));
  assertFalse(calls.includes("chargeOverage"));
  assertFalse(calls.some((c) => c.startsWith("notify:")), "notification already sent — no duplicate");
  assert(calls.includes("insertPhotos:1"), "replay backfills photos (idempotent upsert)");
});

Deno.test("replay after a partial failure backfills the missing notification", async () => {
  const completed = baseWalk({ status: "completed", credits_debited: 1 });
  const { deps, calls } = makeDeps(completed, "debited", { hasNotification: false });
  await completeWalk("op-1", body(), deps);
  assert(calls.includes("notify:walk_complete"), "dropped notification must be backfilled");
});

Deno.test("bills BEFORE completing: debit precedes the status flip", async () => {
  const { deps, calls } = makeDeps(baseWalk(), "debited");
  await completeWalk("op-1", body(), deps);
  assert(
    calls.indexOf("debitWalk") < calls.indexOf("updateWalkCompleted"),
    "reverting the bill-before-complete order recreates the permanently-free-walk bug",
  );
});

Deno.test("debit failure leaves the walk in_progress (no completion, no notify) and a retry bills once", async () => {
  const walk = baseWalk();
  const failing = makeDeps(walk, "debited", { failDebit: true });
  await assertRejects(() => completeWalk("op-1", body(), failing.deps));
  assertFalse(failing.calls.includes("updateWalkCompleted"));
  assertFalse(failing.calls.some((c) => c.startsWith("notify:")));

  const retry = makeDeps(walk, "debited");
  const result = await completeWalk("op-1", body(), retry.deps);
  assertEquals(result.billing, { outcome: "debited", cost_credits: 1 });
  assertEquals(retry.calls.filter((c) => c === "debitWalk").length, 1);
  assert(retry.calls.includes("updateWalkCompleted"));
});

Deno.test("idempotent replay on a completed overage walk returns the stored payment", async () => {
  const completed = baseWalk({ status: "completed", credits_debited: 0, is_overage: true });
  const { deps, calls } = makeDeps(completed, "overage");
  const result = await completeWalk("op-1", body(), deps);
  assertEquals(result.billing, {
    outcome: "overage",
    charged_pence: 2200,
    payment_status: "succeeded",
  });
  assert(calls.includes("getOveragePayment"));
  assertFalse(calls.includes("chargeOverage"));
  assertFalse(calls.includes("debitWalk"));
});

Deno.test("another operator's walk is invisible (404)", async () => {
  const { deps } = makeDeps(baseWalk({ operator_id: "op-2" }), "debited");
  await assertRejects(() => completeWalk("op-1", body(), deps));
});

Deno.test("scheduled (not started) walk is rejected", async () => {
  const { deps } = makeDeps(baseWalk({ status: "scheduled" }), "debited");
  await assertRejects(() => completeWalk("op-1", body(), deps));
});
