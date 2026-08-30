# 04 — Edge function contracts (Deno, `supabase/functions/`)

Shared `_lib/`: `admin.ts` (service-role client), `http.ts` (CORS, JSON helpers, `requireUser(req)` → verified JWT user id, `requireOperator`), `crypto.ts` (AES-256-GCM per spec 03 blob layout), `stripe.ts` (SDK init, signature verify), `observe.ts` (structured error logging). All responses `{ ok: true, data } | { ok: false, error: { code, message, request_id } }`. All functions `verify_jwt = true` except `stripe-webhook` (`verify_jwt = false`, signature-verified instead).

## Every server-side failure leaves exactly one log line (review H14)

All 43 deliberate `HttpError(5xx)` throws used to drop the underlying
Postgres/Stripe error at the throw site — `HttpError` had nowhere to put one —
and `serveFunction`'s catch returned the envelope with **no logging at all**. So
when an operator said "completing the walk failed yesterday", there was nothing
to look at: no line was written, and the specific error had never been captured.
On the money paths, "we cannot reconstruct what happened" is not an answer.

**`HttpError(status, code, message, cause?, context?)`.**

| | Who reads it |
| --- | --- |
| `message` | the client. Ours, a sentence a person can act on. |
| `cause` | us. The Postgres/Stripe error. **Never** sent to the client. |
| `context` | us. `walk_id`, `client_id` — what makes the line findable later. |

`handleRequest` (extracted from `serveFunction` so it is testable at all) logs
one JSON line for every status **≥ 500** and echoes an `x-request-id` header on
every response, success included. The id is also in the error envelope, so a
failure a person is looking at can be tied to the line that recorded it.

A **4xx logs nothing**: that is the caller being told something true about
their own request, and burying our failures under theirs is the same as not
logging.

### What must never reach a log line

Invariant 2 says plaintext secrets are never logged; `safeCause` is the
mechanism. It projects a thrown value down to `name`, `code`, `message` — and
**drops `details` and `hint`**, because that is where Postgres puts the
offending values (`Key (col)=(…) already exists`). No unique constraint on a
ciphertext column exists today, which is precisely why the rule lives in code
with a test rather than in a reviewer's memory.

It follows `.cause` up to three levels, because our own wrappers say "client
lookup failed" and the error underneath says why — stopping at the first level
would record the label and drop the finding.

`causeCode()` is the stricter setting, giving up the message entirely and
keeping only the SQLSTATE. Used at the four vault statements that carry
ciphertext in the statement itself, where a syntax or constraint error could
quote part of the payload back. Deliberately not the default: everywhere else
the message is the most useful thing in the line.

### Not done here

A **log drain** and an **error monitor** are dashboard steps no file in this
repository can perform, so retention is still the platform default and nobody
is paged. Both runbooks list them. Until they exist, this makes an incident
*reconstructable*, not *noticed*.

## complete-walk — POST, operator JWT
Body: `{ walk_id, ended_at, distance_m, notes?, potty_pee?, potty_poo?, fed?, watered?, photo_paths?: string[] }`
Effects (in order): assert walk belongs to caller and `status='in_progress'` → update walk fields, `status='completed'` → insert `walk_photos` rows → `fn_debit_walk` → if `'overage'`, invoke overage charge (same logic as charge-overage, in-process) → insert `walk_complete` notification (client) → low-credit check per spec 02 → Realtime broadcast `walk:{id}` event `ended`.
Response: `{ walk, billing: { outcome: 'debited'|'overage', cost_credits?, charged_pence?, payment_status? } }`
Idempotent: re-POST on a completed walk returns the stored result, no re-billing.

## create-checkout — POST, operator JWT
Body is exactly one of three shapes (review H32); the session params live in
`create-checkout/params.ts` as pure builders, and index.ts sends whichever one
through the **single** `checkout.sessions.create` call —
`checkout_session_test.ts` pins both the built objects and that wiring.

- `{ client_id, plan_id }` → `mode=subscription`, `price =
  plans.stripe_price_id`, `payment_method_collection=always`,
  `subscription_data.metadata = { client_id, operator_id, plan_id }`. The
  one-live-subscription guard applies to this shape only.
