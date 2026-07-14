# Client portal & billing console — manual walkthrough (phase 07)

Prereqs: stack + seed, dev server, TWO browser profiles: operator, and the
claimed client (docs/dev/auth-manual-test.md §2). Stripe test keys set for
the billing flows.

## 1. RLS proof (client persona)
1. Signed in as the client, walk every portal route (`/portal`,
   `/portal/book`, `/portal/walks`, `/portal/billing`, `/portal/pets`).
   DevTools → Network: every PostgREST response contains ONLY this
   client's rows.
2. Direct REST probe for another client's ledger →
   `fetch('<SUPABASE_URL>/rest/v1/credit_ledger?client_id=eq.<other-uuid>',
   {headers:{apikey:'<anon>',Authorization:'Bearer '+session.access_token}})`
   → `[]` (0 rows). Same for `walks`, `pets`, `payments`.
3. Operator routes (`/`, `/roster`, …) bounce the client back to `/portal`.
   (The SQL-level equivalents run in smoke.sql automatically.)

## 2. Booking against credits
1. Client has credits (grant via operator Adjust). `/portal/book`: pick a
   weekday ≥ tomorrow → cost shows 1 credit vs balance; Request walk.
2. The walk appears in Upcoming (portal) and on the operator's Calendar.
3. Operator completes it through Walk Mode → the debit shows in the
   client's `/portal/billing` ledger; balance drops by the cost.

## 3. Overage-confirmed booking
1. Drain the balance to 0 (operator Adjust). Book again: amber cost card
   demands the explicit overage confirmation showing $ at the plan rate;
   the button stays disabled until ticked.
2. Complete the walk (operator) → overage charge path: `payments` row
   `type=overage` (succeeded with a test card; failed otherwise, visible
   in the operator Billing console with a working Re-charge button).

## 4. Cancellation cutoff
1. Book a walk ≥ 2 days out → Cancel button works; walk flips cancelled.
2. Operator: create a walk for the client starting < 12 h from now
   (Calendar one-off). Portal shows "Within 12 h — contact your walker";
   forcing the update via REST is rejected by the 0008 guard trigger
   (verified in smoke.sql).

## 5. Live tracking + report card
1. Operator starts the walk (Walk Mode + sensor GPS). Client opens it from
   `/portal` → pulse-live header, polyline grows as points broadcast.
2. Operator ends the walk → portal report card renders photos (signed
   URLs from walk-photos), route, potty/fed flags, notes, distance.

## 6. Portal billing self-service
1. `/portal/billing`: plan card with renewal date (after a webhook/
   subscription update), read-only ledger, payments with receipt links.
2. "Manage payment method…" opens the Stripe customer portal (test mode).

## 7. Pet self-management
1. `/portal/pets`: edit temperament/feeding/vet, upload a photo → saves;
   operator sees the changes in ClientDetail.
2. Attempt to rename the pet via REST (`PATCH …pets?id=eq.<id>` body
   `{"name":"Hacked"}`) → rejected (guard trigger: care fields only).
3. Property notes card saves `access_notes_public`; the copy explains
   secrets are operator-managed.

## 8. Plan change proration
1. Operator Billing console → Change plan (upgrade) mid-cycle.
   - With a Stripe subscription: fraction comes from the live period.
   - Manual mode (no subscription): POST change-plan with
     `{"client_id":…,"new_plan_id":…,"fraction":0.5}`.
2. Ledger gains `adjust` = floor(Δcredits × fraction), note "plan upgrade
   proration". Downgrade → NO clawback row; plan_id still switches.

All flows must run with zero console errors.
