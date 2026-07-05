// billing-portal — POST, client JWT (phase 07). Returns a Stripe customer
// portal session URL for payment-method / pause / cancel self-service.
import { jsonOk, requireUser, serveFunction, HttpError } from "../_lib/http.ts";
import { adminClient } from "../_lib/admin.ts";
import { stripeClient } from "../_lib/stripe.ts";

serveFunction(async (req) => {
  const user = await requireUser(req);
  const db = adminClient();

  const { data: client, error } = await db
    .from("clients")
    .select("id, stripe_customer_id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  if (error) throw new HttpError(500, "db_error", "client lookup failed");
  if (!client) throw new HttpError(403, "not_client", "caller is not a client");
  if (!client.stripe_customer_id) {
    throw new HttpError(409, "no_billing", "no billing profile yet — ask your walker to set up your plan");
  }

  const base = Deno.env.get("APP_BASE_URL") ?? "http://localhost:5173";
  const session = await stripeClient().billingPortal.sessions.create({
    customer: client.stripe_customer_id,
    return_url: `${base}/portal/billing`,
  });

  return jsonOk({ url: session.url });
});
