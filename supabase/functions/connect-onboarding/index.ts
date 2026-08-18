// connect-onboarding — POST, operator JWT (review B5).
//
// Creates and resumes the operator's Stripe Connect *Standard* account. This
// is the only function that talks to the platform account for anything other
// than webhook verification, because creating a connected account is by
// definition a platform operation.
//
// Standard, not Express or Custom, because the operator is the merchant of
// record: they own the Stripe account outright, their business is on the
// client's card statement, and they carry chargeback liability and Stripe's
// fees. Express and Custom put the platform in that position instead.
import {
  HttpError,
  jsonOk,
  readJson,
  requireOperator,
  serveFunction,
} from "../_lib/http.ts";
import { adminClient } from "../_lib/admin.ts";
import { stripeClient } from "../_lib/stripe.ts";

interface Body {
  /** 'start' mints an onboarding link; 'status' just reports where we are. */
  action?: "start" | "status";
}

serveFunction(async (req) => {
  const operator = await requireOperator(req);
  const body = await readJson<Body>(req);
  const action = body?.action ?? "status";

  const db = adminClient();
  const stripe = stripeClient();
  const base = Deno.env.get("APP_BASE_URL") ?? "http://localhost:5173";

  const { data: row, error } = await db
    .from("operators")
    // Single string literal, not a concatenation: supabase-js infers the row
    // type from the literal, and a `+` expression degrades it to an error type.
    .select("id, email, business_name, stripe_account_id, stripe_charges_enabled, stripe_payouts_enabled, stripe_details_submitted")
    .eq("id", operator.id)
    .maybeSingle();
  if (error) throw new HttpError(500, "db_error", "operator lookup failed");
  if (!row) throw new HttpError(403, "not_operator", "caller is not an operator");

  if (action === "status") {
    return jsonOk({
      connected: Boolean(row.stripe_account_id),
      charges_enabled: row.stripe_charges_enabled,
      payouts_enabled: row.stripe_payouts_enabled,
      details_submitted: row.stripe_details_submitted,
    });
  }

  let accountId = row.stripe_account_id as string | null;
  if (!accountId) {
    const account = await stripe.accounts.create({
      type: "standard",
      email: row.email ?? undefined,
      business_profile: { name: row.business_name ?? undefined },
      metadata: { operator_id: operator.id },
    });
    accountId = account.id;

    // Persisted BEFORE the AccountLink is minted. If this write failed after
    // the operator had already started onboarding, the next 'start' would
    // create a SECOND Stripe account, and the money would land in whichever
    // one Stripe happened to finish first — with the other left half-onboarded
    // and invisible. Losing the link is recoverable; losing the account id is
    // not.
    const { error: uErr } = await db
      .from("operators")
      .update({
        stripe_account_id: accountId,
        stripe_account_connected_at: new Date().toISOString(),
      })
      .eq("id", operator.id)
      // Only claim the row if it is still unclaimed: two concurrent 'start'
      // calls would otherwise each create an account and the loser would
      // overwrite the winner.
      .is("stripe_account_id", null);
    if (uErr) throw new HttpError(500, "db_error", "failed to persist the Stripe account");

    // Re-read: if the conditional update matched nothing, another request won
    // the race and its account is the real one. Ours is an orphan — harmless,
    // because an account with no onboarding and no charges is inert.
    const { data: after } = await db
      .from("operators").select("stripe_account_id").eq("id", operator.id).maybeSingle();
    accountId = (after?.stripe_account_id as string | null) ?? accountId;
  }

  // AccountLinks are single-use and short-lived, so one is minted per attempt
  // rather than stored.
  const link = await stripe.accountLinks.create({
    account: accountId,
    type: "account_onboarding",
    refresh_url: `${base}/billing?connect=refresh`,
    return_url: `${base}/billing?connect=return`,
  });

  return jsonOk({ url: link.url, account_id: accountId });
});
