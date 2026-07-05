# Stripe local verification (phase 01)

Manual fixture flow with the Stripe CLI against the local stack. The deno
test suite covers signature verification and dispatch hermetically; this
walkthrough exercises the real wire format end-to-end.

## Setup
```sh
stripe login
supabase functions serve   # serves all functions on :54321 (Docker stack)

# forward events to the local webhook; prints whsec_… to export
stripe listen --forward-to http://127.0.0.1:54321/functions/v1/stripe-webhook
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_…   # or export for serve
```

## Fixtures
```sh
# happy renewal: rollover → cycle grant → payments row
stripe trigger invoice.paid

# dunning: past_due + payment_failed notifications (client + operator)
stripe trigger invoice.payment_failed

# renewal_upcoming notification
stripe trigger invoice.upcoming

# subscription lifecycle mapping (paused / past_due / cancelled)
stripe trigger customer.subscription.updated
stripe trigger customer.subscription.deleted

# checkout binding (subscription id + plan from metadata)
stripe trigger checkout.session.completed
```

Triggered fixtures carry Stripe's synthetic customer ids, which won't match
a local `clients.stripe_customer_id` — the webhook logs the event into
`stripe_events` and ignores it. For a full-loop test, set a client row's
`stripe_customer_id` to the id printed by the trigger (or run a real
create-checkout session with a test card: 4242 4242 4242 4242).

## Idempotency check
Re-deliver any event from the Stripe dashboard (or `stripe events resend
<evt_id>`): the second delivery must return 200 immediately with
`{"status":"duplicate"}` and produce no new ledger/payments rows.

## Overage path
1. Zero a client's balance, complete a walk → `fn_debit_walk` flags overage.
2. complete-walk (or POST charge-overage with `{ "walk_id": … }`) creates an
   off-session PaymentIntent at the plan's `overage_rate_pence`.
3. Card 4000 0000 0000 0341 (attach then decline) exercises the failure
   path: payments row `failed`, payment_failed notifications, walk stays
   completed — the debt shows in the billing console.
