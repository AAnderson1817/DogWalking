// complete-walk — POST, operator JWT (spec 04).
import { jsonOk, readJson, requireOperator, serveFunction, HttpError } from "../_lib/http.ts";
import { adminClient } from "../_lib/admin.ts";
import { stripeClient } from "../_lib/stripe.ts";
import { chargeOverageForWalk } from "../_lib/overage.ts";
import { makeOverageDeps } from "../_lib/overage_deps.ts";
import { broadcast } from "../_lib/broadcast.ts";
import { completeWalk, type CompleteWalkBody, type CompleteWalkDeps, type WalkRow } from "./handler.ts";

function makeDeps(): CompleteWalkDeps {
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
      const { error } = await db.from("walk_photos").insert(rows);
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
      const result = await chargeOverageForWalk(walkId, makeOverageDeps(db, stripeClient()));
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
  const result = await completeWalk(operator.id, body, makeDeps());
  return jsonOk(result);
});
