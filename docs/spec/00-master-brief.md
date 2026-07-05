# 00 — Master brief

## Positioning
- Target: solo and 1–3 walker dog-walking operators. Operator #1 is the founder (pre-launch); product is sellable as vertical micro-SaaS.
- Gap: incumbents (Time To Pet, Scout, Precise Petcare, PetPocketbook, Pet Sitter Plus) are team-scoped, overbuilt, priced per-visit/per-package. Rover/Wag are marketplaces, not operations software.
- Core differentiator: native subscription/credit billing — credits granted per cycle, debited per walk, rollover, pause/resume — built into the data model.
- Secondary: solo simplicity at lower price; polished client experience (live GPS, photo report cards, in-app payment); hyper-local density routing.
- Default service = private walk.

## Lock-in layers (own these)
1. Access credentials (keys, lockbox codes, alarm sequences, door/buzzer codes) — encrypted, audited.
2. Pet profiles (temperament, medical, feeding, meds, vet, behavioral flags).
3. Payment / subscription / credit history.
4. GPS + photo + timestamp visit logs (proof-of-service archive).

## Functional modules
CRM/client records · encrypted access vault · scheduling (recurring + one-off) · walk execution (check-in → GPS/photos/notes → check-out) · subscription & credit engine · Stripe payments · client portal (booking, live tracking, report cards, self-service billing) · notifications (walk-complete, low-credit, renewal, failed-payment).

## Apps
- Operator (mobile-first PWA): Dashboard (today's walks in route order, low-credit clients, failed payments) · Roster → ClientDetail (pets, access, history, balance) · Calendar (day/week, drag-reschedule) · Walk Mode (start → live GPS → photos → potty/feeding → notes → end → auto report card, credit debit, owner notification) · Billing console · Access vault (re-auth gated, every open audited).
- Client portal (same PWA, role-gated): Home (next walk, balance, latest report cards) · Booking against credits + overage extras · Live tracking · Report card history · Billing (plan, invoices, payment method, pause/resume) · Pet + access-instruction self-management (non-secret fields only; secrets are operator-entered — see spec 03).

## Stack
React PWA single codebase · Supabase (Postgres 16, Auth, RLS, Realtime, Storage) · Deno edge functions · Stripe Billing + off-session PaymentIntents for overage · Mapbox GL (SVG polyline fallback) · Vercel/Netlify hosting · native fork option: React Native/Expo against same backend if background-GPS reliability demands it.
