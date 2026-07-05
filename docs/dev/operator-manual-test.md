# Operator core — manual walkthrough (phase 05)

Prereqs: stack + seed data (`scripts/db-reset.sh` or `supabase db reset`),
dev server, signed in as the seed operator (or your onboarded one). For a
full walk with GPS use Chrome DevTools → More tools → Sensors → Location →
pick a preset and change it during the walk.

## 1. Dashboard
1. `/` shows today's walks ordered by window start (seed has a 12:00 walk).
2. The unread bell count matches `notifications` where `read_at is null`.
3. Give a client balance ≤ threshold (`fn_adjust_credits` or the Adjust
   sheet) → the amber low-credit strip lists them, tapping opens the client.
4. Insert a failed payment (Studio/psql) → failed-payments strip shows it.

## 2. Roster → ClientDetail
1. `/roster`: search "Bis" finds Amelia via pet name Biscuit; search by
   client name works; status badge + balance chip render.
2. Add client → invite sheet shows the `/claim/…` link; copy works.
3. ClientDetail → Pets: add a pet with photo (uploads to `pet-photos`,
   compressed ≤1600px), flag it reactive → warning badge appears.
4. Plan & credits: CreditMeter matches balance; Adjust +2 with note writes
   an `adjust` ledger row (visible in the table, running balance right).
5. Unsubscribed client + a plan with `stripe_price_id` → Launch Stripe
   checkout opens the hosted page (test key).

## 3. Access vault
1. ClientDetail → Access: add property, then Add secret → reauth sheet →
   encrypt & save. Studio: `access_credentials.ciphertext` is bytea, the
   REST response for the insert contains NO ciphertext field.
2. `/vault`: Reveal → reauth → purpose required → plaintext shows for 30 s
   with Copy, then auto-clears.
3. Audit trail sheet lists exactly ONE row per reveal (purpose + time).
   Reveal twice → two rows. `select count(*) from credential_access_log`
   confirms.
4. Wrong password at reauth → 401 error surfaced, no reveal, still exactly
   the prior audit rows. Six attempts inside a minute → 429 rate limit.
5. Rotate writes new ciphertext + `rotated_at`; Revoke soft-deletes
   (`revoked_at` set, audit trail intact, row gone from the vault list).

## 4. Walk Mode — full walk
1. Dashboard → tap the scheduled walk → Start walk (status → in_progress,
   `started_at` set). Reactive-pet warning shows before start.
2. Sensors panel: move the location a few times ≥10 m apart, ≥5 s apart —
   the polyline grows, distance ticks up in the display numerals; elapsed
   timer runs. `walk_gps_points` rows appear in batches (10 points / 60 s).
3. Take/upload two photos → previews render; `walk-photos` bucket receives
   compressed JPEGs under `{operator}/{walk}/`.
4. Toggle Pee/Fed, add a note, End walk & send:
   - balance ≥ cost → pine banner "Debited N credits"; `credit_ledger`
     debit row + `walks.credits_debited = N`.
   - re-POST safety: reload the completed walk page — report renders, no
     second debit (idempotent).
5. Overage path: zero the client's balance (`fn_adjust_credits` negative),
   run a second walk end-to-end → amber "Overage £X" banner; with a Stripe
   test card on the customer a `payments` row `type=overage` appears;
   without one, a `failed` payment row + payment_failed notifications.
6. Report card preview shows photos, route polyline, potty/fed facts,
   notes, distance.

## 5. Live banner
While a walk is in_progress, `/` shows the pulsing LiveWalkBanner with the
running timer; tapping it returns to Walk Mode.

All flows must run with zero console errors.