- `{ client_id, topup: { credits, amount_pence } }` → `mode=payment` with an
  ad-hoc `price_data` line item ("N walk credits"), metadata carrying
  `STRIPE_META.topupCredits`, and `payment_intent_data.setup_future_usage =
  'off_session'` — the paying card is saved, so one top-up makes a cash
  client fully chargeable. Credits and amount must be positive integers.
- `{ client_id, setup: true }` → `mode=setup`: card on file for a
  pay-per-visit client, under a `custom_text` mandate naming each priced
  service and its figure. Refused with `409 visit_price_missing` when no
  service has a visit price — a card saved under no stated terms is an
  off-session charge waiting to surprise somebody (H12), so the mandate is a
  precondition, not decoration. A top-up with nothing priced still runs (its
  own line item is its disclosure) and simply states no per-visit promise.

Common to all three: ownership asserts, `requireAccount`, get/create the
Stripe customer on the connected account (persist `stripe_customer_id`),
success/cancel URLs from `APP_BASE_URL`.
Response: `{ url }`.

**The billing address is collected and persisted (review L8).**
`billing_address_collection: "required"` with `customer_update: { address:
"auto", name: "auto" }`. Both halves are load-bearing and the second is the one
that is easy to lose: without `customer_update.address` Checkout collects the
address for the *payment* and never writes it to the Customer, so it would be
asked for and thrown away.

This does **not** enable tax. Sanpo calculates none, and doing it properly
means `automatic_tax` plus restructuring overage from a raw PaymentIntent —
which cannot carry tax at all — into an invoice. The address is collected now
because it is the half with a deadline: Stripe Tax cannot be enabled
retroactively for customers whose address was never captured, so the
alternative is asking every existing client for it later through a surface that
does not exist. `checkout_session_test.ts` pins both halves against each other.

**Stripe metadata keys are `sanpo_*` (review L23).** `change-plan` writes
`sanpo_plan_change_intent_id` and `sanpo_plan_id`; `stripe-webhook` reads them.
Both sides import the names from `_lib/stripe_metadata.ts` rather than writing
the literals, because these two functions never call each other — a rename
applied to one side would not fail to compile and would not fail a test that
mocks the other, it would silently stop matching, and a plan change the client
paid for would never apply. They were `pawtrail_*` and were renamed with no
dual-read: `deploy-production.yml` has never run, and no workflow, smoke suite
or e2e spec invokes `change-plan`, so nothing in any account carries the old
keys.

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

Verify `stripe-signature` with `STRIPE_WEBHOOK_SECRET`.

**Idempotency is a stateful claim ledger, not `ON CONFLICT DO NOTHING` (0013).**
This spec described the latter until the H21 reconciliation, and the difference
is the whole correctness argument: insert-and-ignore marks an event handled
*before* it is handled, so a handler that then fails leaves the event
permanently claimed and never processed — Stripe's redelivery is refused by the
very row that recorded the failure, and a cycle grant is silently lost.

`stripe_events` therefore carries state and its rows are never deleted:

- `claimEvent` inserts `status='processing'` and returns `claimed`,
  `duplicate` (already `processed` — ack with 200), or `in_flight` (another
  attempt holds a live claim).
- `markProcessed` flips the row only after every effect has succeeded.
- `in_flight` returns **409, not 200** — Stripe keeps retrying. Acking while
  the claimant could still fail is exactly how grants got lost.
- A claim stuck in `processing` past its **lease** is taken over by the next
  retry. That, not a release-on-failure, is what makes a crashed handler
  recoverable: a process that dies cannot run its own cleanup, so recovery
  cannot depend on it doing so.

`qc(1–4)` first added a release-on-failure; `rereview(money)` replaced it with
the lease, closing the race where two deliveries both saw an unclaimed row.

Setting `payment_status` to `refunded` interacts with this — see *Status sets*
below, and spec 02 on why `uq_payments_subscription_invoice` had to widen.
- `checkout.session.completed`, by session `mode` (review H32):
  - `subscription`: bind `stripe_subscription_id`, `subscription_status='active'`, `plan_id` from metadata.
  - `payment`: a Sanpo top-up, recognised by the `STRIPE_META.topupCredits`
    metadata key — any other payment-mode session is ignored. The client is
    resolved through the session's **customer** scoped to the event's
    operator, never through the metadata (which any operator can forge in
    their own dashboard); the credit count is validated as a positive
    integer; then `fn_apply_topup` records the payment and grants atomically,
    keyed on the PaymentIntent. Notifications (`payment_taken`, client and
    operator) fire only when this delivery actually granted — a redelivery
    must not re-announce.
  - `setup`: a card was saved. One operator-only `card_saved` bell row —
    the moment a pay-per-visit client becomes chargeable.
