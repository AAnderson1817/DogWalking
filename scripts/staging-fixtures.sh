#!/usr/bin/env bash
# Fixture housekeeping for the staging smoke replays. SOURCED, never executed —
# which is why it is deliberately not marked executable:
#
#     base="https://<project-ref>.supabase.co"
#     . ./scripts/staging-fixtures.sh "$base"
#
# ONE definition, because the two replay steps in `staging-smoke.yml` each
# carried their own and they diverged. `Replay invite-claim` was repaired three
# times — pagination, then a stop rule that inferred the last page from the size
# REQUESTED rather than from what the server returned, then cleanup that reports
# a refused delete instead of swallowing it — while `Replay onboard`, the step
# directly above it in the same job, kept the single-page lookup, the `|| true`
# deletes and the create that piped curl straight into jq. That step was not
# broken today only because its fixture address is run-scoped, which is a
# property of the fixture and not of the step: the same class of failure was one
# change away.
#
# A shell function cannot cross a `run:` boundary — each step is its own
# process — so "one definition" means a file both steps source. That is also
# what makes these rules testable at all (`app/scripts/staging-fixtures.test.ts`
# drives every one of them against a stub that pages and refuses the way the
# real APIs do). `scripts/check-auth-posture.sh` left this same workflow for
# exactly that reason, and found a defect on its first real run that nothing
# inline in YAML could ever have exercised.
#
# Sets no shell options on purpose. It is sourced into the step's shell, where
# GitHub's default `shell` is already `bash -e {0}`, and a library that turns
# options on or off changes its caller's behaviour behind its back.
#
# Inputs: the project base URL as $1 at source time, and SERVICE_KEY in the
# environment (the "Fetch API keys" step puts it there through $GITHUB_ENV).
# Both are asserted here rather than read as empty strings later, because an
# empty base turns every call below into a request to a URL that does not exist
# and a missing key turns them all into 401s that read as "absent".

STAGING_BASE="${1:?staging-fixtures.sh: source it with the project base URL — . ./scripts/staging-fixtures.sh \"https://<ref>.supabase.co\"}"
: "${SERVICE_KEY:?staging-fixtures.sh: SERVICE_KEY is unset — the Fetch API keys step has to run first}"

# Authenticated as the service role. Both headers: the gateway wants `apikey`
# alongside the bearer, and a bearer-only call comes back 401 — a defect this
# repository has already shipped once, in `verify-photo-integrity.sh`, where
# every row then read as GONE and the run still exited 0.
admin() {
  curl -sS -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" "$@"
}

# The auth user id for an address, or empty if there is none.
#
# Pages until it finds the address or runs out. It used to read
# `page=1&per_page=100` and stop: this function's job is to find THIS RUN's
# leftovers so they can be deleted before the fixtures are recreated, and once
# staging held more than 100 auth users they fell off page 1. Cleanup then found
# nothing, the create collided with the row it had failed to remove, and the job
# failed with a message that named neither cause. The bound is there so a
# project with a large user table cannot spin here forever.
#
# Stops on an EMPTY page, never on a short one. The first version of this asked
# for `per_page=200` and stopped when a page returned fewer than 200 — but
# GoTrue caps the page size, so page 1 came back with 100, `100 -lt 200` was
# true, and it returned "not found" having read exactly one page. That is the
# bug it was written to fix, reintroduced by inferring the last page from the
# size REQUESTED rather than from what the server actually did.
#
# `seen` guards the other direction: an endpoint that ignores `page` would
# otherwise be rescanned to the bound and still report absence.
#
# Exit 0 with the id on stdout (empty = genuinely absent); exit 9 when the
# LOOKUP failed — non-2xx, or a body with no users array. The distinction is
# load-bearing: two security assertions in the claim replay read this function,
# and a 401 body read as "absent" would pass the dead-token check while checking
# nothing — the green-but-empty class this repository's log records four times.
# Warnings go to stderr because stdout is the captured return value.
user_id_for() {
  local page=1 code lbody id first seen=""
  lbody=$(mktemp)
  while [ "$page" -le 50 ]; do
    code=$(admin -o "$lbody" -w '%{http_code}' "$STAGING_BASE/auth/v1/admin/users?page=$page&per_page=100")
    case "$code" in
      2*) ;;
      *) echo "auth user lookup failed: GET admin/users page $page -> HTTP $code" >&2; return 9 ;;
    esac
    jq -e '.users | type == "array"' "$lbody" >/dev/null 2>&1 \
      || { echo "auth user lookup: page $page carried no users array" >&2; return 9; }
    id=$(jq -r --arg e "$1" '.users[]? | select(.email==$e) | .id' "$lbody" | head -1)
    [ -n "$id" ] && { printf '%s' "$id"; return 0; }
    [ "$(jq -r '.users | length' "$lbody")" -eq 0 ] && return 0
    first=$(jq -r '.users[0].id // empty' "$lbody")
    [ -n "$first" ] && [ "$first" = "$seen" ] && return 0
    seen=$first
    page=$((page + 1))
  done
  return 0
}

