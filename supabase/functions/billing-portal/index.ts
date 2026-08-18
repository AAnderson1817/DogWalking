// billing-portal — POST, client JWT (phase 07). Returns a Stripe customer
// portal session URL for payment-method / pause / cancel self-service.
import { accountOf, HttpError, jsonOk, requireUser, serveFunction } from "../_lib/http.ts";
import { adminClient } from "../_lib/admin.ts";
import { stripeClient } from "../_lib/stripe.ts";

serveFunction(async (req) => {
  const user = await requireUser(req);
  const db = adminClient();

  // The operator's Connect state comes back with the client: the Stripe
  // customer lives on the OPERATOR's account (review B5), so a portal session
  // created on the platform account would 404 on a customer id that looks
  // perfectly valid.
  const { data: client, error } = await db
    .from("clients")
    .select("id, stripe_customer_id, operator:operators!clients_operator_id_fkey(stripe_account_id, stripe_charges_enabled)")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  if (error) throw new HttpError(500, "db_error", "client lookup failed");
  if (!client) throw new HttpError(403, "not_client", "caller is not a client");
  if (!client.stripe_customer_id) {
    throw new HttpError(409, "no_billing", "no billing profile yet — ask your walker to set up your plan");
  }

  // accountOf, not requireAccount: this path does not take money. Blocking a
  // client from updating a card or cancelling because Stripe has charges
  // paused on their walker would strand them with a subscription they cannot
  // stop.
  const account = accountOf(
    client.operator as unknown as { stripe_account_id: string | null; stripe_charges_enabled: boolean },
  );

  const base = Deno.env.get("APP_BASE_URL") ?? "http://localhost:5173";
  const session = await stripeClient().billingPortal.sessions.create({
    customer: client.stripe_customer_id,
    return_url: `${base}/portal/billing`,
  }, account);

  return jsonOk({ url: session.url });
});