- `invoice.paid` (subscription): **scoped to the client's bound subscription** — an invoice for any other subscription on the same customer is ignored, exactly as the two `customer.subscription.*` arms already did. A customer can carry more than one live subscription and their invoices have *different* ids, so `uq_payments_subscription_invoice` does not catch it: the result was two cycle grants and two rollovers. An *unbound* client is still applied, because `checkout.session.completed` and `invoice.paid` race and refusing would drop the first cycle of every new subscription. `create-checkout` now also refuses to start a second subscription for a client who has one.

  **Rollover runs on renewals only.** `fn_apply_invoice_paid` takes `p_is_renewal`, true for `subscription_cycle` and false for `subscription_create`. Rollover carries what is left of the cycle that just ended; a first invoice has no prior cycle, and on `rollover_policy='none'` running it books an expiry for the entire balance — destroying credit the operator granted before billing started.

  Non-cycle invoices (a one-off charge on the same customer) take the plain
  path: record the payment if one is not already recorded. "Already recorded"
  means a row whose status is in `SUBSCRIPTION_INVOICE_STATUSES` — see
  *Status sets* below.

- `invoice.payment_failed`: `subscription_status='past_due'` + `payment_failed` notifications (client + operator) + payments row (failed). The status write happens on **every** delivery; the payments row and the notifications only on the first. Stripe retries a failed invoice on its own dunning schedule and each redelivery carries a *fresh event id*, so `stripe_events` cannot dedupe it — without a `failed`-row check the Money screen accrues one "Needs attention" entry per retry for a single unpaid invoice.
- `invoice.upcoming`: `renewal_upcoming` notification (client).
- `customer.subscription.updated`: map Stripe status/pause_collection → `subscription_status` (`paused` when pause_collection set), **and reconcile the plan against the subscription's price** (review H11).

  `plan_id` used to be written only inside `if (intent)`, so a price changed in
  the Stripe dashboard — which per B5/B6 is the only place a subscription's
  price exists to be edited — left `clients.plan_id` on the old plan. The
  divergence then self-perpetuated: `resolvePlan` short-circuited on the cached
  id, so every renewal granted the OLD plan's credits while Stripe collected
  the NEW price, with nothing flagging it.

  **Stripe is the source of truth for what is being billed.** Precedence:
  a matching plan-change intent wins (an in-app change carries the operator's
  stated intention and its bookkeeping); otherwise a price-derived plan that
  differs from the cache is written and the operator gets a
  `plan_changed_externally` notification. A price with no local plan is
  reported but **never** clobbers `plan_id` — nulling it would strand the
  client with no credits, and there is nothing correct to point at.

  The notification is self-limiting: it fires only when the ids differ, and the
  same event writes the correction, so an ordinary status change or period roll
  says nothing.
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
| `uq_topup_payment_per_intent` (0044) | succeeded, refunded, disputed | `fn_apply_topup`'s own check — SQL-side, same migration file as the index, pinned by the smoke replay-after-refund block rather than by `payment_status_test.ts` |

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
Body: `{ walk_id }` → assert walk `is_overage=true` and no live overage payment exists (idempotency, per *Status sets* above) → PaymentIntent `off_session=true, confirm=true`, customer default payment method → payments row (`type='overage'`, walk_id, status from PI). The walk stays completed in every failure case; the debt is visible in the billing console.

**Amount = the snapshot, not the live tables (H32, completing 0043/L7).**
`walks.overage_rate_pence` (the plan rate agreed when the walk was created),
else `walks.visit_price_pence` (the service's cash price at creation — the
pay-per-visit case; same `type='overage'` row and claim machinery, different
wording and PI description), else the live `plans.overage_rate_pence` for
pre-snapshot rows only. This line used to say "amount = client's
`plans.overage_rate_pence`" and that was the code: 0043's money-side snapshot
had zero readers, so a Settings edit re-priced every walk already on the
calendar. All three null → `failWithoutAttempt`, operator-only, naming the
Settings fix.
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

