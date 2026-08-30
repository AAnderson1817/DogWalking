// Real (Supabase + Stripe) wiring for chargeOverageForWalk — shared by
// charge-overage and complete-walk (in-process invocation, spec 04).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type Stripe from "npm:stripe@17";
import type { OverageDeps, OveragePayment } from "./overage.ts";
import { OVERAGE_CLAIM_STATUSES } from "./payment_status.ts";

const PAYMENT_COLS =
  "id, walk_id, type, amount_pence, status, stripe_payment_intent_id, receipt_url, created_at";

/**
 * `resolveAccount` is required and is a THUNK (review B5). Required, because
 * the operator is the merchant of record: the customer, the saved card and the
 * PaymentIntent all live on THEIR connected account, and a call without it
 * reaches the platform account where the customer id does not exist — failing
 * as "no payment method on file" rather than as a misrouted charge. A thunk,
 * because a credit-funded walk never charges anything, and resolving eagerly
 * would stop an un-connected operator completing any walk at all.
 */
export function makeOverageDeps(
  db: SupabaseClient,
  stripe: Stripe,
  resolveAccount: () => { stripeAccount: string },
): OverageDeps {
  return {
    resolveAccount,
    async getWalk(id) {
      // The two snapshot columns are the price source (H32): what was agreed
      // when the walk was created, never what the tables say now.
      const { data, error } = await db
        .from("walks")
        .select("id, operator_id, client_id, status, is_overage, overage_rate_pence, visit_price_pence")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error("walk lookup failed");
      return data;
    },

    async getLiveOveragePayment(walkId) {
      // Whatever uq_overage_payment_per_walk covers, and nothing else. This
      // read filtered on succeeded/pending only, while 0023 widened the index
      // to include refunded/disputed — so a walk whose overage had been
      // refunded returned null here, fell through to the claim insert, hit the
      // index, and surfaced to the operator as the literal words "internal
      // error". A declined card still leaves the walk re-chargeable, because
      // 'failed' is in neither set.
      const { data, error } = await db
        .from("payments")
        .select(PAYMENT_COLS)
        .eq("walk_id", walkId)
        .eq("type", "overage")
        .in("status", [...OVERAGE_CLAIM_STATUSES])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error("payment lookup failed");
      return data as OveragePayment | null;
    },

    async retrievePaymentIntent(piId) {
      const pi = await stripe.paymentIntents.retrieve(
        piId,
        { expand: ["latest_charge"] },
        resolveAccount(),
      );
      const charge = pi.latest_charge as Stripe.Charge | null;
      return {
        status: pi.status,
        receipt_url: charge && typeof charge !== "string" ? charge.receipt_url : null,
      };
    },

    async getClientBilling(clientId) {
      const { data, error } = await db
        .from("clients")
        .select("full_name, stripe_customer_id, subscription_status, plan:plans(overage_rate_pence)")
        .eq("id", clientId)
        .maybeSingle();
      if (error) throw new Error("client lookup failed");
      if (!data) return null;
      const plan = Array.isArray(data.plan) ? data.plan[0] ?? null : data.plan;
      return {
        full_name: data.full_name,
        stripe_customer_id: data.stripe_customer_id,
        subscription_status: data.subscription_status,
        plan,
      };
    },

    async createOffSessionPaymentIntent(
      { customerId, amountPence, walkId, clientId, attemptKey, pricing },
    ) {
      // Resolve a chargeable payment method: the customer default, else the
      // first card on file.
      //
      // On the connected account, like every other call here. The customer was
      // created there (create-checkout), so a platform lookup raises
      // resource_missing — which isCardError does not match, so it rethrows,
      // complete-walk 500s, and the pending claim inserted moments earlier
      // makes the operator's retry return already_charged for money never
      // taken. This shipped unrouted in #34 while the paymentMethods.list four
      // lines below it was routed.
      const customer = await stripe.customers.retrieve(customerId, resolveAccount());
      let paymentMethod =
        (customer as Stripe.Customer).invoice_settings?.default_payment_method as
          | string
          | null;
      if (!paymentMethod) {
        const methods = await stripe.paymentMethods.list({
          customer: customerId,
          type: "card",
          limit: 1,
        }, resolveAccount());
        paymentMethod = methods.data[0]?.id ?? null;
      }
      if (!paymentMethod) throw new Error("no payment method on file");

      const pi = await stripe.paymentIntents.create(
        {
          amount: amountPence,
          currency: "usd",
          customer: customerId,
          payment_method: paymentMethod,
          off_session: true,
          confirm: true,
          // On the client's statement/receipt. "Overage" on a pay-per-visit
          // client's charge would name a plan they are not on.
          description: pricing === "visit_price"
            ? "Sanpo walk (per-visit)"
            : "Sanpo walk (overage)",
          metadata: { walk_id: walkId, client_id: clientId },
          expand: ["latest_charge"],
        },
        // Per-attempt key: a crash-retry of THIS attempt replays; a new
        // attempt (fresh claim row) gets a new key. A fixed per-walk key
        // would replay a stored decline for ~24h and brick the re-charge.
        // Stripe scopes idempotency keys per account, so the key keeps its
        // meaning on the connected account.
        { idempotencyKey: attemptKey, ...resolveAccount() },
      );
      const charge = pi.latest_charge as Stripe.Charge | null;
      return {
        id: pi.id,
        status: pi.status,
        receipt_url: charge && typeof charge !== "string" ? charge.receipt_url : null,
      };
    },

    async insertPayment(row) {
      const { data, error } = await db
        .from("payments")
        .insert(row)
        .select(PAYMENT_COLS)
        .single();
      if (error) throw new Error("payment insert failed");
      return data as OveragePayment;
    },

    async updatePayment(id, fields) {
      const { data, error } = await db
        .from("payments")
        .update(fields)
        .eq("id", id)
        .select(PAYMENT_COLS)
        .single();
      if (error) throw new Error("payment update failed");
      return data as OveragePayment;
    },

    async insertNotification(row) {
      const { error } = await db.from("notifications").insert(row);
      if (error) throw new Error("notification insert failed");
    },

    isPermanentError(err) {
      const e = err as { type?: string; code?: string; message?: string } | null;
      return e?.type === "StripeInvalidRequestError" ||
        e?.code === "resource_missing" ||
        e?.message === "no payment method on file";
    },

    isCardError(err) {
      const e = err as { type?: string; code?: string } | null;
      return e?.type === "StripeCardError" ||
        e?.code === "card_declined" ||
        e?.code === "authentication_required" ||
        e?.code === "expired_card" ||
        e?.code === "incorrect_cvc" ||
        e?.code === "insufficient_funds";
    },
  };
}
