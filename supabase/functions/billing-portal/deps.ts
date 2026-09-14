// billing-portal WIRING: the part that reaches the database and Stripe.
//
// Split out of index.ts for the reason send-notification's `deps.ts` and
// `push_deps.ts` were: importing an `index.ts` executes `serveFunction` and
// binds a port, so nothing in it can be driven by a test. `handler.ts`
// carries the rules; this file carries what a recorded deps double
// structurally cannot see — the `.select` string, the filter on the caller,
// the embed handed through as ONE object, a failed lookup becoming a throw,
// and the Stripe call forwarding its per-request options. Drop `opts` from
// that call and every portal session is created on the PLATFORM account,
// where the customer does not exist (review B5) — and `billing_portal_test.ts`,
// which records the double, stays green. `billing_portal_deps_test.ts`
// drives THIS file.
import { type ConnectFields, HttpError } from "../_lib/http.ts";
import type { adminClient } from "../_lib/admin.ts";
import type { BillingPortalDeps } from "./handler.ts";

/** The slice of the Stripe SDK this wiring touches, parameter-typed so the
 * REAL client is assignable without a cast (a cast would hide exactly the
 * drift a type is for). */
export interface PortalStripe {
  billingPortal: {
    sessions: {
      create(
        params: { customer: string; return_url: string },
        opts: { stripeAccount: string },
      ): Promise<{ url: string }>;
    };
  };
}

/**
 * Everything this wiring needs from the environment, READ BY THE CALLER.
 * `index.ts` does the `Deno.env` reads; this module takes values — CI runs
 * `deno test` with no permissions, so a module reading env at construction
 * cannot be constructed in a test.
 *
 * `stripe` is a THUNK, not a client. It is resolved inside
 * `createPortalSession`, after the handler's refusals have run, so a missing
 * `STRIPE_SECRET_KEY` cannot turn `not_client` or `no_billing` into a 500 —
 * the shipped ordering, kept, and pinned by the deps test.
 */
export interface BillingPortalConfig {
  db: ReturnType<typeof adminClient>;
  stripe: () => PortalStripe;
  base: string;
}

export function makeBillingPortalDeps(cfg: BillingPortalConfig): BillingPortalDeps {
  const { db } = cfg;
  return {
    async getClientForUser(authUserId) {
      // The operator's Connect state comes back with the client: the Stripe
      // customer lives on the OPERATOR's account (review B5), so a portal
      // session created on the platform account would 404 on a customer id
      // that looks perfectly valid.
      const { data: client, error } = await db
        .from("clients")
        .select("id, stripe_customer_id, operator:operators!clients_operator_id_fkey(stripe_account_id, stripe_charges_enabled)")
        .eq("auth_user_id", authUserId)
        .maybeSingle();
      // A THROW, not a null: supabase-js reports a failed query in the
      // RESOLVED result, and absence is a 403 the caller decides on.
      if (error) {
        throw new HttpError(500, "db_error", "client lookup failed", error, {
          auth_user_id: authUserId,
        });
      }
      if (!client) return null;
      return {
        id: client.id,
        stripe_customer_id: client.stripe_customer_id,
        // PostgREST returns a many-to-one embed as ONE object. The admin client
        // is untyped (no Database generic), so supabase-js cannot see the FK's
        // cardinality and infers an ARRAY here — this is the one place the
        // row's shape is asserted rather than inferred, the cast the shipped
        // code carried beside its accountOf() call.
        operator: client.operator as unknown as ConnectFields,
      };
    },
    createPortalSession(params, opts) {
      // Resolved here, not at construction: see `BillingPortalConfig.stripe`.
      // Both arguments are forwarded — the second is what puts the session
      // on the connected account.
      return cfg.stripe().billingPortal.sessions.create(params, opts);
    },
    base: cfg.base,
  };
}