## send-notification — POST, service key (DB webhook) or operator JWT

Emails client-facing notifications through Resend, and **records what happened**
(review H17). `CLIENT_FACING` decides which types reach a client at all; the
rest are bell-only.

### Delivery is fire-and-forget no longer

The trigger is a Supabase Database Webhook on `notifications` INSERT, which is
`pg_net`-based and **does not retry on a non-2xx**. So a Resend outage, a rate
limit, or the sending domain falling out of verification lost the email
permanently: the function threw a 502, the webhook recorded a row in
`net._http_response` (short retention), and nothing on the notification said
anything. The in-app bell still showed it, so the system looked healthy from the
inside while the outside channel was dead — for `payment_failed` and
`walk_cancelled` among others.

0029 adds four columns and an `email_delivery_status` enum. Four states, not a
bare `sent_at`, because "not sent" is three different things and a sweep that
cannot tell them apart either retries forever or abandons real failures:

| State | Meaning | In the retry backlog? |
| --- | --- | --- |
| `pending` | nobody has looked at it | yes |
| `sent` | it left | no |
| `skipped` | **terminal** non-send: operator-only, or the client has no address | **no** |
| `failed` | provider or we broke | yes, within bounds |

A **skip does not increment `email_attempts`** — it is a decision, not a try, and
counting it would march terminal rows toward the give-up ceiling for no reason.

**A missing `RESEND_API_KEY` is now a 500.** It used to return
`{ ok: true, skipped: true }`, so a deploy that forgot the secret reported
uniform success forever while sending zero email. Since H14 that 500 also writes
a log line naming what is missing.

### Bounds, and giving up on purpose

`fn_notification_backlog(window, max_attempts)` returns what is retryable:
non-terminal, inside 24 hours, under 5 attempts. Deliberately **not** filtered by
notification type — that list lives in `CLIENT_FACING` and duplicating it in SQL
would give it two homes and one would drift. Instead the function marks anything
it will not send as `skipped` the first time it sees the row.

`fn_expire_notification_backlog()` marks rows terminal once they age out or hit
the ceiling, and returns how many it abandoned. Without it the backlog grows
forever and every future check reports the same dead rows; with it, the
*retryable* backlog stays bounded and the abandoned count is itself the thing
worth reporting. It is idempotent — a row already carrying a give-up note must
not accrue a second one nightly.

Rows predating 0029 are backfilled to `skipped` with "unknown whether sent". We
genuinely do not know, and retrying would send a client "your walk is complete"
about a walk from last month — the same call 0023 made about untraceable
payments.

### Who retries

`POST { action: "drain" }`, **service role only** — a client triggering a mass
send would be a mail-bomb and a way to burn the operator's Resend quota. It
carries on past a failure, since one bad recipient must not strand the rest of a
backlog somebody is already owed, and returns 200 even with failures: each row
records its own outcome and stays queued, so reporting success for the *attempt*
is honest.

`.github/workflows/job-health.yml` drains daily and **goes red if a backlog
survives the retry** — a blip clears, a misconfiguration does not.

### Not client-writable

0004 grants `authenticated` only `update (read_at)`, a **column-level** grant, so
the four delivery columns are unwritable by a client with nothing further added.
That is the existing design being right rather than luck, and smoke.sql asserts
it: a later table-level `grant update on notifications` would silently let a
client mark their own `payment_failed` email as sent.

## credential-vault — POST, operator JWT
Body: `{ action: 'put'|'get'|'delete', credential_id?, property_id?, entry_method?, label?, secret?, purpose?, walk_id?, password }`
Every action re-verifies `password` against the caller's account (Auth admin
check); rate-limit 5/min/user (Postgres-backed, 0016 + 429).

**Order of checks, and why it is not arbitrary (review M2).** The limiter used
to run FIRST, so every request burned a slot in the window — including requests
that could never have succeeded. An operator who signed up with a magic link
has no password to type (`signInWithOtp` creates the account and no operator
path anywhere sets one), so five attempts at a password that cannot exist
returned 429 and locked them out of the vault entirely, on a doorstep, with no
way to fix it inside the product. The message they got was "password
verification failed", which reads as a typo to somebody with nothing to
mistype.

