// charge-overage — POST, operator JWT (spec 04). Also invoked in-process by
// complete-walk via _lib/overage.ts; this endpoint exists for manual
// re-charge from the billing console.
import { jsonOk, readJson, requireOperator, serveFunction, HttpError } from "../_lib/http.ts";
import { adminClient } from "../_lib/admin.ts";
import { stripeClient } from "../_lib/stripe.ts";
import { chargeOverageForWalk, OverageError } from "../_lib/overage.ts";
import { makeOverageDeps } from "../_lib/overage_deps.ts";

serveFunction(async (req) => {
  const operator = await requireOperator(req);
  const body = await readJson<{ walk_id?: string }>(req);
  if (!body?.walk_id) throw new HttpError(400, "bad_request", "walk_id is required");

  const db = adminClient();
  const { data: walk, error } = await db
    .from("walks")
    .select("id, operator_id")
    .eq("id", body.walk_id)
    .maybeSingle();
  if (error) throw new HttpError(500, "db_error", "walk lookup failed");
  if (!walk || walk.operator_id !== operator.id) {
    throw new HttpError(404, "walk_not_found", "walk not found");
  }

  try {
    const result = await chargeOverageForWalk(body.walk_id, makeOverageDeps(db, stripeClient()));
    return jsonOk({ payment: result.payment, already_charged: result.already_charged });
  } catch (e) {
    if (e instanceof OverageError) throw new HttpError(e.status, e.code, e.message);
    throw e;
  }
});
