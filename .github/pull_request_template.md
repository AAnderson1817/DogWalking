<!--
Keep this short. The diff is the record; this is the context the diff cannot
carry — why, and what was actually checked rather than assumed.
-->

## What and why

<!-- The change in a sentence or two, and the problem it solves. If it closes a
     review finding, reference it: "Closes #9 (B1)." -->

## Verification

<!-- What you RAN, not what you believe. Paste the numbers that matter.
     Measured against rendered output where the claim is visual — a token value
     is not evidence of what a user sees. -->

- [ ] `npx tsc --noEmit -p app`
- [ ] `npm --prefix app run lint`
- [ ] `npm --prefix app test -- --run`
- [ ] `npm --prefix app run build`
- [ ] `npm --prefix app run test:e2e` (or the CI `e2e-today` job)
- [ ] Database: `supabase db reset` + `smoke.sql` + `materializer.sql`, or CI's `database` job

## Money and trust paths

<!-- CLAUDE.md reserves these for explicit owner sign-off. Tick anything this
     PR touches; CODEOWNERS will request the review, but say so here too so it
     is visible in the description rather than only in the file list. -->

- [ ] `supabase/migrations/` — a new migration (never an edit to an existing one)
- [ ] Credit / ledger / billing / Stripe
- [ ] The credential vault
- [ ] RLS or tenancy
- [ ] Deploy workflows

## Notes for the reviewer

<!-- Anything you are unsure about, deliberately did not do, or want argued
     with. A PR that says "I am not certain about X" is more useful than one
     that quietly hopes nobody looks at X. -->