The limiter exists to bound password GUESSING, so it now sits directly in
front of the guess:

1. `password` present, and the account has an email — 401, no slot consumed.
2. **`fn_account_has_password` (0035)** — if not, `409 password_not_set` with a
   message naming the fix. No slot consumed, and deliberately NOT audited: no
   password was checked, so recording it as a failed re-auth would fill the
   trail with configuration noise in the one log that has to make a real attack
   visible. It is not a blind spot either — to read a credential an attacker
   must first set a password, after which the reveal writes an ordinary audit
   row carrying their IP.
3. `allowAttempt` — the guess is about to happen.
4. `verifyPassword`; a failure is audited and refused.

GoTrue cannot make this distinction for us: it returns the same
`invalid_credentials` for "wrong password" and "no password set", deliberately,
so that sign-in is not an account-existence oracle. `auth.users
.encrypted_password` is the only honest signal, and it is not reachable through
PostgREST — hence the definer function, whose body check lets the service role
ask about anyone and a signed-in user ask only about themselves, so it does not
become the oracle GoTrue avoids being.

The client resolves this before the doomed request is ever made: `ReauthSheet`
checks on open and offers to SET a password, then continues straight to the
action the operator was taking. That lives in the sheet rather than at each
`reauth()` call site because there are four of them and a fifth will exist.
- `put`: encrypt `secret` → `fn_write_credential` (new) or `fn_rotate_credential` (existing).
- `get`: `fn_read_credential` → decrypt → `{ secret, label, entry_method }`. `purpose` required, non-empty; `walk_id` optional.
- `delete`: `fn_revoke_credential` — a soft revoke setting `revoked_at`. The audit log is immortal.

Plaintext secrets never appear in logs, errors, or analytics.

### There is no unencrypted hint (review H3)

`key_location_hint` is **gone**, and this spec used to authorise it. It was an
ordinary column with SELECT, INSERT and UPDATE granted to `authenticated`,
rendered inline in the credential list with no re-auth, no audit row and no
rate limit, and its placeholder read verbatim *"Left of the porch, behind the
planter"* — so the field actively coached a means of entry into plaintext,
sitting beside `properties.address_line1`. One `GET /rest/v1/properties` plus
one `GET /rest/v1/access_credentials` with a borrowed session returned, for
every client: full residential address, entry method, and where the key was
hidden. For a `key_on_file` or `lockbox` client, AES-GCM was protecting the
less useful half of the secret.

Dropped rather than encrypted in place. `label` already exists to tell
credentials apart, and the secret field's own placeholder ("Code, key location,
alarm sequence…") always covered key locations — so a second encrypted column
would add a reveal path, an audit event and a decision for the operator, for
nothing. **Key locations belong in the encrypted secret.**

### Every action is audited, not one in four

`credential_access_log` was written in exactly **one** place — inside
`fn_read_credential`, on a successful reveal. Create, rotate, revoke and a
failed re-auth wrote nothing.

That is why the trail could answer neither of the questions it exists for. In
the scenario the product implicitly promises to handle — a client is burgled and
the walker is a suspect — the log said "opened 14:02, purpose 'pre-walk entry'",
where the purpose was typed by the suspect. And "who changed my garage code on
the 14th" had only a `rotated_at` that the next rotation overwrote, so a door's
code history was exactly one entry long.

| Action | Written by | Purpose |
| --- | --- | --- |
| `read` | `fn_read_credential` | required |
| `create` | `fn_write_credential` | — |
| `rotate` | `fn_rotate_credential` | — |
| `revoke` | `fn_revoke_credential` | — |
| `reauth_failed` | `fn_log_credential_action` | — |

Every row carries the caller's **IP** and **user agent**, captured by the edge
function. `walk_id` is optional on a read and is validated against the operator
**and** the property — a walk reference pointing elsewhere would make the trail
worse than empty, since it would attribute an entry to a visit that was
somewhere else. The purpose is still required for a read; the walk is the half
the system can vouch for independently of what the caller typed.

