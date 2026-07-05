// materialize-walks — scheduled (cron 03:00 UTC, supabase/config.toml) +
// POST with an operator JWT for a manual run (spec 04). The generation
// itself is fn_materialize_walks (0007): set-based, idempotent via the
// (schedule_id, scheduled_date) unique index.
import { jsonOk, requireOperator, serveFunction, HttpError } from "../_lib/http.ts";
import { adminClient } from "../_lib/admin.ts";

serveFunction(async (req) => {
  // Cron/scheduled invocations authenticate with the service-role key;
  // interactive runs must be an operator.
  const auth = req.headers.get("Authorization") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const isService = serviceKey.length > 0 && auth === `Bearer ${serviceKey}`;
  if (!isService) {
    await requireOperator(req);
  }

  const db = adminClient();
  const { data, error } = await db.rpc("fn_materialize_walks", {
    p_horizon_days: 14,
  });
  if (error) throw new HttpError(500, "materialize_failed", "walk materialization failed");

  // Daily rollover-lot expiry sweep rides on the same cron (spec 04 /
  // phase 08 wiring). Advisory: a sweep failure must not block the walks.
  let expired = 0;
  const sweep = await db.rpc("fn_expire_credits");
  if (!sweep.error) expired = (sweep.data as number) ?? 0;

  return jsonOk({ created: (data as number) ?? 0, expired_clients: expired });
});
