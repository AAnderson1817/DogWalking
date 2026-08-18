// create-checkout — POST, operator JWT (spec 04). Creates a subscription-mode
// Checkout Session for a client on one of the operator's plans.
import {
  HttpError,
  jsonOk,
  readJson,
  requireAccount,
  requireOperator,
  serveFunction,
} from "../_lib/http.ts";
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
    .select("id, operator_id, full_name, email, stripe_customer_id, stripe_subscription_id, subscription_status")
    .eq("id", body.client_id)
    .maybeSingle();
  if (cErr) {
    throw new HttpError(500, "db_error", "client lookup failed", cErr, {
      client_id: body.client_id,
    });
  }
  if (!client || client.operator_id !== operator.id) {
    throw new HttpError(404, "client_not_found", "client not found");
  }

  const { data: plan, error: pErr } = await db
    .from("plans")
    .select("id, operator_id, name, stripe_price_id, active")
    .eq("id", body.plan_id)
    .maybeSingle();
  if (pErr) {
    throw new HttpError(500, "db_error", "plan lookup failed", pErr, {
      plan_id: body.plan_id,
    });
  }
  if (!plan || plan.operator_id !== operator.id) {
    throw new HttpError(404, "plan_not_found", "plan not found");
  }
  if (!plan.active) throw new HttpError(409, "plan_inactive", "plan is not active");
  if (!plan.stripe_price_id) {
    throw new HttpError(409, "plan_unpriced", "plan has no stripe_price_id configured");
  }

  const stripe = stripeClient();
  // Every call below carries this. The operator is the merchant of record
  // (review B5): the customer, the subscription and the charge all live on
  // THEIR Stripe account, their business appears on the client's statement,
  // and the money lands in their bank — Sanpo is never in the flow of funds.
  // One live subscription per client. Nothing stopped a second checkout, and
  // a customer with two subscriptions receives two invoice.paid events with
  // DIFFERENT invoice ids — so uq_payments_subscription_invoice does not catch
  // it and the client is charged twice and granted two cycles. The webhook now
  // ignores invoices for an unbound subscription, but the right place to stop
  // it is before the second one exists.
  if (client.stripe_subscription_id && client.subscription_status !== "cancelled") {
    throw new HttpError(
      409,
      "already_subscribed",
      "This client already has a live subscription. Change their plan instead of starting a second one.",
    );
  }

  const account = requireAccount(operator);

  let customerId = client.stripe_customer_id as string | null;
  if (!customerId) {
    // A customer created on the platform account is invisible from the
    // connected one — the id would look valid and every later call with it
    // would 404. Customers are per-account objects.
    const customer = await stripe.customers.create({
      email: client.email ?? undefined,
      name: client.full_name,
      metadata: { client_id: client.id, operator_id: operator.id },
    }, account);
    customerId = customer.id;
    const { error: uErr } = await db
      .from("clients")
      .update({ stripe_customer_id: customerId })
      .eq("id", client.id);
    if (uErr) {
      // The Stripe customer exists at this point and the row does not name it,
      // so the cause here is what tells a later reconciliation which customer
      // was orphaned.
      throw new HttpError(500, "db_error", "failed to persist stripe customer", uErr, {
        client_id: client.id,
        stripe_customer_id: customerId,
      });
    }
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
  }, account);

  return jsonOk({ url: session.url });
});