The writes go through definer functions so the row and its audit entry land in
**one transaction**. Two statements from the edge function could half-succeed,
and the half that survives would be the one that changes the door.

A **failed re-auth** is recorded before the refusal, and best-effort: if the log
write itself fails the caller is still refused, because a 500 there would tell
an attacker they had found a way to turn the audit trail off.

### The log is append-only and the client can read it

It had no mutation-block trigger at all — unlike `credit_ledger` — so the
operator whose reads it records could rewrite or delete them through PostgREST.
An audit trail its own subject can edit is not one. `INSERT`/`UPDATE`/`DELETE`
are revoked from `authenticated` entirely and a `BEFORE UPDATE OR DELETE`
trigger raises, so every row comes from a definer function.

The **client** now has a SELECT policy scoped through credential → property →
client, plus one on the credential metadata so the trail has something to name.
The ciphertext column stays revoked from every API role (invariant 2). Surfaced
read-only on the portal home as *Entry code activity*, showing no IP or user
agent — those describe the operator's device, and a client does not need their
walker's IP to know their door was opened.

## billing-portal — POST, client JWT (phase 07)
Body: none. Returns `{ url }` — a Stripe customer-portal session for
payment-method, pause and cancel self-service.

Resolves the client from `auth_user_id`, then creates the session **on the
operator's connected account**: the Stripe customer lives there (review B5), so
a session created on the platform account 404s on a customer id that looks
perfectly valid.

Uses `accountOf`, deliberately **not** `requireAccount`. This path does not take
money, and blocking a client from updating a card or cancelling because Stripe
has charges paused on their walker would strand them with a subscription they
cannot stop. A client with no `stripe_customer_id` gets `409 no_billing`.

## vault-rekey — POST, service-role only (review B2)
Body: `{ action: 'verify'|'status'|'rekey', batch? }`. **Never returns a
plaintext or any key material**; the only secrets it touches are in memory for
the length of one re-encryption.

A separate function from credential-vault on purpose: that one is the
operator-facing path and requires an operator JWT plus a fresh password
re-auth on every action. These are machine paths called by CI with the
service-role key, and adding a non-operator auth path to the most sensitive
function in the product to save a directory would be a bad trade.

- `verify` — can the deployed key read this project's data? Decrypts the
  `vault_canary`, installing one if there is none. **This is the deploy gate**:
  a wrong key fails here rather than at a client's front door.
- `status` — `fn_vault_census`, for the rotation report. Four numbers, not one,
  because `on_other = 0` is also true when nothing is visible.
- `rekey` — re-encrypt one batch onto the current key via
  `fn_vault_rewrap_batch` → `fn_vault_rewrap_apply` (a compare-and-swap on the
  exact ciphertext read). Idempotent and resumable; the work queue is the data,
  so run it until nothing is left. Runbook: `docs/dev/vault-key-rotation.md`.

## change-plan — POST, operator JWT (built in phase 07; durable since 0015)
Body: `{ client_id, new_plan_id }` → Stripe: update the subscription item to the
new price with `proration_behavior='create_prorations'`.

**The local effect is applied by the webhook, not by this function (0015).**
This spec described the direct `fn_change_plan` call until the H21
reconciliation; that design moves the Stripe subscription and then applies the
credit side in the same request, so a failure between the two leaves Stripe on
the new plan and Sanpo's database on the old one — a client billed at one rate
and credited at another, with nothing to reconcile from.

The order is therefore intent-first:

**`resolvePlan` prefers the invoice line's price over `clients.plan_id`**
(review H11). The cached id is the fallback for invoices carrying no resolvable
line price, and for a price this operator has no plan for — granting the last
known plan beats granting nothing, and the subscription arm has already told
the operator. `invoice.paid` also corrects `plan_id` when the two disagree,
which is the safety net for a dropped `customer.subscription.updated`; that
line was unreachable before the precedence changed, because `resolvePlan`
returned the cached plan and the ids could never differ.

1. `fn_record_plan_change_intent` writes a `pending` row in
   `plan_change_intents` carrying `remaining_fraction` (computed from the
   current period bounds) and a `stripe_update_idempotency_key`, **before**
   Stripe is touched. `0018` enforces at most one pending intent per client, so
   a double-submit cannot queue two conflicting changes.
