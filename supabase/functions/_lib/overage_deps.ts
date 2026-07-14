// Real (Supabase + Stripe) wiring for chargeOverageForWalk — shared by
// charge-overage and complete-walk (in-process invocation, spec 04).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type Stripe from "npm:stripe@17";
import type { OverageDeps, OveragePayment } from "./overage.ts";

const PAYMENT_COLS =
  "id, walk_id, type, amount_pence, status, stripe_payment_intent_id, receipt_url, created_at";

export function makeOverageDeps(db: SupabaseClient, stripe: Stripe): OverageDeps {
  return {
    async getWalk(id) {
      const { data, error } = await db
        .from("walks")
        .select("id, operator_id, client_id, status, is_overage")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error("walk lookup failed");
      return data;
    },

    async getLiveOveragePayment(walkId) {
      // A succeeded OR in-flight (pending) charge blocks new attempts; only
      // 'failed' rows leave the walk chargeable again.
      const { data, error } = await db
        .from("payments")
        .select(PAYMENT_COLS)
        .eq("walk_id", walkId)
        .eq("type", "overage")
        .in("status", ["succeeded", "pending"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error("payment lookup failed");
      return data as OveragePayment | null;
    },

    async retrievePaymentIntent(piId) {
      const pi = await stripe.paymentIntents.retrieve(piId, { expand: ["latest_charge"] });
      const charge = pi.latest_charge as Stripe.Charge | null;
      return {
        status: pi.status,
        receipt_url: charge && typeof charge !== "string" ? charge.receipt_url : null,
      };
    },

    async getClientBilling(clientId) {
      const { data, error } = await db
        .from("clients")
        .select("full_name, stripe_customer_id, plan:plans(overage_rate_pence)")
        .eq("id", clientId)
        .maybeSingle();
      if (error) throw new Error("client lookup failed");
      if (!data) return null;
      const plan = Array.isArray(data.plan) ? data.plan[0] ?? null : data.plan;
      return {
        full_name: data.full_name,
        stripe_customer_id: data.stripe_customer_id,
        plan,
      };
    },

    async createOffSessionPaymentIntent({ customerId, amountPence, walkId, clientId, attemptKey }) {
      // Resolve a chargeable payment method: the customer default, else the
      // first card on file.
      const customer = await stripe.customers.retrieve(customerId);
      let paymentMethod =
        (customer as Stripe.Customer).invoice_settings?.default_payment_method as
          | string
          | null;
      if (!paymentMethod) {
        const methods = await stripe.paymentMethods.list({
          customer: customerId,
          type: "card",
          limit: 1,
        });
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
          description: "PawTrail walk (overage)",
          metadata: { walk_id: walkId, client_id: clientId },
          expand: ["latest_charge"],
        },
        // Per-attempt key: a crash-retry of THIS attempt replays; a new
        // attempt (fresh claim row) gets a new key. A fixed per-walk key
        // would replay a stored decline for ~24h and brick the re-charge.
        { idempotencyKey: attemptKey },
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
