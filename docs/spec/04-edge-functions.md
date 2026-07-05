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

## stripe-webhook — POST from Stripe
Verify `stripe-signature` with `STRIPE_WEBHOOK_SECRET`. Idempotency: `INSERT INTO stripe_events … ON CONFLICT (id) DO NOTHING`; if conflict → 200 immediately.
- `checkout.session.completed`: bind `stripe_subscription_id`, `subscription_status='active'`, `plan_id` from metadata.
- `invoice.paid` (subscription): resolve client by customer id → `fn_apply_rollover` → `fn_grant_credits(credits_per_cycle, 'cycle grant {invoice.id}')` → payments row (`type='subscription'`, succeeded).
- `invoice.payment_failed`: `subscription_status='past_due'` + `payment_failed` notifications (client + operator) + payments row (failed).
- `invoice.upcoming`: `renewal_upcoming` notification (client).
- `customer.subscription.updated`: map Stripe status/pause_collection → `subscription_status` (`paused` when pause_collection set).
- `customer.subscription.deleted`: `subscription_status='cancelled'`.
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
