// Payload-shape helpers shared by both webhook endpoints (spec 04).
//
// Webhook payload shapes follow the ENDPOINT's API version, not the SDK pin —
// `new Stripe(key)` pins only outbound requests — and both runbooks create
// the endpoints in the Dashboard, which defaults to the account's version.
// Stripe's 2025-03-31 "Basil" release moved the invoice's subscription
// reference, so a handler reading only the old field is dead code on any
// current account: the H31 adversarial review found platform-webhook had
// exactly that, while stripe-webhook already carried the dual read. One
// helper now, so the two endpoints cannot disagree about the shape again.

/** The subscription an invoice belongs to: pre-Basil `invoice.subscription`,
 * post-Basil `invoice.parent.subscription_details.subscription`. */
export function invoiceSubscriptionId(obj: Record<string, unknown>): string | null {
  if (typeof obj.subscription === "string" && obj.subscription) return obj.subscription;
  const parent = obj.parent as { subscription_details?: { subscription?: string } } | undefined;
  return parent?.subscription_details?.subscription ?? null;
}
