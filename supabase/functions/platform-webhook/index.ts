// platform-webhook — POST from Stripe, PLATFORM account ("Your account"
// endpoint; review H31). verify_jwt = false in supabase/config.toml;
// authenticity comes from the signature header, verified against its OWN
// secret — STRIPE_PLATFORM_WEBHOOK_SECRET, never the Connect endpoint's.
//
// Same bare Deno.serve shape as stripe-webhook, for the same reasons: raw
// text body for the signature, and a 409 for a live claim so Stripe keeps
// retrying instead of acking an event whose effects may still fail.
// 200 on processed/ignored/duplicate; 400 only on bad signature/payload;
// 500 on effect failure (the claim stays 'processing' and the next retry
// takes over after the lease).
import { corsHeaders } from "../_lib/http.ts";
import { logServerError, requestId } from "../_lib/observe.ts";
import { adminClient } from "../_lib/admin.ts";
import { verifyStripeSignature } from "../_lib/stripe.ts";
import {
  handlePlatformEvent,
  InFlightError,
  type PlatformEventLike,
  type PlatformWebhookDeps,
} from "./handler.ts";

/** Same lease as stripe-webhook: a 'processing' claim older than this is
 * considered crashed and is taken over by the next delivery. */
const CLAIM_LEASE_MS = 5 * 60_000;

function makeDeps(): PlatformWebhookDeps {
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
      if ((data?.length ?? 0) > 0) return "fresh";

      const { data: existing, error: readErr } = await db
        .from("stripe_events")
        .select("status, claimed_at")
        .eq("id", id)
        .maybeSingle();
      if (readErr || !existing) throw new Error("stripe_events read failed", { cause: readErr });
      if (existing.status === "processed") return "duplicate";

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

    async findOperatorBySubscription(subscriptionId) {
      const { data, error } = await db
        .from("operators")
        .select("id, platform_subscription_id")
        .eq("platform_subscription_id", subscriptionId)
        .maybeSingle();
      if (error) throw new Error("operator lookup failed", { cause: error });
      return data;
    },

    async findOperatorByCustomer(customerId) {
      const { data, error } = await db
        .from("operators")
        .select("id, platform_subscription_id")
        .eq("platform_customer_id", customerId)
        .maybeSingle();
      if (error) throw new Error("operator lookup failed", { cause: error });
      return data;
    },

    async updateOperator(id, fields, unlessStatus) {
      let query = db.from("operators").update(fields).eq("id", id);
      if (unlessStatus) {
        query = query.neq("platform_subscription_status", unlessStatus);
      }
      const { data, error } = await query.select("id");
      if (error) throw new Error("operator update failed", { cause: error });
      return data?.length ?? 0;
    },

    async insertNotification(row) {
      const { error } = await db.from("notifications").insert(row);
      if (error) throw new Error("notification insert failed", { cause: error });
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

  const secret = Deno.env.get("STRIPE_PLATFORM_WEBHOOK_SECRET");
  if (!secret) {
    console.error("STRIPE_PLATFORM_WEBHOOK_SECRET is not configured");
    return new Response("misconfigured", { status: 500 });
  }

  const payload = await req.text();
  const ok = await verifyStripeSignature(payload, req.headers.get("stripe-signature"), secret);
  if (!ok) return new Response("bad signature", { status: 400 });

  let event: PlatformEventLike;
  try {
    event = JSON.parse(payload) as PlatformEventLike;
  } catch {
    return new Response("bad payload", { status: 400 });
  }
  if (!event?.id || !event?.type || !event?.data?.object) {
    return new Response("bad payload", { status: 400 });
  }

  const reqId = requestId(req);
  try {
    const result = await handlePlatformEvent(event, makeDeps());
    return Response.json({ received: true, status: result.status }, {
      headers: { "x-request-id": reqId },
    });
  } catch (e) {
    if (e instanceof InFlightError) {
      return new Response("in flight", { status: 409 });
    }
    logServerError({
      fn: "platform-webhook",
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
