// create-checkout — POST, operator JWT (spec 04). Mints one of three Checkout
// Sessions for a client (review H32):
//   * { client_id, plan_id }                       → subscription mode
//   * { client_id, topup: { credits, amount_pence } } → payment mode; the paid
//     card is saved for off-session visit charges
//   * { client_id, setup: true }                   → setup mode; card on file
//     for a pay-per-visit client, under a mandate naming the visit prices
// The session shapes live in params.ts as pure builders; everything here is
// lookup, authorization and the single sessions.create call.
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
import {
  assertTopupAllowed,
  parseCheckoutRequest,
  type PricedService,
  setupSessionParams,
  subscriptionSessionParams,
  topupSessionParams,
  visitPriceMandate,
} from "./params.ts";

serveFunction(async (req) => {
  const operator = await requireOperator(req);
  const request = parseCheckoutRequest(await readJson(req));

  const db = adminClient();

  const { data: client, error: cErr } = await db
    .from("clients")
    .select(
      "id, operator_id, full_name, email, stripe_customer_id, stripe_subscription_id, subscription_status",
    )
    .eq("id", request.clientId)
    .maybeSingle();
  if (cErr) {
    throw new HttpError(500, "db_error", "client lookup failed", cErr, {
      client_id: request.clientId,
    });
  }
  if (!client || client.operator_id !== operator.id) {
    throw new HttpError(404, "client_not_found", "client not found");
  }

  // Subscription checkout needs its plan; the other two kinds need the
  // operator's priced services for the per-visit mandate.
  let plan: {
    id: string;
    stripe_price_id: string | null;
    overage_rate_pence: number | null;
  } | null = null;
  let pricedServices: PricedService[] = [];

  if (request.kind === "subscription") {
    const { data, error: pErr } = await db
      .from("plans")
      .select("id, operator_id, name, stripe_price_id, active, overage_rate_pence")
      .eq("id", request.planId)
      .maybeSingle();
    if (pErr) {
      throw new HttpError(500, "db_error", "plan lookup failed", pErr, {
        plan_id: request.planId,
      });
    }
    if (!data || data.operator_id !== operator.id) {
      throw new HttpError(404, "plan_not_found", "plan not found");
    }
    if (!data.active) throw new HttpError(409, "plan_inactive", "plan is not active");
    if (!data.stripe_price_id) {
      throw new HttpError(409, "plan_unpriced", "plan has no stripe_price_id configured");
    }
    // One live subscription per client. Nothing stopped a second checkout,
    // and a customer with two subscriptions receives two invoice.paid events
    // with DIFFERENT invoice ids — so uq_payments_subscription_invoice does
    // not catch it and the client is charged twice and granted two cycles.
    // The webhook now ignores invoices for an unbound subscription, but the
    // right place to stop it is before the second one exists.
    if (client.stripe_subscription_id && client.subscription_status !== "cancelled") {
      throw new HttpError(
        409,
        "already_subscribed",
        "This client already has a live subscription. Change their plan instead of starting a second one.",
      );
    }
    plan = data;
  } else {
    // A live billing cycle sweeps the balance at renewal, so a paid top-up
    // for a subscribed client is money for credits the machinery is
    // scheduled to destroy — refused, with fn_adjust_credits as the
    // operator-judgment path (see assertTopupAllowed).
    if (request.kind === "topup") assertTopupAllowed(client);
    const { data, error: sErr } = await db
      .from("service_types")
      .select("name, visit_price_pence")
      .eq("operator_id", operator.id)
      .not("visit_price_pence", "is", null)
      .order("name")
      .limit(50);
    if (sErr) {
      throw new HttpError(500, "db_error", "service lookup failed", sErr, {
        client_id: client.id,
      });
    }
    pricedServices = (data ?? []) as PricedService[];
    if (request.kind === "setup" && pricedServices.length === 0) {
      // A card saved under no stated terms is an off-session charge waiting
      // to surprise somebody (H12), so the mandate is a precondition, not
      // decoration. Refuse BEFORE creating anything — create-plan's posture.
      throw new HttpError(
        409,
        "visit_price_missing",
        "Set a visit price in Settings first — the card-save form has to say what the card will be charged.",
      );
    }
  }

  const stripe = stripeClient();
  // Every Stripe call below carries this. The operator is the merchant of
  // record (review B5): the customer, the session and the money all live on
  // THEIR Stripe account — Sanpo is never in the flow of funds.
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
  const common = {
    customerId,
    clientId: client.id,
    operatorId: operator.id,
    base,
  };
  const params = request.kind === "subscription"
    ? subscriptionSessionParams({
      ...common,
      planId: plan!.id,
      stripePriceId: plan!.stripe_price_id!,
      overageRatePence: plan!.overage_rate_pence,
    })
    : request.kind === "topup"
    ? topupSessionParams({
      ...common,
      credits: request.credits,
      amountPence: request.amountPence,
      mandate: visitPriceMandate(pricedServices),
    })
    : setupSessionParams({
      ...common,
      // Non-null: the setup branch refused above when nothing is priced.
      mandate: visitPriceMandate(pricedServices)!,
    });

  const session = await stripe.checkout.sessions.create(params, account);

  return jsonOk({ url: session.url });
});
