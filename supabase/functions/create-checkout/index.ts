// create-checkout — POST, operator JWT (spec 04). Creates a subscription-mode
// Checkout Session for a client on one of the operator's plans.
import { jsonOk, readJson, requireOperator, serveFunction, HttpError } from "../_lib/http.ts";
import { adminClient } from "../_lib/admin.ts";
import { stripeClient } from "../_lib/stripe.ts";

serveFunction(async (req) => {
  const operator = await requireOperator(req);
  const body = await readJson<{ client_id?: string; plan_id?: string }>(req);
  if (!body?.client_id || !body.plan_id) {
    throw new HttpError(400, "bad_request", "client_id and plan_id are required");
  }

  const db = adminClient();

  const { data: client, error: cErr } = await db
    .from("clients")
    .select("id, operator_id, full_name, email, stripe_customer_id")
    .eq("id", body.client_id)
    .maybeSingle();
  if (cErr) throw new HttpError(500, "db_error", "client lookup failed");
  if (!client || client.operator_id !== operator.id) {
    throw new HttpError(404, "client_not_found", "client not found");
  }

  const { data: plan, error: pErr } = await db
    .from("plans")
    .select("id, operator_id, name, stripe_price_id, active")
    .eq("id", body.plan_id)
    .maybeSingle();
  if (pErr) throw new HttpError(500, "db_error", "plan lookup failed");
  if (!plan || plan.operator_id !== operator.id) {
    throw new HttpError(404, "plan_not_found", "plan not found");
  }
  if (!plan.active) throw new HttpError(409, "plan_inactive", "plan is not active");
  if (!plan.stripe_price_id) {
    throw new HttpError(409, "plan_unpriced", "plan has no stripe_price_id configured");
  }

  const stripe = stripeClient();

  let customerId = client.stripe_customer_id as string | null;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: client.email ?? undefined,
      name: client.full_name,
      metadata: { client_id: client.id, operator_id: operator.id },
    });
    customerId = customer.id;
    const { error: uErr } = await db
      .from("clients")
      .update({ stripe_customer_id: customerId })
      .eq("id", client.id);
    if (uErr) throw new HttpError(500, "db_error", "failed to persist stripe customer");
  }

  const base = Deno.env.get("APP_BASE_URL") ?? "http://localhost:5173";
  const metadata = {
    client_id: client.id,
    operator_id: operator.id,
    plan_id: plan.id,
  };
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
    payment_method_collection: "always",
    // Metadata on both the session (read by checkout.session.completed) and
    // the subscription (read by anything inspecting the subscription later).
    metadata,
    subscription_data: { metadata },
    success_url: `${base}/clients/${client.id}?checkout=success`,
    cancel_url: `${base}/clients/${client.id}?checkout=cancelled`,
  });

  return jsonOk({ url: session.url });
});
