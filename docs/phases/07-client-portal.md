# Phase 07 — Client portal & billing console

## Objective
The client-facing product plus the operator billing console. Specs: 02 (lifecycle), 04 (change-plan), 06 (routes).

## Deliverables
1. `PortalHome` — next walk card, CreditMeter, latest report cards, unread notifications.
2. `Booking` — request a one-off walk: date/window/service/pets picker; shows credit cost vs balance; insufficient balance → explicit overage-price confirmation (£ at plan rate); creates `scheduled` walk. Manage view: upcoming walks with cancel (≥ cutoff `operators` setting, default 12 h → add column in `0007` migration if absent).
3. `WalkDetail` — in_progress: live map via `useWalkChannel('subscribe')` + pulse-live header; completed: full ReportCard (photos via signed URLs, route, notes, flags).
4. `PortalBilling` — plan card, ledger (read-only), payments list with receipt links, Stripe customer-portal session launch (new tiny edge fn `billing-portal` returning the portal URL) for payment-method/pause/cancel self-service.
5. `PetProfiles` — client edits care fields per spec 03 column grants; `properties.access_notes_public` editing; visible note that secret codes are handled by the operator directly.
6. Operator `BillingConsole` — upcoming renewals (from Stripe period end cached on webhook or queried live), past_due list with retry status, overage debts (failed overage payments) with re-charge action, plan change per client → `change-plan` edge fn.
7. Edge fns: `change-plan` (spec 04) + `billing-portal`; migration `0007_portal.sql` for cancellation-cutoff column and any grants surfaced.

## Acceptance criteria
- tsc + build + `deno check` clean; smoke.sql passes.
- RLS proof in `docs/dev/portal-manual-test.md`: signed-in client sees only own data on every portal route; direct REST probe for another client's ledger → 0 rows.
- Booking with sufficient credits creates the walk showing cost; completing it debits correctly. Overage-confirmed booking completes through the overage charge path.
- Plan upgrade mid-cycle: Stripe test clock or fraction-injected call → `adjust` ledger row equals `floor(Δcredits × fraction)`; downgrade produces no clawback.

## Out of scope
Notifications delivery, PWA/offline.
