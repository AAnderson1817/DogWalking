#!/usr/bin/env bash
# Post-deploy verification for a Supabase project (review M4).
#
# `deploy-production.yml` used to end at `deploy-functions` and assert nothing.
# `supabase functions deploy` reports success once it has uploaded a bundle; it
# does not run it. A function whose module throws while EVALUATING — a missing
# env var read at import, a bad import specifier, a top-level await that
# rejects — deploys "successfully" and then 500s on its first real call, which
# on the money paths is an operator standing at a client's door.
#
# So this asks each deployed function a question and requires the right answer.
# Two phases, because they fail differently:
#
#   1. Inventory (Management API). Every function directory in this repository
#      is present on the project and ACTIVE. Catches a function that was never
#      deployed at all — a `supabase functions deploy` that skipped one is
#      invisible to any probe that only looks at what it already knows about.
#
#   2. Boot probe (HTTP). Every function answers ITS OWN known no-side-effect
#      response. A module that failed to evaluate cannot answer, so the answer
#      arriving at all is the evidence; the specific answer then proves our own
#      code ran rather than the platform's gateway.
#
# ── Why this is safe to run against production ────────────────────────────
#
# Every request this script makes is a GET with no body, and every probe is
# chosen to return BEFORE anything can be written:
#
#   * 12 of the 13 functions go through `serveFunction`, which answers a
#     non-POST with 405 before it ever calls the handler (_lib/http.ts).
#   * `stripe-webhook` has its own `Deno.serve` and 405s a non-POST before it
#     reads the body or touches Stripe.
#   * `unsubscribe` accepts GET by design, so it is probed with NO token —
#     which returns the confirmation page without reaching the database.
#     `unsubscribe_test.ts` pins that ("no token at all: the same page, and
#     nothing is written"), so the read-only claim here is tested, not assumed.
#
# ── Adding a function ─────────────────────────────────────────────────────
#
# The list comes from the filesystem, so a new function is probed automatically
# and cannot be forgotten. It gets the DEFAULT contract (405 + our envelope +
# x-request-id). If it legitimately answers something else, add a case to
# `contract_for` — the failure is loud and forces that to be a decision.
#
# Env:
#   SUPABASE_PROJECT_REF    required
#   SUPABASE_ACCESS_TOKEN   required (Management API: inventory + service key)
#   FUNCTIONS_BASE          override the functions origin (tests)
#   MANAGEMENT_API          override the Management API origin (tests)
#   FUNCTIONS_DIR           override the source directory (tests)
set -uo pipefail

MANAGEMENT_API="${MANAGEMENT_API:-https://api.supabase.com}"
FUNCTIONS_DIR="${FUNCTIONS_DIR:-supabase/functions}"
: "${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is required}"
: "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN is required}"
FUNCTIONS_BASE="${FUNCTIONS_BASE:-https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1}"

