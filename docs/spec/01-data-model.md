# 01 — Data model

All `id` columns `uuid default gen_random_uuid() primary key` unless noted. All tables get `created_at timestamptz default now()`; mutable tables also get `updated_at` (trigger-maintained). Every tenant table carries `operator_id uuid not null references operators(id)` with an index. Money = integer pence. FKs `on delete restrict` unless noted.

## Enums (migration 0001)
- `entry_method`: key_on_file · lockbox · smart_lock · door_code · buzzer_fob
- `walk_status`: scheduled · in_progress · completed · cancelled · no_show
- `ledger_entry_type`: grant · debit · adjust · rollover · expiry
- `payment_type`: subscription · overage · topup
- `payment_status`: pending · succeeded · failed · refunded
- `client_status`: invited · active · paused · archived
- `subscription_status`: none · active · paused · past_due · cancelled
- `pet_size`: small · medium · large · giant
- `rollover_policy`: none · capped · unlimited
- `billing_cycle`: weekly · monthly
- `notification_type`: walk_complete · low_credit · renewal_upcoming · payment_failed · walk_scheduled · walk_cancelled · payment_refunded · payment_disputed · subscription_cancelled · plan_changed_externally · payment_taken

## Tables (migration 0002)

**operators** — `id` = `auth.users.id` (no default). `business_name`, `display_name`, `email`, `phone`, `timezone text default 'America/Chicago'`, `currency char(3) default 'USD'`, `low_credit_threshold int default 2`.
Insert trigger seeds default service types (below).
Sanpo's own revenue (review H31, 0045): `trial_ends_at timestamptz not null default (now() + interval '14 days')`, `platform_customer_id` / `platform_subscription_id` (Stripe ids on the PLATFORM account — never to be confused with `clients.stripe_*`, which live on the operator's connected account), `platform_subscription_status subscription_status default 'none'` (`trialing` maps to `active`), and `checkout_mint_claimed_at` (the per-operator checkout-mint lease serializing `operator-billing`'s session creation — Codex review on PR #77, spec 04). None of the five is writable by any API role — the 0045 grant rework replaced the table-level INSERT grant with an explicit column list, which also closed a pre-existing hole (an operator could forge `stripe_charges_enabled` at row creation; 0024 revoked UPDATE only). The app-side gate reads them through role resolution (`operatorAccess`, spec 06).

**clients** — `operator_id`, `auth_user_id uuid null unique` (linked on invite claim), `full_name`, `email`, `phone`, `status client_status default 'invited'`, `notes text`, `invite_token uuid default gen_random_uuid() unique`, `invite_expires_at timestamptz default now() + 14 days`, `invite_revoked_at timestamptz null`, `stripe_customer_id text`, `plan_id uuid null references plans`, `subscription_status subscription_status default 'none'`, `stripe_subscription_id text`, `credit_balance int not null default 0 check (credit_balance >= 0)` ← denormalized, definer-only write (spec 03). Plus `purged_at timestamptz null` (review H5 — set when the personal data was destroyed; the row survives because the ledger references it).

**properties** — `operator_id`, `client_id`, `label` (e.g. "Home"), `address_line1`, `address_line2`, `city`, `postcode`, `access_notes_public text` (non-secret: "gate sticks, lift on left"), `lat/lng double precision null`.

**access_credentials** — `operator_id`, `property_id`, `entry_method entry_method`, `ciphertext bytea not null` (versioned AES-256-GCM blob per spec 04), `label text` ("front door", "alarm"), `key_id` (GENERATED, 0021), `rotated_at timestamptz`, `revoked_at timestamptz`. One row per secret; a property may hold several.

There is **no** `key_location_hint`. It existed until 0030 as an ordinary, client-readable, unaudited column whose placeholder coached a means of entry — so for a lockbox client AES-GCM was protecting the less useful half of the secret (review H3). Key locations belong in the encrypted `ciphertext`; `label` is what distinguishes credentials in a list.

**credential_access_log** — `operator_id`, `credential_id references access_credentials on delete cascade`, `accessed_by uuid` (auth uid), `purpose text not null`, `accessed_at timestamptz default now()`. Append-only; no UPDATE/DELETE grants to anyone but service role.

**pets** — `operator_id`, `client_id`, `name`, `breed`, `size pet_size`, `temperament text`, `medical_notes text`, `feeding_notes text`, `medication_notes text`, `vet_name`, `vet_phone`, `is_reactive bool default false`, `is_escape_risk bool default false`, `photo_path text` (Storage), `active bool default true`.

**service_types** — `operator_id`, `name`, `duration_minutes int`, `credit_cost int not null check (credit_cost > 0)`, `weekend_surcharge_credits int default 0`, `visit_price_pence int null check (visit_price_pence > 0)` (0044, review H32 — the cash price one visit is charged at for a client on no plan; null = this service is not offered pay-per-visit, and zero is refused because "free" and "unconfigured" must not share a value), `is_default bool default false`. Seeded per operator: "Private walk 30" (30 min, 1 credit, default), "Private walk 60" (60 min, 2 credits). Effective cost of a walk = `credit_cost` + `weekend_surcharge_credits` when `scheduled_date` is Sat/Sun (computed in `fn_walk_cost`, spec 02).

**plans** — `operator_id`, `name`, `credits_per_cycle int`, `price_pence int`, `cycle billing_cycle`, `rollover_policy rollover_policy default 'none'`, `rollover_cap int null` (required when capped), `rollover_expiry_days int null`, `overage_rate_pence int not null`, `stripe_price_id text`, `active bool default true`.

**recurring_schedules** — `operator_id`, `client_id`, `property_id`, `service_type_id`, `days_of_week int[] not null` (1=Mon…7=Sun), `window_start time`, `window_end time`, `start_date date`, `end_date date null`, `paused_from date null`, `paused_until date null`, `active bool default true`.
**schedule_pets** — `schedule_id references recurring_schedules on delete cascade`, `pet_id`, PK (schedule_id, pet_id). Plus `operator_id`.

**walks** — `operator_id`, `client_id`, `property_id`, `service_type_id`, `schedule_id uuid null references recurring_schedules on delete set null`, `scheduled_date date`, `window_start time`, `window_end time`, `status walk_status default 'scheduled'`, `started_at timestamptz`, `ended_at timestamptz`, `credits_debited int default 0`, `is_overage bool default false`, `distance_m int`, `notes text`, `potty_pee bool`, `potty_poo bool`, `fed bool`, `watered bool`, `report_sent_at timestamptz`, `abandoned_at timestamptz` (0036 — stamped by the nightly sweep when a walk has been `in_progress` far longer than any real visit; the walk stays `in_progress` so it can still be completed properly). Price snapshots, written by the BEFORE INSERT trigger `trg_walks_snapshot_price` and UPDATE-granted to no API role: `cost_credits int null` and `overage_rate_pence int null` (0043) plus `visit_price_pence int null check (> 0)` (0044) — the credit cost, plan overage rate and service visit price in force when the walk was created, which is what the walk is charged at (spec 02). Null means "no snapshot", never "free". Any price-bearing edit to a service's visit price also fills the null snapshots of *scheduled* walks belonging to **clients without a live plan subscription** (`trg_service_types_visit_price`, 0044) so the materializer's 14-day queue is priceable the day an operator adopts pay-per-visit; it can only fill nulls, never rewrite, it skips clients whose plan subscription is LIVE (their un-snapshotted pre-0043 walks charge correctly through the live plan-rate fallback, and stamping would put the cash price ahead of it — while a cancelled client's retained plan prices nothing, so their walks ARE stamped), it takes its walk row locks in id order (matching `fn_purge_client`), and firing on every edit rather than only the null→value edge is the self-heal for a narrow race in which a concurrently inserted walk is priced by neither the INSERT snapshot nor the backfill. Unique partial index `(schedule_id, scheduled_date) where schedule_id is not null` — materializer idempotency.
**walk_pets** — PK (walk_id, pet_id), `operator_id`; walk_id `on delete cascade`.

**walk_gps_points** — `walk_id references walks on delete cascade`, `operator_id`, `recorded_at timestamptz`, `lat`, `lng`, `accuracy_m real`. Index `(walk_id, recorded_at)`. Batch-inserted (spec 06).

**walk_photos** — `walk_id on delete cascade`, `operator_id`, `storage_path text`, `caption text`, `taken_at timestamptz`, plus the `0047` integrity record: `sha256 text` (lower-case hex, `check (sha256 ~ '^[0-9a-f]{64}$')`) and `byte_size integer` (`check (byte_size > 0)`), both **nullable and never backfilled**.

The digest is computed in the browser over the bytes actually uploaded and written once with the row. There is no `UPDATE` grant on this table for any API role, so neither column can be rewritten by the writer that produced it — that is what makes it a record of the past rather than a description of the present, which is precisely what Storage's own regenerated `metadata` (`size`, `eTag`) cannot be.

`NULL` is a third state meaning **not recorded**, never "failed": rows predating `0047`, rows written by `complete-walk` (which replays paths from the completion request and has no bytes to hash), and any runtime without `crypto.subtle`. `complete-walk`'s upsert must stay `ON CONFLICT DO NOTHING` — a `DO UPDATE` replay would blank a digest the browser recorded, with no grant to restore it.

**This is not tamper evidence.** The operator holds `DELETE` on the table alongside `INSERT`, so a row can be removed and re-inserted with a digest matching whatever bytes were uploaded second. It detects storage divergence — a replaced object, a faithless restore, bit-rot — and a mismatch must never be reported as tampering. `scripts/verify-photo-integrity.sh` is the consumer and reports match / mismatch / not-recorded plus coverage.

**credit_ledger** — `operator_id`, `client_id`, `entry_type ledger_entry_type`, `amount int not null check (amount <> 0)` (signed: grants/rollover +, debit/expiry −, adjust ±), `balance_after int not null`, `walk_id uuid null`, `expires_at timestamptz null` (rollover lots), `note text`. Append-only; insert path is definer-only (spec 02/03). Index `(client_id, created_at desc)`.

**payments** — `operator_id`, `client_id`, `walk_id uuid null`, `type payment_type`, `amount_pence int`, `currency char(3) default 'USD'`, `stripe_payment_intent_id text`, `stripe_invoice_id text`, `status payment_status`, `receipt_url text`. `stripe_invoice_id` holds the id of the Stripe object that paid — an `in_…` invoice for subscription rows, and since 0044 the `pi_…` PaymentIntent for `topup` rows, where it doubles as the grant↔money trace `fn_reverse_payment` claws back through (the namespaces are disjoint, and `uq_payments_subscription_invoice` filters `type='subscription'`, so they never collide). Top-up idempotency: `uq_topup_payment_per_intent` on `(stripe_payment_intent_id) where type='topup' and status in ('succeeded','refunded','disputed')` — the reversal statuses are in the set so a refunded top-up keeps holding its slot against Stripe's three-day redelivery.

**notifications** — `operator_id`, `client_id uuid null` (null ⇒ operator-facing), `type notification_type`, `title text`, `body text`, `walk_id uuid null`, `read_at timestamptz null`.

**stripe_events** — `id text primary key` (Stripe event id), `type text`, `payload jsonb`, `processed_at timestamptz default now()`. Webhook idempotency ledger.

## Storage buckets
- `pet-photos` (public read via signed URLs), `walk-photos` (private; signed URLs in report cards). Path convention `{operator_id}/{entity_id}/{uuid}.jpg`; RLS on `storage.objects` scopes by first path segment.

## push_subscriptions (0049, review M27)

Web Push device registrations. A tenant table — `operator_id` plus RLS, per
invariant 7 — with `client_id null` meaning the operator's own device, the
convention `notifications` already uses.

`endpoint` is UNIQUE and is the device's identity, not the person's. That
distinction is the whole design: on a shared phone two people can present the
same endpoint, so `fn_register_push_subscription` upserts on it and REASSIGNS
ownership. A row left attached to the previous person sends their walk reports
to a lock screen somebody else is holding.

The reassignment is CONDITIONAL on presenting BOTH halves of the endpoint's
existing key material (Codex review on PR #85). `p256dh` alone is not proof:
it is the ECDH public key, semantically not a secret, and the update replaces
`auth` as well — so checking only the public half let anyone holding the
endpoint and that key take the row and overwrite the secret one, which
silences the victim. Unconditional, it contradicted the reason
`fn_remove_push_subscription` is scoped to its caller — an endpoint is not
secret enough to authorize acting on it — and let any authenticated caller who
learned an endpoint claim that row, stopping the victim's notifications and
delivering the claimant's onto the victim's device. The key check is the right
discriminator because the genuine shared-device case presents endpoint and
keys TOGETHER: `pushManager.subscribe()` against an existing registration
returns the existing subscription object.

`endpoint` must also name a push service this system will POST to, checked by
`fn_is_push_service_endpoint` at registration and again by
`isPushServiceEndpoint` before the send (Codex review on PR #85). Accepting any
https url made this a server-side request forgery primitive available to every
authenticated caller: register an endpoint aimed wherever you like, trigger a
notification addressed to yourself, and read the outcome back off
`notifications.push_last_error`, which `authenticated` may select. The quota
below is not a substitute — it bounds how much outbound work a caller can
cause and says nothing about where it goes.

The list is four services, each read rather than recalled: `fcm.googleapis.com`
(Chrome, Chromium, Brave, Opera, Edge on Android),
`updates.push.services.mozilla.com` (Firefox), `web.push.apple.com` (Safari),
and `*.notify.windows.com` (Edge / WNS), plus the regional siblings
`*.push.apple.com` and `*.push.services.mozilla.com`. Each suffix carries a
LEADING DOT, which is load-bearing rather than cosmetic: without it,
`notify.windows.com` is also a suffix of `evilnotify.windows.com`, a domain
anyone can register.

The rule existing twice means the two halves can disagree, and they did: `URL`
normalises an uppercase scheme and an explicit `:443` away and the POSIX regex
did not, so the sender accepted two endpoints registration refused. Neither was
a hole — registration is the stricter side, so no row could carry one — but
"one list, one rule" is the whole claim the two halves make together.
`app/scripts/push-service-hosts.test.ts` compares the two LISTS;
`scripts/check-push-endpoint-parity.sh` asks both implementations the same
questions from one case list (`scripts/push-endpoint-cases.txt`) and compares
the ANSWERS. It is its own gate because no single test runner here has both a
database and deno.

**Stated residual:** a browser whose push service is not on that list cannot
enable notifications. It is refused at registration, by name, so the failure is
a sentence somebody can act on rather than a switch that reads "on" and never
delivers — and the fix is one entry in two places that
`app/scripts/push-service-hosts.test.ts` keeps in step. Samsung Internet is the
known unknown: its Android push service hosts are documented, but whether its
WEB push endpoints use them or FCM could not be established from here, so
nothing was added on a guess.

Registration resolves the caller's client under a ROW LOCK and refuses a
tombstone (Codex review on PR #85). Unlocked and unfiltered, a registration
that began before an erasure inserted its row after `fn_purge_client` had
tombstoned the client and the trigger had deleted every device it knew about —
an endpoint identifying a browser, surviving the erasure request H5 exists to
honour. The lock is what closes it and the predicate alone would not: the
purge takes `for update` on that row, so the read waits for it and then
re-reads the committed tombstone. Both are load-bearing and neither is
redundant, which is not an assumption — `concurrency.sh` case 8 goes red
without the predicate and case 8b without the lock, each closing an interleave
the other does not. Nothing sequential can reach it, because the purge NULLs
`auth_user_id` and `my_client_id()` then returns null.

The per-recipient advisory lock is keyed on the CLIENT where there is one and
on the operator otherwise, never on the pair. A client belongs to exactly one
operator, so the pair says nothing extra — and the single-value key is what
lets the advisory lock be taken BEFORE the `clients` read, since the pair
cannot be computed until `operator_id` has been read. That ordering matters:
`fn_invite_signup_allow_attempt` (0048) takes advisory-then-clients on a key
derived the same way, and two functions taking the same two locks in opposite
orders is the 0037 cycle.

**Stated residual:** a browser that recycled an endpoint under a fresh keypair
would also be refused, and the stale row is invisible to the new owner
(SELECT is scoped per persona). No implementation is known to do this — the
subscription object is stable per registration and application server key —
and the alternative, accepting any claim that presents new keys, is the hole
itself. A row in that state is already undeliverable, since payloads would be
encrypted to keys the browser no longer holds.

**VAPID key rotation.** A `PushSubscription` records the application-server
key it was created under, and the push service refuses a payload signed by any
other one. So after a rotation — or in the window where the frontend and the
edge function carry different keys, which the deploy order makes reachable —
an existing subscription stays non-null and is completely dead: every send is
rejected while `getSubscription()` keeps saying yes. `subscriptionUsesKey()`
compares the bound key against the configured one, and the answer is used in
three places, because a helper the call sites ignore fixes nothing: a
mismatched device reads as `off` rather than `on` (so it is offered a re-opt-in
instead of only an OFF switch), `enablePush()` unsubscribes it before
subscribing (`pushManager.subscribe()` rejects with `InvalidStateError` when a
subscription exists under different options, so without this the offered action
would throw), and `reclaimPushDevice()` leaves it alone rather than keeping a
row alive that no send can reach.

It **fails open**, on both sides of the comparison. `options.applicationServerKey`
is not readable everywhere, and answering "stale" because we could not look
would unsubscribe working devices on that browser — a browser limitation turned
into lost notifications. The **configured** key gets the same treatment: a
setting truncated in a dashboard is still valid base64url, so it decodes
without throwing and then differs from every real subscription, which would
condemn working devices over a typo while the edge function still holds the
good key. An application-server key is an uncompressed P-256 point — 65 bytes
beginning `0x04` — and anything else is treated as no evidence rather than as
evidence of a mismatch. That is a shape check and not a curve check on purpose:
a 65-byte non-point still reaches `subscribe()`, which refuses it loudly, and
this rule exists only to stop a malformed setting DESTROYING a working
subscription. No trustworthy evidence of a mismatch is not evidence of one.

A session can also end WITHOUT the sign-out path — a failed refresh token,
cleared auth storage, a tab killed mid-session — leaving the browser
subscribed while the row still belongs to the previous account.
`reclaimPushDevice()` re-registers on every resolved session, which repairs it
using the same upsert; it is idempotent and best-effort, because the function
refuses a caller who is not yet an operator or a client.

`authenticated` holds no INSERT, UPDATE or DELETE — every write goes through
`fn_register_push_subscription` / `fn_remove_push_subscription`, which resolve
the persona themselves so a caller cannot name someone else's `operator_id`.
SELECT is a column grant that WITHHOLDS `p256dh` and `auth`, the per-device
encryption secrets; so this is a column-restricted table and `select("*")` on
it raises 42501 for every row (`scripts/select-columns.test.ts` and
`column-grants.test.ts` are the gates).

Erasure is by trigger, not by a line in `fn_purge_client`. The purge REDACTS
the client row, so the FK cascade never fires and an endpoint identifying a
person's browser would otherwise survive an erasure request indefinitely —
the gap Codex found in 0048 for `invite_signup_attempts`.

`notifications` gains `push_status` / `push_attempts` / `push_sent_at` /
`push_last_error`, mirroring H17's email quartet exactly. Existing rows are
backfilled to `skipped`: no push was ever sent because there was no push, and
the point is that they must not be sent now.
