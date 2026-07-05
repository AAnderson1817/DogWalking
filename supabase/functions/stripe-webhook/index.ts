// stripe-webhook — POST from Stripe (spec 04). verify_jwt = false in
// supabase/config.toml; authenticity comes from the signature header.
// Always 200 on handled/ignored/duplicate events; 400 only on bad signature.
import { corsHeaders } from "../_lib/http.ts";
import { adminClient } from "../_lib/admin.ts";
import { verifyStripeSignature } from "../_lib/stripe.ts";
import { handleStripeEvent, type StripeEventLike, type WebhookDeps } from "./handler.ts";

function makeDeps(): WebhookDeps {
  const db = adminClient();
  return {
    async recordEvent(id, type, payload) {
      const { data, error } = await db
        .from("stripe_events")
        .upsert({ id, type, payload }, { onConflict: "id", ignoreDuplicates: true })
        .select("id");
      if (error) throw new Error("stripe_events insert failed");
      return (data?.length ?? 0) > 0; // [] ⇒ conflict ⇒ duplicate
    },
    async findClientByCustomer(customerId) {
      if (!customerId) return null;
      const { data, error } = await db
        .from("clients")
        .select("id, operator_id, full_name, plan_id, subscription_status")
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
    async applyRollover(clientId) {
      const { error } = await db.rpc("fn_apply_rollover", { p_client: clientId });
      if (error) throw new Error("rollover failed");
    },
    async grantCredits(clientId, amount, note) {
      const { error } = await db.rpc("fn_grant_credits", {
        p_client: clientId,
        p_amount: amount,
        p_note: note,
      });
      if (error) throw new Error("grant failed");
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
    // Signal Stripe to retry: our side failed, not the sender.
    console.error("webhook processing error:", e instanceof Error ? e.message : "unknown");
    return new Response("processing error", { status: 500 });
  }
});
