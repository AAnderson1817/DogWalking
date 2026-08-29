# Sanpo

Operations software for independent pet-care professionals — dog walkers,
sitters and daily-visit providers running their own book of clients. It is a
tool a solo operator runs their business on, not a marketplace and not a
dispatch system for an agency.

One operator manages clients, pets, properties, recurring schedules and entry
credentials. Their clients get a portal: book and cancel visits, watch a walk
happen live, read the report afterwards, and manage their own subscription.
Visits are paid for with **credits** from a subscription plan, and a visit
beyond the plan is charged as a single overage.

> **Status: pre-production.** The product is feature-complete and has never
> been deployed to production — `deploy-production.yml` has zero runs. Staging
> holds fixture data only. There are no real customers and no real money.

---

## Stack

| | |
| --- | --- |
| Frontend | React 19 · TypeScript (strict) · Vite · react-router · no CSS framework |
| Backend | Supabase — Postgres 17, Auth, Row-Level Security, Realtime, Storage |
| Server logic | Deno edge functions (billing, the credential vault, webhooks, email) |
| Payments | Stripe **Connect Standard** — each operator is the merchant of record |
| Maps | Mapbox, with an SVG fallback that needs no token |
| Locale | USD, US Central (`America/Chicago`). The database stores UTC. |

## Layout

```text
app/                 React PWA — see app/README.md for the frontend in detail
supabase/
  migrations/        Ordered SQL. Append-only once applied; never edit one.
  functions/         Deno edge functions and their tests
  tests/             SQL assertion suites (smoke, materializer, concurrency)
docs/
  spec/              Source of truth. Specs win over improvisation.
  dev/               Runbooks: setup, deploys, recovery, rotation, manual tests
  review/            The production-readiness review this work is closing out
scripts/             Local stack, code generators, the validation gate
```

## Getting started

Two ways to run the database. Both are documented in
`docs/dev/local-stack.md`; the second exists because this project is often
worked on in environments with no Docker.

```bash
# Database — either the Supabase CLI…
supabase db reset

# …or the no-Docker local stack
scripts/db-start.sh && scripts/db-reset.sh

# Frontend
cp app/.env.example app/.env.local     # then fill in the two VITE_ keys
npm --prefix app install
npm --prefix app run dev
```

The build **refuses** to run without `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` rather than producing a bundle that white-screens.

## Before you commit

```bash
scripts/validate.sh          # everything this machine can run
scripts/validate.sh --fast   # typecheck, lint, unit tests, greps only
```

It mirrors `.github/workflows/ci.yml` gate for gate. Anything it cannot run
here — no database, no browser — prints `SKIP` and is named again in the
summary, because CI will run it regardless. `.claude/skills/validate/SKILL.md`
is the same list with the reasoning attached: what each gate is for, and which
defect it was written after.

## Things worth knowing before changing anything

These are invariants, not preferences. `CLAUDE.md` has the full list; these are
the ones most likely to be broken by accident.

- **Migrations are append-only.** Once a file in `supabase/migrations/` has
  been applied, it is never edited — `db reset` replays everything from scratch
  and would look green, while `db push` skips the edited file in staging and
  production and the schemas diverge silently. Write a new migration.
- **Credit balances are only ever changed inside a `SECURITY DEFINER` function
  that takes a per-client row lock.** No API role writes `clients.credit_balance`
  or inserts into `credit_ledger` directly.
- **A visit is either fully credit-funded or fully charged.** Never partly both.
- **Vault ciphertext is unreadable by `anon` and `authenticated`.** Every read
  goes through an audited RPC and the `credential-vault` edge function.
- **Every tenant table carries `operator_id`, and every RLS policy scopes on
  it.**
- **Money is integer minor units.** The `*_pence` column names are historical
  and hold cents.
- **Colour comes from tokens, never a raw hex.** A literal cannot be reached by
  the `prefers-contrast` overrides; a test enforces this.

## Documentation map

| Read this | When |
| --- | --- |
| `docs/spec/` | Before changing behaviour. These are authoritative; a spec that disagrees with shipped code is a bug in the spec, fixed in the same commit. |
| `app/README.md` | Working on the frontend — architecture, env, e2e, recovery playbooks |
| `docs/dev/local-stack.md` | Getting a database up |
| `docs/dev/staging-setup.md` · `production-cutover.md` | Deploying |
| `docs/dev/disaster-recovery.md` | Something is broken and data is at risk |
| `docs/dev/secret-rotation.md` · `vault-key-rotation.md` | A key leaked, or is due |
| `docs/dev/owner-actions.md` | The list of things no file in this repository can do — dashboard settings, secrets, spending decisions |
| `docs/review/2026-08-review.md` | Why the recent commits look the way they do |
| `CLAUDE.md` | Conventions, invariants in full, and the running status log |

## Contributing

Everything reaches `main` through a pull request, including documentation —
`main` is a deploy trigger, so a push to it deploys staging and runs the
staging smoke suite. Commits are `area: summary` (`ops:`, `qc:`, `a11y:`,
`docs:`, `brand:`, `prod:`). Branches are merged with **rebase**, not squash,
so the per-commit reasoning survives on `main`.
