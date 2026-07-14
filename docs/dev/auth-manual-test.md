# Auth flows — scripted manual walkthrough (phase 04)

Prereqs: local stack running (`supabase start`, or scripts/db-start.sh +
scripts/db-reset.sh on the no-Docker stack), `app/.env.local` filled, and
`npm --prefix app run dev`. On the hosted/local Supabase Auth, disable
email confirmations for the walkthrough (Auth → Providers → Email) or use
the confirm link when it appears.

## 1. Operator signup → onboard → dashboard
1. Open `/signin` → "Use a magic link instead" is offered (do not use yet).
2. Create the operator account in Studio (Auth → Add user,
   `op-test@pawtrail.dev` / password) — or sign up via the Studio invite.
3. Sign in at `/signin` with email+password.
4. With no persona row you land on `/onboard`. Fill "Business name" =
   Test Walks, "Your name" = Op. Submit.
5. You land on `/` (Dashboard). In Studio verify: `operators` row with your
   auth uid, defaults `USD` / `America/Chicago` / threshold 2, and TWO seeded
   `service_types` rows ("Private walk 30" default, "Private walk 60").
6. Revisit `/onboard` — it skips straight back to `/` (guard).

## 2. Client invite → claim → portal
1. As the operator (Studio or Roster once phase 05 lands), insert a
   `clients` row: `operator_id` = your uid, `full_name` = Casey Client,
   `email` = casey@pawtrail.dev. Copy its `invite_token`.
2. Open an incognito window at `/claim/<invite_token>`.
3. Create the account (email+password ≥8 chars). After signup the invite
   preview must show "Casey Client" and your business name.
4. Accept the invite → you land on `/portal`. In Studio verify
   `clients.auth_user_id` = the new auth uid and `status` = `active`.

## 3. Invalid / claimed token dead-ends
1. `/claim/00000000-0000-4000-a000-999999999999` (garbage token) as a
   signed-in user → styled "Invite not available" dead-end, no crash.
2. Re-open the REAL token from step 2 in another incognito window, sign up
   with a different email → dead-end: already claimed.

## 4. RLS isolation spot-check (client persona)
1. Signed in as Casey in the portal, open DevTools → Network.
2. Every PostgREST response must contain only Casey's rows (clients,
   pets, walks). Manually probe another client id:
   `fetch('<SUPABASE_URL>/rest/v1/clients?id=eq.<other-client-uuid>',
   { headers: { apikey: '<anon>', Authorization: 'Bearer ' + session } })`
   → `[]` (0 rows).
3. `fetch('…/rest/v1/credit_ledger?select=*')` → only Casey's ledger rows.

## 5. reauth() sheet
1. As the operator, from any screen run in the console a vault call once
   phase 05 lands — or verify now via `/dev/kit` → "Confirm password"
   sheet renders, Cancel resolves without navigation, Esc dismisses.

## 6. Sign-in redirects by persona
1. `/signin` as the operator → lands on `/`.
2. `/signin` as Casey → lands on `/portal`.
3. Signed out, hit `/` → redirected to `/signin`; hit `/portal` → same.
4. Signed in as Casey, hit `/` (operator home) → bounced to `/portal`.

All steps must complete with zero console errors.