fail=0
note() { printf '%s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; fail=1; }
good() { printf '  ok    %s\n' "$*"; }

mgmt() { curl -sS --max-time 30 -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" "$@"; }

# ── the functions this repository ships ───────────────────────────────────
# Directories only, `_lib` and `_tests` excluded the same way the CLI excludes
# them: a leading underscore is not a function.
repo_functions() {
  local d
  for d in "$FUNCTIONS_DIR"/*/; do
    d=$(basename "$d")
    case "$d" in _*) continue ;; esac
    [ -f "$FUNCTIONS_DIR/$d/index.ts" ] || continue
    printf '%s\n' "$d"
  done | sort
}

# ── phase 1: inventory ────────────────────────────────────────────────────
note "== deployed inventory (${SUPABASE_PROJECT_REF}) =="
inventory=$(mktemp)
status=$(mgmt -o "$inventory" -w '%{http_code}' \
  "${MANAGEMENT_API}/v1/projects/${SUPABASE_PROJECT_REF}/functions")
if [ "$status" != "200" ]; then
  bad "could not list deployed functions (HTTP $status)"
  head -c 400 "$inventory"; echo
  # No point probing if we cannot say what is there.
  exit 1
fi

deployed=$(jq -r '.[] | "\(.slug) \(.status)"' "$inventory" 2>/dev/null | sort)
if [ -z "$deployed" ]; then
  bad "the project reports NO deployed functions"
fi

expected=$(repo_functions)
if [ -z "$expected" ]; then
  bad "no function directories found under $FUNCTIONS_DIR — refusing to report success on an empty set"
  exit 1
fi

while read -r name; do
  [ -n "$name" ] || continue
  state=$(printf '%s\n' "$deployed" | awk -v n="$name" '$1 == n { print $2 }')
  if [ -z "$state" ]; then
    bad "$name is in this repository but NOT deployed to the project"
  elif [ "$state" != "ACTIVE" ]; then
    bad "$name is deployed but its status is '$state', not ACTIVE"
  else
    good "$name deployed and ACTIVE"
  fi
done <<< "$expected"

# A function on the project that this repository no longer ships is reported
# but not fatal: it is almost always a rename, and the live one is still the
# one being probed. Deleting it is a deliberate act, not a deploy's business.
while read -r slug _; do
  [ -n "$slug" ] || continue
  if ! printf '%s\n' "$expected" | grep -qx -- "$slug"; then
    note "  note  $slug is deployed but no longer in this repository"
  fi
done <<< "$deployed"

# ── the service key, fetched the way staging-smoke.yml already does ───────
keys=$(mktemp)
status=$(mgmt -o "$keys" -w '%{http_code}' \
  "${MANAGEMENT_API}/v1/projects/${SUPABASE_PROJECT_REF}/api-keys?reveal=true")
SERVICE_KEY=$(jq -r '[.[] | select(.name == "service_role")][0].api_key // empty' "$keys" 2>/dev/null)
if [ "$status" != "200" ] || [ -z "$SERVICE_KEY" ]; then
  bad "could not fetch the service_role key (HTTP $status) — cannot probe verify_jwt functions"
  exit 1
fi
echo "::add-mask::$SERVICE_KEY" 2>/dev/null || true

# ── phase 2: boot probe ───────────────────────────────────────────────────
#
# contract_for <name> -> "<expected status>|<needle in body>|<envelope?>"
#
# envelope=yes additionally requires the `x-request-id` response header, which
# only `serveFunction` sets. That is the half that distinguishes "our code ran
# and refused the method" from "something in front of our code refused it" —
# without it, a gateway 405 from a function that never booted would pass.
contract_for() {
  case "$1" in
    # Its own Deno.serve (verify_jwt=false, bare text bodies, its own 409), so
    # no envelope and no request id — see the note in stripe-webhook/index.ts.
    stripe-webhook) printf '405|POST only|no' ;;
    # Same bare Deno.serve shape as stripe-webhook, for the platform-account
    # endpoint (review H31).
    platform-webhook) printf '405|POST only|no' ;;
    # Accepts GET by design. Probed with no token: no database, no write.
    unsubscribe) printf "200|You're unsubscribed|no" ;;
    *) printf '405|method_not_allowed|yes' ;;
  esac
}

# Any name with a bespoke contract must still be a function this repo ships,
# or the exception is silently excusing nothing.
for special in stripe-webhook platform-webhook unsubscribe; do
  if ! printf '%s\n' "$expected" | grep -qx -- "$special"; then
    bad "contract_for names '$special', which is not a function in $FUNCTIONS_DIR — a stale exception hides a real probe"
  fi
done

note ""
note "== boot probe =="
while read -r name; do
  [ -n "$name" ] || continue
  IFS='|' read -r want_status needle want_envelope <<< "$(contract_for "$name")"

  body=$(mktemp); hdrs=$(mktemp)
  # GET, no body, ever. See the read-only argument in the header.
  got=$(curl -sS --max-time 30 -o "$body" -D "$hdrs" -w '%{http_code}' \
    -H "Authorization: Bearer ${SERVICE_KEY}" \
    "${FUNCTIONS_BASE}/${name}" 2>/dev/null)

  if grep -qiE 'BOOT_ERROR|WORKER_ERROR|worker boot error' "$body"; then
    bad "$name FAILED TO BOOT — the bundle deployed but the module does not evaluate"
    head -c 300 "$body"; echo
    continue
  fi
  if [ "$got" != "$want_status" ]; then
    bad "$name answered HTTP $got, expected $want_status"
    head -c 300 "$body"; echo
    continue
  fi
  if ! grep -qF -- "$needle" "$body"; then
    bad "$name answered $got but not with its own body (expected to contain: $needle)"
    head -c 300 "$body"; echo
    continue
  fi
  if [ "$want_envelope" = "yes" ] && ! grep -qi '^x-request-id:' "$hdrs"; then
    bad "$name answered $got with no x-request-id — that response did not come from serveFunction"
    continue
  fi
  good "$name booted and answered its contract ($got)"
done <<< "$expected"

note ""
if [ "$fail" -ne 0 ]; then
  note "DEPLOYMENT VERIFY FAILED"
  exit 1
fi
note "DEPLOYMENT VERIFY PASS"
