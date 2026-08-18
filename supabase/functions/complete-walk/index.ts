// complete-walk — POST, operator JWT (spec 04).
import {
  HttpError,
  jsonOk,
  readJson,
  requireAccount,
  requireOperator,
  serveFunction,
} from "../_lib/http.ts";
import { adminClient } from "../_lib/admin.ts";
import { stripeClient } from "../_lib/stripe.ts";
import { chargeOverageForWalk } from "../_lib/overage.ts";
import { makeOverageDeps } from "../_lib/overage_deps.ts";
import { broadcast } from "../_lib/broadcast.ts";
import { completeWalk, type CompleteWalkBody, type CompleteWalkDeps, type WalkRow } from "./handler.ts";

// `account` threads through to the overage charge — the operator is the
// merchant of record (review B5), so an overage taken here lands on their
// Stripe account, not the platform's.
function makeDeps(account: { stripeAccount: string }): CompleteWalkDeps {
  const db = adminClient();
  return {
    async getWalk(id) {
      const { data, error } = await db.from("walks").select("*").eq("id", id).maybeSingle();
      if (error) throw new HttpError(500, "db_error", "walk lookup failed");
      return data as WalkRow | null;
    },

    async updateWalkCompleted(id, fields) {
      const { data, error } = await db
        .from("walks")
        .update(fields)
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw new HttpError(500, "db_error", "walk update failed");
      return data as WalkRow;
    },

    async insertPhotos(walk, paths) {
      const rows = paths.map((p) => ({
        walk_id: walk.id,
        operator_id: walk.operator_id,
        storage_path: p,
        taken_at: new Date().toISOString(),
      }));
      // Idempotent under uq_walk_photos_path so the replay backfill is safe.
      const { error } = await db
        .from("walk_photos")
        .upsert(rows, { onConflict: "walk_id,storage_path", ignoreDuplicates: true });
      if (error) throw new HttpError(500, "db_error", "photo insert failed");
    },

    async debitWalk(walkId) {
      const { data, error } = await db.rpc("fn_debit_walk", { p_walk: walkId });
      if (error) throw new HttpError(500, "billing_error", "credit debit failed");
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new HttpError(500, "billing_error", "credit debit returned nothing");
      return row as { outcome: string; cost: number; new_balance: number };
    },

    async chargeOverage(walkId) {
      const result = await chargeOverageForWalk(
        walkId,
        makeOverageDeps(db, stripeClient(), account),
      );
      return { payment: result.payment };
    },

    async getOveragePayment(walkId) {
      const { data, error } = await db
        .from("payments")
        .select("amount_pence, status")
        .eq("walk_id", walkId)
        .eq("type", "overage")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new HttpError(500, "db_error", "payment lookup failed");
      return data;
    },

    async insertNotification(row) {
      const { error } = await db.from("notifications").insert(row);
      if (error) throw new HttpError(500, "db_error", "notification insert failed");
    },

    async hasCompleteNotification(walkId) {
      const { data, error } = await db
        .from("notifications")
        .select("id")
        .eq("walk_id", walkId)
        .eq("type", "walk_complete")
        .limit(1);
      if (error) throw new HttpError(500, "db_error", "notification lookup failed");
      return (data?.length ?? 0) > 0;
    },

    async notifyLowCredit(clientId) {
      const { data, error } = await db.rpc("fn_notify_low_credit", { p_client: clientId });
      if (error) return false; // advisory; never fail the walk over it
      return Boolean(data);
    },

    broadcast,
  };
}

serveFunction(async (req) => {
  const operator = await requireOperator(req);
  const body = await readJson<CompleteWalkBody>(req);
  // Resolved BEFORE the walk is touched. completeWalk bills before marking
  // complete (qc fix), so discovering "not connected" halfway would leave a
  // walk that is finished, unbilled, and not obviously either.
  const result = await completeWalk(operator.id, body, makeDeps(requireAccount(operator)));
  return jsonOk(result);
});
