# 04 — Edge function contracts (Deno, `supabase/functions/`)

Shared `_lib/`: `admin.ts` (service-role client), `http.ts` (CORS, JSON helpers, `requireUser(req)` → verified JWT user id, `requireOperator`), `crypto.ts` (AES-256-GCM per spec 03 blob layout), `stripe.ts` (SDK init, signature verify). All responses `{ ok: true, data } | { ok: false, error: { code, message } }`. All functions `verify_jwt = true` except `stripe-webhook` (`verify_jwt = false`, signature-verified instead).

## complete-walk — POST, operator JWT
Body: `{ walk_id, ended_at, distance_m, notes?, potty_pee?, potty_poo?, fed?, watered?, photo_paths?: string[] }`
Effects (in order): assert walk belongs to caller and `status='in_progress'` → update walk fields, `status='completed'` → insert `walk_photos` rows → `fn_debit_walk` → if `'overage'`, invoke overage charge (same logic as charge-overage, in-process) → insert `walk_complete` notification (client) → low-credit check per spec 02 → Realtime broadcast `walk:{id}` event `ended`.
Response: `{ walk, billing: { outcome: 'debited'|'overage', cost_credits?, charged_pence?, payment_status? } }`
Idempotent: re-POST on a completed walk returns the stored result, no re-billing.

## create-checkout — POST, operator JWT
Body: `{ client_id, plan_id }` → assert ownership → get/create Stripe customer (persist `stripe_customer_id`) → Checkout Session `mode=subscription`, `price = plans.stripe_price_id`, `payment_method_collection=always`, `subscription_data.metadata = { client_id, operator_id, plan_id }`, success/cancel URLs from `APP_BASE_URL`.
Response: `{ url }`.

## connect-onboarding — POST, operator JWT (review B5)
Body `{ action: 'start' | 'status' }`. `status` reports `{ connected,
charges_enabled, payouts_enabled, details_submitted }` from the local mirror;
`start` creates the operator's **Standard** connected account if absent and
returns a single-use `AccountLink` onboarding URL.

Standard, not Express or Custom, because **the operator is the merchant of
record**: they own the Stripe account, their business is on the client's card
statement, and they carry chargeback liability and Stripe's fees. Express and
Custom put the platform in that position instead.

The account id is persisted **before** the AccountLink is minted, under a
`WHERE stripe_account_id IS NULL` guard. Losing the link is recoverable (mint
another); losing the id is not — the next `start` would create a *second*
Stripe account and the money would land in whichever one Stripe finished
first, with the other left half-onboarded and invisible.

This is the only function that reaches Stripe on the platform account for
anything but signature verification. Money never moves there.

## stripe-webhook — POST from Stripe
**Register it as a Connect endpoint**, not an account endpoint — connected
accounts are where every payment now happens, and an account-level endpoint
would receive none of them.

`event.account` is an **authorization input, not a routing hint**. A Connect
endpoint receives events for every account connected to the platform, so:
- an event with no `account` is **ignored** (a platform-account event; Sanpo
  takes no money there),
- an `account` matching no operator is **ignored**,
- every lookup below is **scoped to the operator it resolves to** — the client
  lookup, the client update, and the reversal lookup.

That last point is load-bearing. Checkout session metadata is written by
whoever creates the session, so on a Connect endpoint any operator can craft
one in their own Stripe dashboard carrying another operator's `client_id`. The
id alone is not an authorization: the update matches on client id **and**
operator id, and a zero-row result is ignored.

Also handled: `account.updated` mirrors `charges_enabled` / `payouts_enabled` /
`details_submitted` onto `operators`, in both directions — Stripe disables
charges when a requirement comes due, and mirroring only the enabling
direction would leave an operator taking payments Stripe was already
rejecting.