# Delete, and REPORT a refusal instead of swallowing it. Every `|| true` this
# replaces used to hide one, which is how leftovers accumulated silently until a
# run could no longer start. Non-fatal on purpose — cleanup is housekeeping now
# that the fixture addresses are run-scoped, not a precondition — but a warning
# makes the accumulation visible while it is still cheap to fix.
del() {
  local code
  code=$(admin -o /dev/null -w '%{http_code}' -X DELETE "$1")
  case "$code" in
    2*) return 0 ;;
    *) echo "::warning title=Fixture cleanup left something behind::DELETE $2 -> HTTP $code. Rows accumulate in staging until this is fixed." ;;
  esac
}

# Create a confirmed throwaway auth user. The id lands in FIXTURE_UID rather
# than on stdout, so that every diagnostic below can go to stdout, where the
# runner turns `::error` into an annotation.
#
# The response body is kept, not piped straight into jq. `FAIL: could not create
# fixture user` used to be the whole of the diagnosis — the status and GoTrue's
# own message went in the bin, so "already registered", "weak password" and
# "service key rejected" were one indistinguishable red. Same defect as review
# H14, in the workflow that exists to say when staging is wrong.
create_fixture_user() {
  local email="$1" password="$2" body code msg stale
  body=$(mktemp)
  code=$(admin -o "$body" -w '%{http_code}' -X POST "$STAGING_BASE/auth/v1/admin/users" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"$password\",\"email_confirm\":true}")
  FIXTURE_UID=$(jq -r '.id // empty' "$body")
  if [ -n "$FIXTURE_UID" ]; then return 0; fi

  # `error_description`/`msg`/`message` only — never the whole body. The
  # password in the request is this script's own throwaway and not anyone's
  # secret, but an unexpected response is not the place for an unbounded dump.
  msg=$(jq -r '.error_description // .msg // .message // "no message"' "$body")
  echo "::error title=Could not create the fixture user $email::HTTP $code — $msg"
  # A 422 means cleanup left the previous run's user behind. Which half failed
  # is the next question, and the answer is one lookup: if the search CAN see
  # it, the DELETE is what is broken; if it cannot, the search is. Without this
  # the two look identical. A lookup that itself fails is a third answer and
  # says so — reading it as "cannot see it" would blame the search for what may
  # be a transport failure, and the version this replaces could not get that far
  # anyway, because a bare stale=$(user_id_for …) under bash -e exits on the
  # return 9 before anything is printed.
  if [ "$code" = "422" ]; then
    if stale=$(user_id_for "$email"); then
      if [ -n "$stale" ]; then
        echo "::error title=Cleanup did not delete the leftover::The lookup can see $email as $stale, so the DELETE is what failed — most likely a row still references the auth user. Delete it by hand and the next run is clean."
      else
        echo "::error title=The lookup cannot see the leftover::GoTrue says $email exists but the paginated admin search does not return it, so the SEARCH is what is broken, not the delete."
      fi
    else
      echo "::error title=Could not tell which half is broken::$email already exists, but the auth lookup failed too, so whether cleanup or the search is at fault is unknown."
    fi
  fi
  return 1
}
