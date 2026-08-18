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

## create-plan — POST, operator JWT (review B6)
Body `{ name, credits_per_cycle, price_pence, cycle, rollover_policy,
rollover_cap?, rollover_expiry_days?, overage_rate_pence }` → validates,
creates a Stripe Product + recurring Price **on the operator's connected
account**, inserts the `plans` row with the resulting `price_…`, returns
`{ plan }`.

An edge function rather than a plain insert because a plan without a
`stripe_price_id` cannot be checked out, and the alternative — asking the
operator to paste a `price_…` from the Stripe dashboard — was the activation
path the review called "a consulting engagement, not a product".

Refuses with `stripe_not_connected` **before** creating anything: a plan whose
Price does not exist is worse than no plan, because it appears in the list and
gives no clue why checkout fails. If the DB insert fails after the Price is
created, the Price is left in place — an orphan Price nothing references is
inert and free, whereas archiving it would strand a retry into creating a
second one.

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
- `invoice.paid` (subscription): **scoped to the client's bound subscription** — an invoice for any other subscription on the same customer is ignored, exactly as the two `customer.subscription.*` arms already did. A customer can carry more than one live subscription and their invoices have *different* ids, so `uq_payments_subscription_invoice` does not catch it: the result was two cycle grants and two rollovers. An *unbound* client is still applied, because `checkout.session.completed` and `invoice.paid` race and refusing would drop the first cycle of every new subscription. `create-checkout` now also refuses to start a second subscription for a client who has one.

  **Rollover runs on renewals only.** `fn_apply_invoice_paid` takes `p_is_renewal`, true for `subscription_cycle` and false for `subscription_create`. Rollover carries what is left of the cycle that just ended; a first invoice has no prior cycle, and on `rollover_policy='none'` running it books an expiry for the entire balance — destroying credit the operator granted before billing started.

  Non-cycle invoices (a one-off charge on the same customer) take the plain
  path: record the payment if one is not already recorded. "Already recorded"
  means a row whose status is in `SUBSCRIPTION_INVOICE_STATUSES` — see
  *Status sets* below.

- `invoice.payment_failed`: `subscription_status='past_due'` + `payment_failed` notifications (client + operator) + payments row (failed). The status write happens on **every** delivery; the payments row and the notifications only on the first. Stripe retries a failed invoice on its own dunning schedule and each redelivery carries a *fresh event id*, so `stripe_events` cannot dedupe it — without a `failed`-row check the Money screen accrues one "Needs attention" entry per retry for a single unpaid invoice.
- `invoice.upcoming`: `renewal_upcoming` notification (client).
- `customer.subscription.updated`: map Stripe status/pause_collection → `subscription_status` (`paused` when pause_collection set).
- `customer.subscription.deleted`: `subscription_status='cancelled'`, **and clears `stripe_subscription_id` and `current_period_end`**, and raises a `subscription_cancelled` notification to the operator. Clearing the binding matters: a dead subscription id left in place makes `change-plan` take the Stripe path and fail *after* `fn_record_plan_change_intent` has already committed a pending intent, and a stale `current_period_end` prints a confident renewal date on the Money screen for a subscription that will never renew. The notification matters because after 0026 the walks actually stop.

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

### Status sets — the code and the partial indexes must agree

`payments` carries two **partial** unique indexes, each filtered on `status`
(0023). A row participates in its own uniqueness guarantee only while its
status is in that set, so every "has this already been paid or claimed?" read
is re-asking a question the index has already decided. The two sets have to be
identical:

| Index | Statuses | Read that must match |
| --- | --- | --- |
| `uq_overage_payment_per_walk` | succeeded, pending, refunded, disputed | `getLiveOveragePayment` |
| `uq_payments_subscription_invoice` | succeeded, refunded, disputed | `hasPaymentForInvoice` |

Too **narrow** in code and the read misses a row, the caller falls through to
an insert, the index raises, and the operator sees an unexplained internal
error instead of "already charged". Too **wide** and the caller declines to
act on a row the database would happily let it duplicate.

`'failed'` is in neither set, and that is a product decision rather than a
mechanical one: a declined card must leave the walk re-chargeable, and
`invoice.payment_failed` must be able to write a row beside a later success on
the same invoice.

The sets live in `_lib/payment_status.ts` and `payment_status_test.ts` parses
the *last* definition of each index out of `supabase/migrations/` and compares.
Changing either side alone fails CI. (Parsing the last definition is
load-bearing: 0012 created `uq_overage_payment_per_walk` with the narrow list
the code was still using, so a first-match parser would have confirmed the bug.)

## charge-overage — POST, operator JWT (also invoked in-process by complete-walk)
Body: `{ walk_id }` → assert walk `is_overage=true` and no live overage payment exists (idempotency, per *Status sets* above) → PaymentIntent `off_session=true, confirm=true`, amount = client's `plans.overage_rate_pence`, customer default payment method → payments row (`type='overage'`, walk_id, status from PI). The walk stays completed in every failure case; the debt is visible in the billing console.
Response: `{ payment }`.

**Failures are three classes, not two.** Which one a failure falls into decides
both whether the claim is resolved and who gets told.

| Class | Claim | Notified | Why |
| --- | --- | --- | --- |
| Card declined | → `failed` | client **and** operator | The client can fix it by updating their card. |
| Permanent | → `failed` | operator only | A malformed request, or a customer that does not exist on this connected account. Retrying changes nothing, and there is nothing the client can do — telling them to update a payment method would be false. |
| Transient | stays `pending` | nobody | Stripe unreachable, DB write failed. The charge may yet have landed, so the claim must keep blocking; the caller 500s and the retry replays the *same* idempotency key. |

Before this split, everything non-card was treated as transient. A permanent
failure therefore left the claim pending forever: the walk never completed at
all, and every retry hit the same wall. The operator-facing message names the
setting to fix rather than repeating Stripe's developer-facing text.

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
For each active schedule: generate `walks` rows for the next 14 days for matching `days_of_week`, skipping dates inside pause windows, client `status='paused'`/`'archived'`, and dates < `start_date` / > `end_date`.

**Subscription state is an allow-list, not a deny-list (0026).** Walks are generated only for `subscription_status in ('active','none')`. It read `<> 'paused'`, which was the sole subscription predicate — so a client who had cancelled, or whose card had failed, kept having walks generated nightly that the operator performed and could not bill. An allow-list also fails *closed*: a value added to the enum later stops generating work until somebody decides what it means, rather than silently producing unbillable walks.

`'none'` is deliberately included — that is a client who never subscribed, whom the operator may bill outside Sanpo. `past_due` is excluded by owner decision: service halts until payment clears. `fn_book_walk` carries the identical predicate, so client self-booking and nightly materialization cannot disagree. Idempotent via the `(schedule_id, scheduled_date)` unique index (`ON CONFLICT DO NOTHING`). Also invokes `fn_expire_credits()` daily (phase 08 wiring).
Response: `{ created: n }`.
