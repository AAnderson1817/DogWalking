// billing-portal decision logic (phase 07, review B5), dependency-injected
// for tests.
//
// Everything that decides whether a portal session may be minted lives here,
// behind a seam, because `index.ts` binds a port on import and so nothing in
// it could be driven by a test — the blind spot that hid two defects in
// send-notification's deps and one in overage_deps. The rule this file
// exists to make assertable: `accountOf`, NOT `requireAccount`. This path
// does not take money, and until the seam the only thing carrying that rule
// was a comment beside the call — a reviewer "tidying" it to the money
// helper would have stranded every client whose walker Stripe was still
// reviewing, unable to update a card or cancel. billing_portal_test.ts pins
// it on a recorder: a client whose walker's charges are disabled still gets
// a session.
import { accountOf, type ConnectFields, HttpError } from "../_lib/http.ts";

/** The clients row the portal needs, with the OPERATOR's Connect state
 * embedded: the Stripe customer lives on the operator's account (review
 * B5), so a session created on the platform account would 404 on a customer
 * id that looks perfectly valid. */
export interface PortalClientRow {
  id: string;
  stripe_customer_id: string | null;
  operator: ConnectFields;
}

export interface BillingPortalDeps {
  /** The caller's clients row, or null when the caller is not a client.
   * Throws HttpError(500, db_error) on a database failure — a failed lookup
   * is not an absence (backlog item 2, fix(send-lookups)). */
  getClientForUser(authUserId: string): Promise<PortalClientRow | null>;
  /** stripe.billingPortal.sessions.create on the operator's CONNECTED
   * account: the second argument is Stripe's per-request options and must
   * carry the account, asserted over every recorded call by
   * billing_portal_test.ts. */
  createPortalSession(
    params: { customer: string; return_url: string },
    opts: { stripeAccount: string },
  ): Promise<{ url: string }>;
  /** APP_BASE_URL. */
  base: string;
}

export async function handleBillingPortal(
  user: { id: string },
  deps: BillingPortalDeps,
): Promise<{ url: string }> {
  const client = await deps.getClientForUser(user.id);
  if (!client) throw new HttpError(403, "not_client", "caller is not a client");
  if (!client.stripe_customer_id) {
    throw new HttpError(409, "no_billing", "no billing profile yet — ask your walker to set up your plan");
  }

  // accountOf, not requireAccount: this path does not take money. Blocking a
  // client from updating a card or cancelling because Stripe has charges
  // paused on their walker would strand them with a subscription they cannot
  // stop.
  const account = accountOf(client.operator);

  const session = await deps.createPortalSession({
    customer: client.stripe_customer_id,
    return_url: `${deps.base}/portal/billing`,
  }, account);

  return { url: session.url };
}
