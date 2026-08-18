// materialize-walks — the MANUAL path for the nightly work (spec 04).
//
// The schedule itself is no longer here: `cron.schedule('sanpo-nightly', …)`
// in migration 0028 calls fn_run_nightly_jobs() directly, so it is version
// controlled, recreated by any restore, and needs no credential (review H15).
// This function stays for the interactive run — the Calendar screen's "Run
// materializer" — and is what the staging smoke suite exercises.
//
// It calls the SAME entry point the cron does. Two implementations of "the
// night's work" would drift, and the manual path is the one a human uses to
// check whether the automatic path is healthy.
import { isServiceAuth, jsonOk, requireOperator, serveFunction, HttpError } from "../_lib/http.ts";
import { adminClient } from "../_lib/admin.ts";

interface NightlyResult {
  created: number;
  expired_clients: number;
  expiry_error: string | null;
  walks_flagged_abandoned: number;
  stale_walk_error: string | null;
}

serveFunction(async (req) => {
  // Scheduled/service invocations authenticate with the service-role key
  // (gateway-verified — verify_jwt stays on in config.toml); interactive
  // runs must be an operator.
  const isService = isServiceAuth(
    req.headers.get("Authorization"),
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
  if (!isService) {
    await requireOperator(req);
  }

  const db = adminClient();
  const { data, error } = await db.rpc("fn_run_nightly_jobs", { p_horizon_days: 14 });
  if (error) {
    throw new HttpError(500, "materialize_failed", "walk materialization failed", error);
  }

  const result = data as unknown as NightlyResult;

  // The expiry sweep is advisory — it must not block walk generation, since an
  // operator with an empty calendar is a worse day than one whose rollover
  // lots expire late. But it used to be SWALLOWED (`if (!sweep.error) …`), so
  // a permanently failing sweep was byte-identical in the response to a quiet
  // night: clients kept credits they had been billed for and stopped paying
  // overage, with no symptom anywhere. It is now returned AND logged.
  if (result?.expiry_error) {
    console.error("credit expiry sweep failed:", result.expiry_error);
  }

  // Same contract for the abandoned-walk sweep (review M28). Returning only
  // the fields that existed before would rebuild the swallow one level up: the
  // interactive run is what a human uses to check whether the automatic run is
  // healthy, so a sweep failing silently HERE is the same defect in the same
  // place, reported through a different pipe.
  if (result?.stale_walk_error) {
    console.error("abandoned-walk sweep failed:", result.stale_walk_error);
  }

  return jsonOk({
    created: result?.created ?? 0,
    expired_clients: result?.expired_clients ?? 0,
    expiry_error: result?.expiry_error ?? null,
    walks_flagged_abandoned: result?.walks_flagged_abandoned ?? 0,
    stale_walk_error: result?.stale_walk_error ?? null,
  });
});
