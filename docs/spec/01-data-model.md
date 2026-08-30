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
Sanpo's own revenue (review H31, 0045): `trial_ends_at timestamptz not null default (now() + interval '14 days')`, `platform_customer_id` / `platform_subscription_id` (Stripe ids on the PLATFORM account — never to be confused with `clients.stripe_*`, which live on the operator's connected account), and `platform_subscription_status subscription_status default 'none'` (`trialing` maps to `active`). None of the four is writable by any API role — the 0045 grant rework replaced the table-level INSERT grant with an explicit column list, which also closed a pre-existing hole (an operator could forge `stripe_charges_enabled` at row creation; 0024 revoked UPDATE only). The app-side gate reads them through role resolution (`operatorAccess`, spec 06).

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

**walk_photos** — `walk_id on delete cascade`, `operator_id`, `storage_path text`, `caption text`, `taken_at timestamptz`.

**credit_ledger** — `operator_id`, `client_id`, `entry_type ledger_entry_type`, `amount int not null check (amount <> 0)` (signed: grants/rollover +, debit/expiry −, adjust ±), `balance_after int not null`, `walk_id uuid null`, `expires_at timestamptz null` (rollover lots), `note text`. Append-only; insert path is definer-only (spec 02/03). Index `(client_id, created_at desc)`.

**payments** — `operator_id`, `client_id`, `walk_id uuid null`, `type payment_type`, `amount_pence int`, `currency char(3) default 'USD'`, `stripe_payment_intent_id text`, `stripe_invoice_id text`, `status payment_status`, `receipt_url text`. `stripe_invoice_id` holds the id of the Stripe object that paid — an `in_…` invoice for subscription rows, and since 0044 the `pi_…` PaymentIntent for `topup` rows, where it doubles as the grant↔money trace `fn_reverse_payment` claws back through (the namespaces are disjoint, and `uq_payments_subscription_invoice` filters `type='subscription'`, so they never collide). Top-up idempotency: `uq_topup_payment_per_intent` on `(stripe_payment_intent_id) where type='topup' and status in ('succeeded','refunded','disputed')` — the reversal statuses are in the set so a refunded top-up keeps holding its slot against Stripe's three-day redelivery.

**notifications** — `operator_id`, `client_id uuid null` (null ⇒ operator-facing), `type notification_type`, `title text`, `body text`, `walk_id uuid null`, `read_at timestamptz null`.

**stripe_events** — `id text primary key` (Stripe event id), `type text`, `payload jsonb`, `processed_at timestamptz default now()`. Webhook idempotency ledger.

## Storage buckets
- `pet-photos` (public read via signed URLs), `walk-photos` (private; signed URLs in report cards). Path convention `{operator_id}/{entity_id}/{uuid}.jpg`; RLS on `storage.objects` scopes by first path segment.
