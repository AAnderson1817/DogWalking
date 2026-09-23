# Helpers for the staging smoke replays' throwaway fixtures. SOURCED, not run:
#
#   base="https://<ref>.supabase.co"   # and SERVICE_KEY in the environment
#   . scripts/staging-fixtures.sh
#
# Both replays in `.github/workflows/staging-smoke.yml` create an auth user, use
# it, and delete it again. The invite-claim replay was cured of three defects
# one round at a time (ops(smoke-fixtures), ops(smoke-identity), H31's review):
# a lookup that read one page of users, deletes whose failures `|| true`
# swallowed, and a create that piped curl into jq so GoTrue's own refusal never
# reached the log. The onboard replay kept all three, because each step defined
# its own copies inline — dead only because its address is run-scoped
# (spec-drift audit). They live here now, once, and
# `app/scripts/staging-fixtures.test.ts` drives them against a stub, which the
# inline copies could never be.

admin() { curl -sS -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" "$@"; }

# Every status capture below ends `|| true`. Steps run under `bash -e`, and
# `delete_operator` is called as a plain command, so a curl that cannot
# connect — a non-zero exit — would abort the step from inside `del` with
# nothing reported. `-w` still prints `000`, so the failure is reported as
# HTTP 000 instead. The helpers called inside `$(…)` are shielded today only
# because bash does not pass `-e` into a command substitution unless
# `inherit_errexit` is on; the same guard keeps them honest if it ever is.

# user_id_for <email> — the auth user with this address.
#
# Pages until it finds the address or runs out. It used to read
# `page=1&per_page=100` and stop: its job is to find THIS RUN's leftovers so
# they can be deleted before the fixtures are recreated, and once staging held
# more than 100 auth users they fell off page 1. Cleanup then found nothing,
# the create collided with the row it had failed to remove, and the job failed
# with a message that named neither cause. The bound is there so a project
# with a large user table cannot spin here forever.
#
# Stops on an EMPTY page, never on a short one. A first fix asked for
# `per_page=200` and stopped when a page returned fewer than 200 — but GoTrue
# caps the page size, so page 1 came back with 100, `100 -lt 200` was true, and
# it returned "not found" having read exactly one page: the bug it was written
# to fix, reintroduced by inferring the last page from the size REQUESTED
# rather than from what the server returned.
#
# `seen` guards the other direction: an endpoint that ignores `page` answers
# page 1 forever. That is a failed lookup, not an absence, since nothing past
# page 1 was searched; so is reaching the page bound without an empty page.
# Both used to return "absent" (Codex, on #97).
#
# Exit 0 with the id on stdout (empty = genuinely absent, read to an empty
# page); exit 9 when the LOOKUP failed — non-2xx, a body with no users array,
# a page that repeats the last, or the bound reached. The distinction is
# load-bearing: the claim replay's security assertions read this function, and
# a 401 body read as "absent" would pass the dead-token check while checking
# nothing. Warnings go to stderr because stdout is the captured return value.
user_id_for() {
  local page=1 code lbody id first seen=""
  lbody=$(mktemp)
  while [ "$page" -le 50 ]; do
    code=$(admin -o "$lbody" -w '%{http_code}' "$base/auth/v1/admin/users?page=$page&per_page=100") || true
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
    if [ -n "$first" ] && [ "$first" = "$seen" ]; then
      echo "auth user lookup: page $page repeated page $((page - 1)), so the endpoint ignores the page parameter and only the first page was searched" >&2
      return 9
    fi
    seen=$first
    page=$((page + 1))
  done
  echo "auth user lookup: read 50 pages without reaching an empty one, so the search did not finish" >&2
  return 9
}

# del <url> <what> — a DELETE whose failure is REPORTED, not swallowed. Every
# `|| true` here used to hide a refused delete, which is how leftovers
# accumulated silently until a run could no longer start. Non-fatal — cleanup
# is housekeeping now that fixture addresses are run-scoped, not a
# precondition — but a warning means the accumulation is visible while it is
# still cheap to fix.
del() {
  local code
  code=$(admin -o /dev/null -w '%{http_code}' -X DELETE "$1") || true
  case "$code" in
    2*) return 0 ;;
    *) echo "::warning title=Fixture cleanup left something behind::DELETE $2 -> HTTP $code. Rows accumulate in staging until this is fixed." ;;
  esac
  return 0
}

# delete_operator <uid> — an operator fixture and what the seed trigger gave
# it, in the order the `on delete restrict` foreign keys allow, then its auth
# user (whose id the operators row carries).
delete_operator() {
  [ -n "$1" ] || return 0
  del "$base/rest/v1/service_types?operator_id=eq.$1" "service_types of $1"
  del "$base/rest/v1/operators?id=eq.$1" "operator $1"
  del "$base/auth/v1/admin/users/$1" "auth user $1"
}

# create_user <email> <password> — a confirmed auth user; its id on stdout.
#
# The body is kept, not piped straight into jq. "FAIL: fixture operator user"
# used to be the whole of the diagnosis — the status and GoTrue's own message
# went in the bin, so "already registered", "weak password" and "service key
# rejected" were one indistinguishable red. Only `error_description`/`msg`/
# `message` are printed, never the whole body.
#
# A 422 means cleanup left the previous run's user behind, and which half
# failed is one lookup away: if the search CAN see it, the delete is what is
# broken; if it cannot, the search is. Without this the two look identical.
# A lookup that itself fails is a third answer, not the second — the inline
# version read it as "cannot see". Annotations go to stderr: stdout is the id.
create_user() {
  local body code id msg stale rc
  body=$(mktemp)
  code=$(admin -o "$body" -w '%{http_code}' -X POST "$base/auth/v1/admin/users" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$1\",\"password\":\"$2\",\"email_confirm\":true}") || true
  id=$(jq -r '.id // empty' "$body" 2>/dev/null) || true
  if [ -n "$id" ]; then printf '%s' "$id"; return 0; fi
  msg=$(jq -r '.error_description // .msg // .message // "no message"' "$body" 2>/dev/null || echo "an unreadable body")
  echo "::error title=Could not create the fixture user $1::HTTP $code — $msg" >&2
  if [ "$code" = "422" ]; then
    rc=0; stale=$(user_id_for "$1") || rc=$?
    if [ "$rc" -ne 0 ]; then
      echo "::error title=The leftover could not be looked up::The admin user lookup failed too, so which half of cleanup is broken is unknown." >&2
    elif [ -n "$stale" ]; then
      echo "::error title=Cleanup did not delete the leftover::The lookup can see $1 as $stale, so the DELETE is what failed — most likely an operators row still references the auth user. Delete it by hand and the next run is clean." >&2
    else
      echo "::error title=The lookup cannot see the leftover::GoTrue says $1 exists but the paginated admin search does not return it, so the SEARCH is what is broken, not the delete." >&2
    fi
  fi
  return 1
}
