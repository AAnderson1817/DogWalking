# Phase 05 — Operator core

## Objective
The operator's daily surface: Dashboard, Roster, ClientDetail, AccessVault, WalkMode. Specs: 05, 06; billing behavior per 02/04.

## Deliverables
1. `Dashboard` — today's walks ordered by `window_start` (route order v1 = time order), LiveWalkBanner when a walk is in_progress, low-credit clients strip (≤ threshold, amber CreditMeter), failed-payments strip, unread operator notifications count.
2. `Roster` — searchable client list (name/pet), status badges, balance chips → ClientDetail.
3. `ClientDetail` — tabs: Pets (CRUD incl. photo upload + behavioral flags surfaced as warning badges) · Plan & credits (CreditMeter, plan card, ledger table from `credit_ledger`, `fn_adjust_credits` action with note, create-checkout launch for unsubscribed) · Walks (history of WalkCards → report) · Access (property list, credential metadata rows, add/reveal via vault flow).
4. `AccessVault` — global credential list grouped by client/property; reveal flow: `reauth()` sheet → purpose input (required) → `credential-vault get` → plaintext shown 30 s with manual copy, auto-clear; `put` flow for new/rotated secrets; per-credential audit trail (`credential_access_log`).
5. `WalkMode` — `.walkmode` theme; start (status→in_progress, started_at) → live map + elapsed timer + distance (display numerals) via useGeolocation/useWalkChannel → photo capture+compress→Storage → potty/fed toggles → notes → End & send → `complete-walk` → billing outcome banner (debited N credits / overage £X) → ReportCard preview. Guard against accidental exit while in_progress.

## Acceptance criteria
- tsc + build clean.
- `docs/dev/operator-manual-test.md` executes: seed data → run a full walk with DevTools sensor-simulated GPS → report card renders with route polyline + photos; ledger shows the debit; second walk with balance 0 → overage path (Stripe test card) → payment row.
- Vault: reveal writes exactly one audit row per open (verify in Studio); ciphertext never present in any network response except the vault fn's `secret` field.
- Vitest: dashboard selectors (today filter, low-credit filter) against fixtures.

## Out of scope
Calendar/scheduling, portal, notifications UI beyond the count.