2. The Stripe update is sent under that idempotency key, so a retried request
   cannot move the subscription twice.
3. `customer.subscription.updated` arrives and calls
   `fn_apply_plan_change_intent(intent, event_id)`, which applies
   `fn_change_plan` and flips the intent to `applied`. `stripe_event_id` is
   `unique`, so a redelivered event applies the proration exactly once.

Response: `{ new_balance, plan }` reflects the intent as recorded; the durable
plan change lands when the webhook does. `plan_change_intents` is service-role
only — `revoke all … from public, anon, authenticated`.

## materialize-walks — scheduled (cron, phase 06) + POST operator JWT for manual run
For each active schedule: generate `walks` rows for the next 14 days for matching `days_of_week`, skipping dates inside pause windows, client `status='paused'`/`'archived'`, and dates < `start_date` / > `end_date`.

**Subscription state is an allow-list, not a deny-list (0026).** Walks are generated only for `subscription_status in ('active','none')`. It read `<> 'paused'`, which was the sole subscription predicate — so a client who had cancelled, or whose card had failed, kept having walks generated nightly that the operator performed and could not bill. An allow-list also fails *closed*: a value added to the enum later stops generating work until somebody decides what it means, rather than silently producing unbillable walks.

`'none'` is deliberately included — that is a client who never subscribed, whom the operator may bill outside Sanpo. `past_due` is excluded by owner decision: service halts until payment clears. `fn_book_walk` carries the identical predicate, so client self-booking and nightly materialization cannot disagree. Idempotent via the `(schedule_id, scheduled_date)` unique index (`ON CONFLICT DO NOTHING`).
Response: `{ created, expired_clients, expiry_error, walks_flagged_abandoned, stale_walk_error }`.

## unsubscribe — public, unauthenticated, token-only (0038, review M29)

The only endpoint in this project with `verify_jwt = false` besides the Stripe
webhook, and for a reason that has no alternative: `clients.email` is typed by
the operator and reconciled with nothing, so a typo sends a **stranger** a
recurring feed of when a named person's house is empty. That person cannot sign
in — they are not a client and claimed no invite — so an opt-out behind a
session is no opt-out at all for exactly the recipient who most needs one.

`clients.unsubscribe_token` is the credential: unguessable, carried only in
mail already addressed to that person, withheld from the API roles by column
privilege (0004's table-level SELECT on `clients` had to be replaced with an
explicit column list — a column REVOKE against a table-level grant is a no-op),
and rotatable by re-issuing it.

**GET is the primary method here, and it is the only function where that is
true.** The link lives in an email and a person clicks it; RFC 8058 one-click
then POSTs. `serveFunction` refuses any non-POST with 405 *before* it calls the
handler, which is what protects the money paths from a charge that can be
prefetched or linked — so widening is opt-in per function
(`serveFunction(handler, { methods: ["GET", "POST"] })`) and visible at the call
site. This function shipped without declaring it, so every recipient who
clicked got a JSON 405: its tests drove the handler and never went through the
gate. Any new function that answers something other than 405 to a GET must also
be given a contract in `scripts/verify-deployment.sh`, which probes exactly
this.

Three deliberate non-features:

- **It never says whether a token exists.** `fn_unsubscribe_by_token` answers
  identically either way, and raising is an oracle too, not just returning
  false. An unauthenticated endpoint that distinguishes them is a way to
  enumerate them.
- **It takes no other input.** No address, no client id, no scope. A public
  endpoint that accepts an address is a way to unsubscribe somebody else.
- **It is not rate-limited.** A valid token only ever suppresses its own
  address and the operation is idempotent, so there is nothing to gain by
  calling it repeatedly.

Suppression is keyed on the **address**, not the client, and defaults to every
operator and every type. The wrong recipient has no client row of their own, so
suppressing "this client" would let the same address start receiving again the
moment the operator corrects and re-enters it.

`send-notification` asks `fn_email_suppressed` before every send and **fails
closed**: an unreadable suppression list is recorded as a retryable failure, not
sent anyway, because sending is the one outcome here that cannot be taken back.
An actual suppression is TERMINAL — recorded as `skipped`, never as `failed`,
or the nightly drain would retry it every night against somebody who asked us
to stop.

