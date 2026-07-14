// stripe-webhook — POST from Stripe (spec 04). verify_jwt = false in
// supabase/config.toml; authenticity comes from the signature header.
// 200 on processed/ignored/duplicate; 409 while another delivery's claim is
// in flight (Stripe retries); 400 only on bad signature; 500 on effect
// failure (the claim stays 'processing' and the next retry takes over after
// the lease).
import { corsHeaders } from "../_lib/http.ts";
import { adminClient } from "../_lib/admin.ts";
import { verifyStripeSignature } from "../_lib/stripe.ts";
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
      if (error) throw new Error("stripe_events claim failed");
      if ((data?.length ?? 0) > 0) return "fresh"; // we inserted the claim

      // Conflict: inspect the existing claim.
      const { data: existing, error: readErr } = await db
        .from("stripe_events")
        .select("status, claimed_at")
        .eq("id", id)
        .maybeSingle();
      if (readErr || !existing) throw new Error("stripe_events read failed");
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
      if (takeErr) throw new Error("stripe_events takeover failed");
      return (taken?.length ?? 0) > 0 ? "fresh" : "in_flight";
    },

    async markProcessed(id) {
      const { error } = await db
        .from("stripe_events")
        .update({ status: "processed", processed_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw new Error("stripe_events mark-processed failed");
    },

    async findClientByCustomer(customerId) {
      if (!customerId) return null;
      const { data, error } = await db
        .from("clients")
        .select("id, operator_id, full_name, plan_id, subscription_status, stripe_subscription_id")
        .eq("stripe_customer_id", customerId)
        .maybeSingle();
      if (error) throw new Error("client lookup failed");
      return data;
    },

    async getPlan(planId) {
      const { data, error } = await db
        .from("plans")
        .select("id, credits_per_cycle, stripe_price_id")
        .eq("id", planId)
        .maybeSingle();
      if (error) throw new Error("plan lookup failed");
      return data;
    },

    async findPlanByPriceId(operatorId, priceId) {
      const { data, error } = await db
        .from("plans")
        .select("id, credits_per_cycle, stripe_price_id")
        .eq("operator_id", operatorId)
        .eq("stripe_price_id", priceId)
        .maybeSingle();
      if (error) throw new Error("plan lookup failed");
      return data;
    },

    async updateClient(id, fields) {
      const { error } = await db.from("clients").update(fields).eq("id", id);
      if (error) throw new Error("client update failed");
    },

    async applyInvoicePaid({ clientId, credits, invoiceId, amountPence, currency, receiptUrl }) {
      const { data, error } = await db.rpc("fn_apply_invoice_paid", {
        p_client: clientId,
        p_credits: credits,
        p_invoice_id: invoiceId,
        p_amount_pence: amountPence,
        p_currency: currency,
        p_receipt_url: receiptUrl,
      });
      if (error) throw new Error("invoice effects failed");
      return Boolean(data);
    },

    async hasPaymentForInvoice(invoiceId) {
      const { data, error } = await db
        .from("payments")
        .select("id")
        .eq("stripe_invoice_id", invoiceId)
        .limit(1);
      if (error) throw new Error("payment lookup failed");
      return (data?.length ?? 0) > 0;
    },

    async insertPayment(row) {
      const { error } = await db.from("payments").insert(row);
      if (error) throw new Error("payment insert failed");
    },

    async insertNotification(row) {
      const { error } = await db.from("notifications").insert(row);
      if (error) throw new Error("notification insert failed");
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

  try {
    const result = await handleStripeEvent(event, makeDeps());
    return Response.json({ received: true, status: result.status });
  } catch (e) {
    if (e instanceof InFlightError) {
      // Another delivery holds a live claim — do NOT ack; Stripe retries.
      return new Response("in flight", { status: 409 });
    }
    // Signal Stripe to retry: our side failed, not the sender. The claim
    // stays 'processing' and the retry takes it over after the lease.
    console.error("webhook processing error:", e instanceof Error ? e.message : "unknown");
    return new Response("processing error", { status: 500 });
  }
});
