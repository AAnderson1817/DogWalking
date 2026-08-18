// stripe-webhook — POST from Stripe (spec 04). verify_jwt = false in
// supabase/config.toml; authenticity comes from the signature header.
// 200 on processed/ignored/duplicate; 409 while another delivery's claim is
// in flight (Stripe retries); 400 only on bad signature; 500 on effect
// failure (the claim stays 'processing' and the next retry takes over after
// the lease).
import { corsHeaders } from "../_lib/http.ts";
import { logServerError, requestId } from "../_lib/observe.ts";
import { adminClient } from "../_lib/admin.ts";
import { verifyStripeSignature } from "../_lib/stripe.ts";
import { SUBSCRIPTION_INVOICE_STATUSES } from "../_lib/payment_status.ts";
import {
  handleStripeEvent,
  InFlightError,
  type StripeEventLike,
  type WebhookDeps,
} from "./handler.ts";

/** A 'processing' claim older than this is considered crashed and is taken
 * over by the next delivery. Edge functions cap out well below this. */
const CLAIM_LEASE_MS = 5 * 60_000;

function makeDeps(): WebhookDeps {
  const db = adminClient();
  return {
    async claimEvent(id, type, payload) {
      const { data, error } = await db
        .from("stripe_events")
        .upsert(
          { id, type, payload, status: "processing", claimed_at: new Date().toISOString() },
          { onConflict: "id", ignoreDuplicates: true },
        )
        .select("id");
      if (error) throw new Error("stripe_events claim failed", { cause: error });
      if ((data?.length ?? 0) > 0) return "fresh"; // we inserted the claim

      // Conflict: inspect the existing claim.
      const { data: existing, error: readErr } = await db
        .from("stripe_events")
        .select("status, claimed_at")
        .eq("id", id)
        .maybeSingle();
      if (readErr || !existing) throw new Error("stripe_events read failed", { cause: readErr });
      if (existing.status === "processed") return "duplicate";

      // 'processing': take over only if the claim is stale (crashed
      // attempt). The conditional UPDATE makes takeover race-safe — exactly
      // one contender sees a row updated.
      const cutoff = new Date(Date.now() - CLAIM_LEASE_MS).toISOString();
      const { data: taken, error: takeErr } = await db
        .from("stripe_events")
        .update({ claimed_at: new Date().toISOString() })
        .eq("id", id)
        .eq("status", "processing")
        .lt("claimed_at", cutoff)
        .select("id");
      if (takeErr) throw new Error("stripe_events takeover failed", { cause: takeErr });
      return (taken?.length ?? 0) > 0 ? "fresh" : "in_flight";
    },

    async markProcessed(id) {
      const { error } = await db
        .from("stripe_events")
        .update({ status: "processed", processed_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw new Error("stripe_events mark-processed failed", { cause: error });
    },

    async findClientByCustomer(customerId, operatorId) {
      if (!customerId) return null;
      const { data, error } = await db
        .from("clients")
        .select("id, operator_id, full_name, plan_id, subscription_status, stripe_subscription_id")
        .eq("stripe_customer_id", customerId)
        .eq("operator_id", operatorId)
        .maybeSingle();
      if (error) throw new Error("client lookup failed", { cause: error });
      return data;
    },

    async getPlan(planId) {
      const { data, error } = await db
        .from("plans")
        .select("id, credits_per_cycle, stripe_price_id")
        .eq("id", planId)
        .maybeSingle();
      if (error) throw new Error("plan lookup failed", { cause: error });
      return data;
    },

    async findPlanByPriceId(operatorId, priceId) {
      const { data, error } = await db
        .from("plans")
        .select("id, credits_per_cycle, stripe_price_id")
        .eq("operator_id", operatorId)
        .eq("stripe_price_id", priceId)
        .maybeSingle();
      if (error) throw new Error("plan lookup failed", { cause: error });
      return data;
    },

    async updateClient(id, fields, operatorId) {
      // Both predicates. The operator id comes from event.account, which
      // Stripe sets; the client id comes from session metadata, which the
      // connected account controls. Only the first is an authorization.
      const { data, error } = await db
        .from("clients")
        .update(fields)
        .eq("id", id)
        .eq("operator_id", operatorId)
        .select("id");
      if (error) throw new Error("client update failed", { cause: error });
      return data?.length ?? 0;
    },

    async findPendingPlanChangeIntent({ clientId, subscriptionId, planId, metadataIntentId }) {
      let query = db
        .from("plan_change_intents")
        .select("id, new_plan_id")
        .eq("client_id", clientId)
        .eq("status", "pending")
        .order("requested_at", { ascending: false })
        .limit(1);
      if (metadataIntentId) {
        query = query.eq("id", metadataIntentId);
      } else if (subscriptionId && planId) {
        query = query.eq("stripe_subscription_id", subscriptionId).eq("new_plan_id", planId);
      } else {
        // Without an exact metadata id or a sub+plan proof, never guess —
        // the handler pre-filters this, but keep the query fail-safe too.
        return null;
      }
      const { data, error } = await query.maybeSingle();
      if (error) throw new Error("plan-change intent lookup failed", { cause: error });
      return data;
    },

    async applyPlanChangeIntent(intentId, eventId) {
      const { data, error } = await db.rpc("fn_apply_plan_change_intent", {
        p_intent: intentId,
        p_event_id: eventId,
      });
      if (error) throw new Error("plan-change intent apply failed", { cause: error });
      return Number(data);
    },

    async applyInvoicePaid(
      { clientId, credits, invoiceId, amountPence, currency, receiptUrl, isRenewal },
    ) {
      const { data, error } = await db.rpc("fn_apply_invoice_paid", {
        p_client: clientId,
        p_credits: credits,
        p_invoice_id: invoiceId,
        p_amount_pence: amountPence,
        p_currency: currency,
        p_receipt_url: receiptUrl,
        p_is_renewal: isRenewal,
      });
      if (error) throw new Error("invoice effects failed", { cause: error });
      return Boolean(data);
    },

    async hasPaymentForInvoice(invoiceId) {
      // Only rows that represent money actually taken. Without the status
      // predicate a 'failed' row from invoice.payment_failed made this true,
      // so the succeeded row for the SAME invoice was never written — and a
      // later refund then found nothing (findPaymentForReversal excludes
      // 'failed') and landed in reversal_needs_review instead of clawing back.
      // fn_apply_invoice_paid has always filtered this way (0023); this is the
      // non-cycle branch catching up to the same index.
      const { data, error } = await db
        .from("payments")
        .select("id")
        .eq("stripe_invoice_id", invoiceId)
        .in("status", [...SUBSCRIPTION_INVOICE_STATUSES])
        .limit(1);
      if (error) throw new Error("payment lookup failed", { cause: error });
      return (data?.length ?? 0) > 0;
    },

    async hasFailedPaymentForInvoice(invoiceId) {
      const { data, error } = await db
        .from("payments")
        .select("id")
        .eq("stripe_invoice_id", invoiceId)
        .eq("status", "failed")
        .limit(1);
      if (error) throw new Error("payment lookup failed", { cause: error });
      return (data?.length ?? 0) > 0;
    },

    async insertPayment(row) {
      const { error } = await db.from("payments").insert(row);
      if (error) throw new Error("payment insert failed", { cause: error });
    },

    async resolveOperatorByAccount(accountId) {
      const { data, error } = await db
        .from("operators")
        .select("id")
        .eq("stripe_account_id", accountId)
        .maybeSingle();
      if (error) throw new Error("operator lookup failed", { cause: error });
      return data?.id ?? null;
    },

    async updateConnectState(accountId, fields) {
      const { error } = await db
        .from("operators")
        .update(fields)
        .eq("stripe_account_id", accountId);
      if (error) throw new Error("connect state update failed", { cause: error });
    },

    async insertNotification(row) {
      const { error } = await db.from("notifications").insert(row);
      if (error) throw new Error("notification insert failed", { cause: error });
    },

    async findPaymentForReversal({ paymentIntentId, invoiceId, chargeId, operatorId }) {
      const cols = "id, operator_id, client_id, type, amount_pence, status, stripe_charge_id";
      // Ordered by how specific the identifier is. The payment intent points
      // at one charge; the invoice can carry a failed row alongside the paid
      // one, so that lookup excludes 'failed' rather than taking whichever
      // row Postgres happened to return first.
      const attempts: Array<[string, string | null | undefined]> = [
        ["stripe_payment_intent_id", paymentIntentId],
        ["stripe_charge_id", chargeId],
        ["stripe_invoice_id", invoiceId],
      ];
      for (const [col, val] of attempts) {
        if (!val) continue;
        const { data, error } = await db
          .from("payments")
          .select(cols)
          .eq(col, val)
          .eq("operator_id", operatorId)
          .neq("status", "failed")
          .limit(1);
        if (error) throw new Error("payment lookup failed", { cause: error });
        if (data?.length) return data[0] as never;
      }
      return null;
    },

    async reversePayment({ paymentId, kind, amountPence, reason }) {
      const { data, error } = await db.rpc("fn_reverse_payment", {
        p_payment: paymentId,
        p_kind: kind,
        p_amount_pence: amountPence,
        p_reason: reason,
      });
      if (error) throw new Error("payment reversal failed", { cause: error });
      const row = Array.isArray(data) ? data[0] : data;
      // No error object: fn_reverse_payment succeeded and returned nothing,
      // which should be impossible. The absence is the finding.
      if (!row) {
        throw new Error("payment reversal returned nothing", {
          cause: `fn_reverse_payment returned no row for payment ${paymentId}`,
        });
      }
      return row as never;
    },

    async noteChargeId(paymentId, chargeId) {
      const { error } = await db
        .from("payments")
        .update({ stripe_charge_id: chargeId })
        .eq("id", paymentId);
      if (error) throw new Error("charge id write failed", { cause: error });
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) {
    console.error("STRIPE_WEBHOOK_SECRET is not configured");
    return new Response("misconfigured", { status: 500 });
  }

  const payload = await req.text();
  const ok = await verifyStripeSignature(payload, req.headers.get("stripe-signature"), secret);
  if (!ok) return new Response("bad signature", { status: 400 });

  let event: StripeEventLike;
  try {
    event = JSON.parse(payload) as StripeEventLike;
  } catch {
    return new Response("bad payload", { status: 400 });
  }
  if (!event?.id || !event?.type || !event?.data?.object) {
    return new Response("bad payload", { status: 400 });
  }

  // This function does not use serveFunction: it needs verify_jwt=false, bare
  // text bodies, and its own 409 for a live claim. So it logs through the same
  // helper directly, rather than growing a second log format for the one money
  // path with the most moving parts.
  const reqId = requestId(req);
  try {
    const result = await handleStripeEvent(event, makeDeps());
    return Response.json({ received: true, status: result.status }, {
      headers: { "x-request-id": reqId },
    });
  } catch (e) {
    if (e instanceof InFlightError) {
      // Another delivery holds a live claim — do NOT ack; Stripe retries.
      return new Response("in flight", { status: 409 });
    }
    // Signal Stripe to retry: our side failed, not the sender. The claim
    // stays 'processing' and the retry takes it over after the lease.
    //
    // The event id and type are the whole point of this line. Stripe redelivers
    // for three days, so "which event failed, repeatedly" is the question, and
    // `e.message` alone — all the old line recorded — could not answer it.
    logServerError({
      fn: "stripe-webhook",
      request_id: reqId,
      status: 500,
      code: "webhook_failed",
      message: "webhook processing error",
      cause: e,
      context: { stripe_event_id: event.id, stripe_event_type: event.type },
    });
    return new Response("processing error", { status: 500 });
  }
});
