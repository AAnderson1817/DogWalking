// operator-billing — POST, operator JWT (review H31).
//
// Mints the operator's own $49/month Sanpo subscription checkout, and the
// billing portal session to manage it. Platform account only: this is Sanpo
// charging the operator, so no call here carries `stripeAccount` — the
// mirror image of every client money path (review B5), asserted by
// operator_billing_test.ts.
import { HttpError, jsonOk, readJson, requireUser, serveFunction } from "../_lib/http.ts";
import { logServerError } from "../_lib/observe.ts";
import { adminClient } from "../_lib/admin.ts";
import { stripeClient } from "../_lib/stripe.ts";
import {
  type BillingBody,
  CHECKOUT_MINT_LEASE_MS,
  handleOperatorBilling,
  type OperatorBillingDeps,
} from "./handler.ts";

const BILLING_COLUMNS =
  "id, email, business_name, trial_ends_at, platform_customer_id, platform_subscription_id, platform_subscription_status";

function makeDeps(): OperatorBillingDeps {
  const db = adminClient();
  return {
    async getOperator(id) {
      const { data, error } = await db
        .from("operators")
        .select(BILLING_COLUMNS)
        .eq("id", id)
        .maybeSingle();
      if (error) {
        throw new HttpError(500, "db_error", "operator lookup failed", error, {
          operator_id: id,
        });
      }
      return data;
    },

    async claimCustomerId(operatorId, customerId) {
      const { error } = await db
        .from("operators")
        .update({ platform_customer_id: customerId })
        .eq("id", operatorId)
        // Only claim while unclaimed: the loser of a concurrent race must
        // adopt the winner's customer, not overwrite it.
        .is("platform_customer_id", null);
      if (error) {
        throw new HttpError(500, "db_error", "failed to persist the Stripe customer", error, {
          operator_id: operatorId,
        });
      }
      const { data: after, error: readErr } = await db
        .from("operators")
        .select("platform_customer_id")
        .eq("id", operatorId)
        .maybeSingle();
      if (readErr) {
        throw new HttpError(500, "db_error", "customer re-read failed", readErr, {
          operator_id: operatorId,
        });
      }
      return (after?.platform_customer_id as string | null) ?? customerId;
    },

    async claimCheckoutMint(operatorId) {
      // Single-statement conditional UPDATE — the claimCustomerId idiom, as
      // a lease: atomic under PostgREST because the predicate runs inside
      // the UPDATE itself. An expired lease (a crashed mint) is claimable.
      const cutoff = new Date(Date.now() - CHECKOUT_MINT_LEASE_MS).toISOString();
      const { data, error } = await db
        .from("operators")
        .update({ checkout_mint_claimed_at: new Date().toISOString() })
        .eq("id", operatorId)
        .or(`checkout_mint_claimed_at.is.null,checkout_mint_claimed_at.lt.${cutoff}`)
        .select("id");
      if (error) {
        throw new HttpError(500, "db_error", "checkout claim failed", error, {
          operator_id: operatorId,
        });
      }
      return (data?.length ?? 0) > 0;
    },

    async releaseCheckoutMint(operatorId) {
      // Best-effort by contract: a failed release must not turn a minted
      // session into a 500, so it logs and returns — the lease expiry is
      // the backstop that unblocks the next attempt.
      const { error } = await db
        .from("operators")
        .update({ checkout_mint_claimed_at: null })
        .eq("id", operatorId);
      if (error) {
        logServerError({
          fn: "operator-billing",
          request_id: "",
          status: 500,
          code: "mint_release_failed",
          message: "checkout mint release failed; the lease will expire on its own",
          cause: error,
          context: { operator_id: operatorId },
        });
      }
    },

    stripe: stripeClient(),
    base: Deno.env.get("APP_BASE_URL") ?? "http://localhost:5173",
    now: () => Date.now(),
  };
}

serveFunction(async (req) => {
  const user = await requireUser(req);
  const body = await readJson<BillingBody>(req);
  return jsonOk(await handleOperatorBilling(user.id, body, makeDeps()));
});