Verify `stripe-signature` with `STRIPE_WEBHOOK_SECRET`. Idempotency: `INSERT INTO stripe_events … ON CONFLICT (id) DO NOTHING`; if conflict → 200 immediately.
- `checkout.session.completed`: bind `stripe_subscription_id`, `subscription_status='active'`, `plan_id` from metadata.
- `invoice.paid` (subscription): resolve client by customer id → `fn_apply_rollover` → `fn_grant_credits(credits_per_cycle, 'cycle grant {invoice.id}')` → payments row (`type='subscription'`, succeeded).
- `invoice.payment_failed`: `subscription_status='past_due'` + `payment_failed` notifications (client + operator) + payments row (failed).
- `invoice.upcoming`: `renewal_upcoming` notification (client).
- `customer.subscription.updated`: map Stripe status/pause_collection → `subscription_status` (`paused` when pause_collection set).
- `customer.subscription.deleted`: `subscription_status='cancelled'`.

Reversals (0023, review B4). Sanpo cannot issue a refund — the Stripe
dashboard does — so these arms exist to make the books agree with what Stripe
already did, and to tell the operator it happened.
- `charge.refunded`: reverse using `charge.amount_refunded`, which is
  **cumulative** across partial refunds. Passing a per-event delta would
  double-claw on Stripe's redelivery (it retries for three days).
- `charge.dispute.created`, `charge.dispute.funds_withdrawn`: reverse as kind
  `dispute`. A dispute is a distinct payment state from a refund — the money
  is pulled by the cardholder's bank, it carries a fee, and it can still be
  contested.
- `credit_note.created`: a credit note against a paid invoice is a refund by
  another name. Prefer the invoice's `post_payment_credit_notes_amount`
  (cumulative); the note's own `amount` is not, and is used only when Stripe
  did not expand the invoice.
- `invoice.voided`: reverse `amount_paid`.

All five funnel through `fn_reverse_payment` so the row lock, the clawback
floor and the idempotency live in one place. A charge matching no payments row
is **ignored** — a customer can have charges created outside Sanpo, and
inventing a row for one is worse than skipping it. A reversal reported `noop`
(a cumulative total already applied) is acked but raises no second
notification.

Always 200 on handled/ignored types; 400 only on bad signature.

## charge-overage — POST, operator JWT (also invoked in-process by complete-walk)
Body: `{ walk_id }` → assert walk `is_overage=true` and no succeeded overage payment exists (idempotency) → PaymentIntent `off_session=true, confirm=true`, amount = client's `plans.overage_rate_pence`, customer default payment method → payments row (`type='overage'`, walk_id, status from PI). On card failure: payments row failed + `payment_failed` notification; walk stays completed (debt visible in billing console).
Response: `{ payment }`.

## credential-vault — POST, operator JWT
Body: `{ action: 'put'|'get'|'delete', credential_id?, property_id?, entry_method?, label?, secret?, key_location_hint?, purpose?, password }`
Every action re-verifies `password` against the caller's account (Auth admin check); rate-limit 5/min/user (in-memory + 429).
- `put`: encrypt `secret` → upsert row (metadata plaintext, secret in ciphertext).
- `get`: `fn_read_credential(credential_id, purpose)` (writes audit row) → decrypt → `{ secret, label, entry_method }`. `purpose` required, non-empty.
- `delete`: delete row (cascades audit log retention: log rows persist — FK is `on delete cascade` per spec 01; change to `on delete restrict` + soft-delete flag `revoked_at` instead. **Authoritative: soft delete.** Add `revoked_at timestamptz` to access_credentials; `delete` action sets it; audit log immortal.)
Plaintext secrets never appear in logs, errors, or analytics.

## change-plan — POST, operator JWT (built in phase 07)
Body: `{ client_id, new_plan_id }` → Stripe: update subscription item to new price, `proration_behavior='create_prorations'` → compute `remaining_fraction` from current period bounds → `fn_change_plan(client, new_plan, fraction)`.
Response: `{ new_balance, plan }`.

## materialize-walks — scheduled (cron, phase 06) + POST operator JWT for manual run
For each active schedule: generate `walks` rows for the next 14 days for matching `days_of_week`, skipping dates inside pause windows, client `status='paused'`/`subscription_status='paused'`, and dates < `start_date` / > `end_date`. Idempotent via the `(schedule_id, scheduled_date)` unique index (`ON CONFLICT DO NOTHING`). Also invokes `fn_expire_credits()` daily (phase 08 wiring).
Response: `{ created: n }`.
