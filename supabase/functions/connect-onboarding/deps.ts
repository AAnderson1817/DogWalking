// connect-onboarding WIRING: the part that reaches the database.
//
// Split out of index.ts for the reason send-notification's `deps.ts` and
// `push_deps.ts` were: importing an `index.ts` executes `serveFunction` and
// binds a port, so nothing in it can be driven by a test. `handler.ts`
// carries the rules; this file carries what a recorded deps double
// structurally cannot see — the `.select` string, the CONDITIONAL claim
// (`is("stripe_account_id", null)`: drop it and two concurrent starts each
// create an account and the loser overwrites the winner), the re-read whose
// answer wins, and each query's error becoming a throw. The re-read's throw
// is PR #92's fix for this function, and until this split it was asserted by
// the discarded-errors gate and driven by nothing.
// `connect_onboarding_deps_test.ts` drives THIS file.
import { HttpError } from "../_lib/http.ts";
import type { adminClient } from "../_lib/admin.ts";
import type { ConnectOnboardingDeps, PlatformConnectStripe } from "./handler.ts";

/**
 * Everything this wiring needs from the environment, READ BY THE CALLER.
 * `index.ts` does the `Deno.env` reads; this module takes values — CI runs
 * `deno test` with no permissions, so a module reading env at construction
 * cannot be constructed in a test.
 *
 * `stripe` is the CLIENT, not a thunk, the operator-billing precedent:
 * `status` still 500s without `STRIPE_SECRET_KEY` exactly as it did when the
 * client was built at the top of the request. Recorded, not changed.
 */
export interface ConnectOnboardingConfig {
  db: ReturnType<typeof adminClient>;
  stripe: PlatformConnectStripe;
  base: string;
}

export function makeConnectOnboardingDeps(cfg: ConnectOnboardingConfig): ConnectOnboardingDeps {
  const { db } = cfg;
  return {
    async getOperator(id) {
      const { data: row, error } = await db
        .from("operators")
        // Single string literal, not a concatenation: supabase-js infers the row
        // type from the literal, and a `+` expression degrades it to an error type.
        .select("id, email, business_name, stripe_account_id, stripe_charges_enabled, stripe_payouts_enabled, stripe_details_submitted")
        .eq("id", id)
        .maybeSingle();
      if (error) {
        throw new HttpError(500, "db_error", "operator lookup failed", error, {
          operator_id: id,
        });
      }
      return row;
    },

    async claimAccountId(operatorId, accountId) {
      const { error: uErr } = await db
        .from("operators")
        .update({
          stripe_account_id: accountId,
          stripe_account_connected_at: new Date().toISOString(),
        })
        .eq("id", operatorId)
        // Only claim the row if it is still unclaimed: two concurrent 'start'
        // calls would otherwise each create an account and the loser would
        // overwrite the winner.
        .is("stripe_account_id", null);
      if (uErr) {
        throw new HttpError(500, "db_error", "failed to persist the Stripe account", uErr, {
          operator_id: operatorId,
          stripe_account_id: accountId,
        });
      }

      // Re-read: if the conditional update matched nothing, another request won
      // the race and its account is the real one. Ours is an orphan — harmless,
      // because an account with no onboarding and no charges is inert.
      //
      // The re-read's error is INSPECTED (it used to be discarded): a failed
      // read here is not "nobody else claimed it", it is "we do not know which
      // account is real", and falling through to ours would return an onboarding
      // link for an account the row does not carry — an operator finishing
      // Stripe's forms on an orphan. Same idiom as operator-billing's customer
      // re-read.
      const { data: after, error: readErr } = await db
        .from("operators").select("stripe_account_id").eq("id", operatorId).maybeSingle();
      if (readErr) {
        throw new HttpError(500, "db_error", "account re-read failed", readErr, {
          operator_id: operatorId,
          stripe_account_id: accountId,
        });
      }
      return (after?.stripe_account_id as string | null) ?? accountId;
    },

    stripe: cfg.stripe,
    base: cfg.base,
  };
}