Every email carries `List-Unsubscribe` **and** `List-Unsubscribe-Post:
List-Unsubscribe=One-Click` (RFC 8058) plus a visible link, since the header is
honoured by the big mail clients and the link is what works everywhere else.
The URL points at the function host, not the app: a one-click POST comes
straight from the mail client, and a client-side SPA route cannot serve a POST
at all.

### The schedule lives in a migration, not a dashboard (0028)

`cron.schedule('sanpo-nightly', '0 3 * * *', 'select fn_run_nightly_jobs()')`.
It was a hand-typed Supabase dashboard entry carrying a pasted service-role
bearer header — in no migration, no workflow and no restorable form. Nothing
asserted it existed, a project restore did not recreate it, and because the
horizon is 14 days a stopped cron was invisible for a fortnight (review H15).

**No credential is involved, and that is not a shortcut.** `fn_is_service_session()`
accepts `session_user = 'postgres'`, and a pg_cron job runs as the role that
scheduled it — postgres, since migrations are applied as postgres. So the job
calls the SQL directly: no key, no Vault secret, no HTTP hop, no `pg_net`.
This also fixes detection rather than working around it, because the dashboard
cron marked a run "successful" once the HTTP call was **dispatched** — a 500
from the function was indistinguishable from a good night, which is why the
old runbook told you to go and read `net._http_response` by hand.

The **edge function remains** as the manual path (Calendar → "Run
materializer") and is what the staging smoke suite exercises. It calls the
same `fn_run_nightly_jobs()`, so the two cannot drift.

### The advisory sweeps are advisory, not silent

`fn_run_nightly_jobs` runs materialization first and lets it propagate: if
walk generation is broken the run must fail loudly. The credit-expiry sweep
and the abandoned-walk sweep are each wrapped, so a failure does not cost the
operator a calendar — but the error is **recorded and returned**
(`expiry_error`, `stale_walk_error`) and the run is marked not-ok.

The old code had this exactly backwards: `if (!sweep.error) expired = …` meant
a permanently failing sweep read identically to a quiet night. Clients kept
credits they had already been billed for and stopped paying overage — a
revenue leak with no symptom anywhere.

`job_runs.error` therefore carries **both**, joined with ` | `, rather than
`coalesce(first, second)`. Coalescing looks harmless and rebuilds the same
swallow one level up: a permanently failing sweep stays invisible for as long
as any other sweep is also failing.

### fn_sweep_abandoned_walks — the walk that never ended (0036)

`complete-walk` is the only exit from `in_progress`, and there was no maximum
duration and no stale sweep. An operator who forgot to press END WALK — or
whose phone died — left a walk that never billed, never sent the client their
report, and was **invisible**, because Today fetches `{ date: today }` and
yesterday's abandoned walk is not today's (review M28).

The sweep stamps `walks.abandoned_at` on `in_progress` walks whose
`started_at` is more than six hours old. It deliberately does **not**
auto-complete them and does not invent an end time or a distance: completing
means BILLING, and a duration produced by a cron job is not something to
charge a client for. Silently charging is a worse failure than silently not
charging, because the client sees it and the operator does not. The walk stays
`in_progress` so `complete-walk` can still finish it properly.

`started_at`, not `scheduled_date` — a walk started at 23:50 is barely an hour
old at midnight, and sweeping by calendar day would flag it while the operator
is still on the doorstep. `abandoned_at is null` keeps the sweep idempotent, so
"how long has this been sitting there" survives the second night.

### Did it run?

Every run writes a `job_runs` row (job name, start, finish, ok, detail,
error). `fn_job_health(p_stale_after default 26 hours)` reports the last
success per job and whether it is stale, and **fails closed**: a job that has
never succeeded reads `stale = true`, not unknown, because a fresh or restored
project is exactly the case the check exists to catch. `.github/workflows/job-health.yml`
asks daily at 06:00 UTC and goes red otherwise.

That workflow is a heartbeat check, not monitoring — one cron watching
another, sharing their failure modes. Real alerting is review H14 and does not
exist yet.

`job_runs` is deliberately **not** a tenant table (invariant 7 does not apply):
the materializer runs across every operator at once, so no `operator_id` would
be true of a run. RLS on, no policies, no grants to `anon`/`authenticated`.
