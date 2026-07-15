// change-plan — POST, operator JWT (spec 04, built in phase 07).
// Stripe prorates the money (proration_behavior=create_prorations). For live
// Stripe subscriptions, this function saves a plan-change intent first and the
// customer.subscription.updated webhook finalizes the local plan/credit effect.
// For clients without a live Stripe subscription (manual/local billing), an
// explicit body.fraction drives the credit proration directly.
import { jsonOk, readJson, requireOperator, serveFunction, HttpError } from "../_lib/http.ts";
import { adminClient } from "../_lib/admin.ts";
import { stripeClient } from "../_lib/stripe.ts";

interface Body {
  client_id?: string;
  new_plan_id?: string;
  /** Manual-mode proration fraction [0,1]; ignored when a Stripe subscription exists. */
  fraction?: number;
}

serveFunction(async (req) => {
  const operator = await requireOperator(req);
  const body = await readJson<Body>(req);
  if (!body?.client_id || !body.new_plan_id) {
    throw new HttpError(400, "bad_request", "client_id and new_plan_id are required");
  }

  const db = adminClient();

  const { data: client, error: cErr } = await db
    .from("clients")
    .select("id, operator_id, plan_id, stripe_subscription_id, credit_balance")
    .eq("id", body.client_id)
    .maybeSingle();
  if (cErr) throw new HttpError(500, "db_error", "client lookup failed");
  if (!client || client.operator_id !== operator.id) {
    throw new HttpError(404, "client_not_found", "client not found");
  }

  const { data: plan, error: pErr } = await db
    .from("plans")
    .select("id, operator_id, name, stripe_price_id, credits_per_cycle, price_pence, cycle, overage_rate_pence")
    .eq("id", body.new_plan_id)
    .maybeSingle();
  if (pErr) throw new HttpError(500, "db_error", "plan lookup failed");
  if (!plan || plan.operator_id !== operator.id) {
    throw new HttpError(404, "plan_not_found", "plan not found");
  }

  let fraction: number;

  if (client.stripe_subscription_id) {
    if (!plan.stripe_price_id) {
      throw new HttpError(409, "plan_unpriced", "plan has no stripe_price_id configured");
    }
    const stripe = stripeClient();
    const sub = await stripe.subscriptions.retrieve(client.stripe_subscription_id);
    const item = sub.items.data[0];
    if (!item) throw new HttpError(409, "no_subscription_item", "subscription has no items");

    // Remaining fraction of the current period drives the credit proration.
    // Newer Stripe API versions carry the period on the item; older on the
    // subscription — read both shapes defensively. Persist it with the intent
    // so the webhook applies the same credit effect the operator requested.
    const itemAny = item as unknown as { current_period_start?: number; current_period_end?: number };
    const subAny = sub as unknown as { current_period_start?: number; current_period_end?: number };
    const start = itemAny.current_period_start ?? subAny.current_period_start ?? 0;
    const end = itemAny.current_period_end ?? subAny.current_period_end ?? 0;
    const now = Math.floor(Date.now() / 1000);
    fraction = end > start ? Math.min(1, Math.max(0, (end - now) / (end - start))) : 0;

    const { data: existingIntent, error: existingErr } = await db
      .from("plan_change_intents")
      .select("id, stripe_update_idempotency_key")
      .eq("client_id", client.id)
      .eq("stripe_subscription_id", sub.id)
      .eq("new_plan_id", plan.id)
      .eq("status", "pending")
      .order("requested_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existingErr) throw new HttpError(500, "intent_lookup_failed", "plan change intent lookup failed");

    const { data: createdIntent, error: iErr } = existingIntent
      ? { data: null, error: null }
      : await db
        .from("plan_change_intents")
        .insert({
          operator_id: operator.id,
          client_id: client.id,
          requested_by: operator.id,
          old_plan_id: client.plan_id,
          new_plan_id: plan.id,
          stripe_subscription_id: sub.id,
          stripe_update_idempotency_key: crypto.randomUUID(),
          remaining_fraction: fraction,
        })
        .select("id, stripe_update_idempotency_key")
        .single();
    const intent = existingIntent ?? createdIntent;
    if (iErr || !intent) throw new HttpError(500, "intent_failed", "plan change intent could not be saved");

    const idempotencyKey = `change_plan_${intent.stripe_update_idempotency_key}`;
    await stripe.subscriptions.update(
      sub.id,
      {
        items: [{ id: item.id, price: plan.stripe_price_id }],
        proration_behavior: "create_prorations",
        metadata: {
          ...sub.metadata,
          pawtrail_plan_change_intent_id: intent.id,
          pawtrail_plan_id: plan.id,
        },
      },
      { idempotencyKey },
    );

    await db.from("clients")
      .update({ current_period_end: end ? new Date(end * 1000).toISOString() : null })
      .eq("id", client.id);

    return jsonOk({
      pending: true,
      new_balance: client.credit_balance as number,
      plan,
      intent_id: intent.id,
    });
  } else {
    if (typeof body.fraction !== "number" || body.fraction < 0 || body.fraction > 1) {
      throw new HttpError(
        409,
        "no_subscription",
        "client has no Stripe subscription; supply fraction [0,1] for manual proration",
      );
    }
    fraction = body.fraction;
  }

  const { data: newBalance, error: rpcErr } = await db.rpc("fn_change_plan", {
    p_client: client.id,
    p_new_plan: plan.id,
    p_remaining_fraction: fraction,
  });
  if (rpcErr) throw new HttpError(500, "proration_failed", "credit proration failed");

  return jsonOk({ new_balance: newBalance as number, plan });
});
