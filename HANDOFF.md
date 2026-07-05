# PawTrail handoff — setup & operating procedure

## Prerequisites
- Node 20+, Deno 1.4x, Docker (for Supabase local), Supabase CLI, Stripe CLI (optional, for webhook fixtures), Claude Code.

## Drop-in
1. `mkdir pawtrail && cd pawtrail && git init`
2. Unzip this package into the repo root (`CLAUDE.md`, `docs/`, `.claude/` at top level).
3. `git add -A && git commit -m "handoff: specs, phases, claude config"`
4. `supabase init` (accept defaults; do not overwrite anything from the package).
5. `supabase start` — note the local API URL, anon key, service-role key, DB URL.
6. Export `LOCAL_DB_URL` (the `postgresql://…54322/postgres` URL) in your shell profile — the `/validate` skill and smoke tests use it.

## Per-phase procedure (one phase = one Claude Code session)
1. `claude` in repo root → `/clear`
2. `/plan` → prompt: `Execute docs/phases/NN-<name>.md`
3. Review the plan against the phase file's acceptance criteria; approve.
4. On completion Claude runs `/validate`; all criteria must pass.
5. Commit `phase(NN): …`; Claude ticks the box in CLAUDE.md and appends one status line.

## Environment keys
| Key | Where | Used by |
|---|---|---|
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | `app/.env.local` | frontend |
| `VITE_MAPBOX_TOKEN` | `app/.env.local` | MapView (SVG fallback if absent) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | edge function secrets | all functions |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | edge function secrets | stripe-webhook, create-checkout, charge-overage, change-plan |
| `VAULT_MASTER_KEY` | edge function secrets | credential-vault (32-byte base64; generate: `openssl rand -base64 32`) |
| `RESEND_API_KEY` | edge function secrets | phase 08 email (optional; env-gated) |
| `LOCAL_DB_URL` | shell | smoke tests |

No secrets are ever committed. Phase 00 creates `.env.example` mirroring this table.

## Hooks installed by this package
- PreToolUse guard: blocks edits to existing files under `supabase/migrations/` (append-only rule).
- PostToolUse typecheck: runs `tsc --noEmit` after TS edits and reports errors back non-blockingly. Remove from `.claude/settings.json` if it slows large phases; `/validate` still gates commits.
