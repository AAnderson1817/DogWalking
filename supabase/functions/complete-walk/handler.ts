// complete-walk core logic (spec 04), dependency-injected for testability.
// Effects in order: assert ownership + in_progress → update walk → photos →
// fn_debit_walk → overage charge in-process if needed → walk_complete
// notification → low-credit check → Realtime broadcast. Idempotent: re-POST
// on a completed walk returns the stored result without re-billing.

import { HttpError } from "../_lib/http.ts";

export interface CompleteWalkBody {
  walk_id: string;
  ended_at: string;
  distance_m: number;
  notes?: string;
  potty_pee?: boolean;
  potty_poo?: boolean;
  fed?: boolean;
  watered?: boolean;
  photo_paths?: string[];
}

export interface WalkRow {
  id: string;
  operator_id: string;
  client_id: string;
  status: string;
  credits_debited: number;
  is_overage: boolean;
  [key: string]: unknown;
}

export interface Billing {
  outcome: "debited" | "overage";
  cost_credits?: number;
  charged_pence?: number;
  payment_status?: string;
}

export interface CompleteWalkDeps {
  getWalk(id: string): Promise<WalkRow | null>;
  updateWalkCompleted(
    id: string,
    fields: Record<string, unknown>,
  ): Promise<WalkRow>;
  insertPhotos(walk: WalkRow, paths: string[]): Promise<void>;
  debitWalk(
    walkId: string,
  ): Promise<{ outcome: string; cost: number; new_balance: number }>;
  chargeOverage(walkId: string): Promise<{
    payment: { amount_pence: number; status: string };
  }>;
  getOveragePayment(
    walkId: string,
  ): Promise<{ amount_pence: number; status: string } | null>;
  insertNotification(row: {
    operator_id: string;
    client_id: string | null;
    type: string;
    title: string;
    body: string;
    walk_id: string | null;
  }): Promise<void>;
  notifyLowCredit(clientId: string): Promise<boolean>;
  broadcast(topic: string, event: string, payload: unknown): Promise<void>;
}

export async function completeWalk(
  operatorId: string,
  body: CompleteWalkBody,
  deps: CompleteWalkDeps,
): Promise<{ walk: WalkRow; billing: Billing }> {
  if (!body?.walk_id) throw new HttpError(400, "bad_request", "walk_id is required");
  if (!body.ended_at) throw new HttpError(400, "bad_request", "ended_at is required");
  if (typeof body.distance_m !== "number" || body.distance_m < 0) {
    throw new HttpError(400, "bad_request", "distance_m must be a non-negative number");
  }

  const walk = await deps.getWalk(body.walk_id);
  if (!walk || walk.operator_id !== operatorId) {
    throw new HttpError(404, "walk_not_found", "walk not found");
  }

  // Idempotent replay: already completed → return the stored outcome.
  if (walk.status === "completed") {
    return { walk, billing: await storedBilling(walk, deps) };
  }
  if (walk.status !== "in_progress") {
    throw new HttpError(409, "invalid_status", `walk is ${walk.status}, not in_progress`);
  }

  // Bill BEFORE marking the walk completed. fn_debit_walk is idempotent
  // under its per-client lock and the overage charge carries a Stripe
  // idempotency key, so if either throws the walk stays in_progress and the
  // client's retry re-runs billing — instead of a completed-but-never-billed
  // (permanently free) walk that the idempotent-replay branch would then
  // report as a zero-cost debit forever.
  const debit = await deps.debitWalk(walk.id);
  let billing: Billing;
  if (debit.outcome === "overage") {
    const { payment } = await deps.chargeOverage(walk.id);
    billing = {
      outcome: "overage",
      charged_pence: payment.amount_pence,
      payment_status: payment.status,
    };
  } else {
    billing = { outcome: "debited", cost_credits: debit.cost };
  }

  const updated = await deps.updateWalkCompleted(walk.id, {
    status: "completed",
    ended_at: body.ended_at,
    distance_m: Math.round(body.distance_m),
    notes: body.notes ?? null,
    potty_pee: body.potty_pee ?? null,
    potty_poo: body.potty_poo ?? null,
    fed: body.fed ?? null,
    watered: body.watered ?? null,
  });

  if (body.photo_paths?.length) {
    await deps.insertPhotos(walk, body.photo_paths);
  }

  await deps.insertNotification({
    operator_id: walk.operator_id,
    client_id: walk.client_id,
    type: "walk_complete",
    title: "Walk complete",
    body: "Your walk report card is ready.",
    walk_id: walk.id,
  });

  if (billing.outcome === "debited") {
    await deps.notifyLowCredit(walk.client_id);
  }

  try {
    await deps.broadcast(`walk:${walk.id}`, "ended", { walk_id: walk.id });
  } catch {
    // Broadcast is best-effort; never fail a completed walk over it.
  }

  return { walk: updated, billing };
}

async function storedBilling(walk: WalkRow, deps: CompleteWalkDeps): Promise<Billing> {
  if (walk.credits_debited > 0) {
    return { outcome: "debited", cost_credits: walk.credits_debited };
  }
  if (walk.is_overage) {
    const payment = await deps.getOveragePayment(walk.id);
    return {
      outcome: "overage",
      charged_pence: payment?.amount_pence,
      payment_status: payment?.status,
    };
  }
  // Completed before any billing was recorded (should not happen): report
  // a zero-cost debit rather than inventing a charge.
  return { outcome: "debited", cost_credits: 0 };
}
