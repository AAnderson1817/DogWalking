# Helpers for the staging smoke replays' throwaway fixtures. SOURCED, not run:
#
#   base="https://<ref>.supabase.co"   # SERVICE_KEY and ANON_KEY in the environment
#   . scripts/staging-fixtures.sh
#
# ANON_KEY is for the helpers that act as a signed-in user (sign_in,
# purge_client, erase_client); everything else uses the service key.
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

# message_of <body file> — what a refusal said, in GoTrue's or PostgREST's own
# words, and never the whole body. An empty body is "no answer": jq reads it as
# no input, prints nothing and succeeds, so without the check a dropped
# connection was reported as "HTTP 000 — " and a blank.
message_of() {
  local m
  [ -s "$1" ] || { printf 'no answer'; return 0; }
  m=$(jq -r '.error_description // .msg // .message // "no message"' "$1" 2>/dev/null) || m="an unreadable body"
  printf '%s' "$m"
}

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
# with a large user table cannot spin here forever: 50 pages, or
# USER_LOOKUP_MAX_PAGES (the tests set it low).
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
  local page=1 max=${USER_LOOKUP_MAX_PAGES:-50} code lbody id first seen=""
  lbody=$(mktemp)
  while [ "$page" -le "$max" ]; do
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
  echo "auth user lookup: read $max pages without reaching an empty one, so the search did not finish" >&2
  return 9
}

# del <url> <what> — a DELETE whose failure is REPORTED, not swallowed. Every
# `|| true` here used to hide a refused delete, which is how leftovers
# accumulated silently until a run could no longer start. Non-fatal — cleanup
# is housekeeping now that fixture addresses are run-scoped, not a
# precondition — but a warning means the accumulation is visible while it is
# still cheap to fix.
#
# Every delete succeeds on a healthy run, so a warning here is news. It used to
# end "Rows accumulate in staging until this is fixed", on every run, for a
# claimed client no plain delete could remove (see erase_client): four warnings
# on every green run, which teaches whoever reads the log to skip warnings.
del() {
  local code
  code=$(admin -o /dev/null -w '%{http_code}' -X DELETE "$1") || true
  case "$code" in
    2*) return 0 ;;
    *) echo "::warning title=Fixture cleanup left something behind::DELETE $2 -> HTTP $code, so it stays in staging. On a healthy run nothing does." ;;
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

# sign_in <email> <password> — a password grant, sent the way the app sends it:
# with the anon key. Its access token on stdout; exit 1 with GoTrue's own
# message on stderr when refused. A 2xx with no token is a refusal too, since
# nothing can act on it (the create_user rule).
#
# The caller masks the token: a workflow command printed from inside `$(…)`
# would be captured with it rather than read by the runner.
sign_in() {
  local body code tok
  body=$(mktemp)
  code=$(curl -sS -o "$body" -w '%{http_code}' -X POST "$base/auth/v1/token?grant_type=password" \
    -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
    -d "{\"email\":\"$1\",\"password\":\"$2\"}") || true
  tok=$(jq -r '.access_token // empty' "$body" 2>/dev/null) || true
  case "$code" in
    2??) if [ -n "$tok" ]; then printf '%s' "$tok"; return 0; fi ;;
  esac
  echo "sign-in as $1 refused: HTTP $code — $(message_of "$body")" >&2
  return 1
}

# purge_client <access token> <client id> <body file> — `fn_purge_client` as the
# holder of that session, the way the product's erasure calls it: the function
# answers only the client's own operator, so the service key cannot stand in.
# The HTTP status on stdout, the response in <body file>.
purge_client() {
  curl -sS -o "$3" -w '%{http_code}' -X POST "$base/rest/v1/rpc/fn_purge_client" \
    -H "apikey: $ANON_KEY" -H "Authorization: Bearer $1" -H "Content-Type: application/json" \
    -d "{\"p_client\":\"$2\"}" || true
}

# erase_client <operator email> <password> <client id> — a fixture client,
# erased the way the product erases one, then deleted.
#
# A claimed client cannot simply be deleted. The claim writes an
# `invite_claim_attempts` row, that table is append-only (0039, the H4 trail),
# and its `client_id` is ON DELETE RESTRICT. The client then pins everything
# else: `clients.auth_user_id` pins the client's auth user, `clients.operator_id`
# pins the operator, and `operators.id` pins the operator's auth user. So every
# run of the claim replay used to leave all four behind, with a warning each.
#
# The purge is the way out. It nulls `auth_user_id`, and once `purged_at` is
# set, 0042 lets it delete the client's attempt rows (the address somebody typed
# is personal data too). After it nothing references the client, so the row,
# the operator and both auth users all delete. `supabase/tests/smoke.sql` holds
# both halves locally, the pin and the clean teardown, so a migration that adds
# a reference the purge does not clear fails there first.
#
# The delete is attempted even when the purge was not: a client that was never
# claimed has no attempt rows and deletes without one, and the warning names
# whichever step failed.
erase_client() {
  local tok body code
  [ -n "$3" ] || return 0
  if tok=$(sign_in "$1" "$2"); then
    echo "::add-mask::$tok"
    body=$(mktemp)
    code=$(purge_client "$tok" "$3" "$body")
    case "$code" in
      2*) ;;
      *) echo "::warning title=Fixture cleanup left something behind::fn_purge_client for client $3 -> HTTP $code — $(message_of "$body"). A claimed client cannot be deleted until it is purged." ;;
    esac
  else
    echo "::warning title=Fixture cleanup left something behind::could not sign in as $1 to purge client $3, and a claimed client cannot be deleted until it is purged."
  fi
  del "$base/rest/v1/clients?id=eq.$3" "client $3"
}

# create_user <email> <password> — a confirmed auth user; its id on stdout.
#
# The body is kept, not piped straight into jq. "FAIL: fixture operator user"
# used to be the whole of the diagnosis — the status and GoTrue's own message
# went in the bin, so "already registered", "weak password" and "service key
# rejected" were one indistinguishable red. Only `error_description`/`msg`/
# `message` are printed, never the whole body.
#
# Success is a 2xx AND an id. An id alone used to be enough, so a refusal
# whose body named a user — a collision identifying the EXISTING account —
# was reported as the new fixture: both replays would then have used that
# account, and each one's EXIT trap passes the id to `delete_operator`, which
# would have deleted it (Codex, on #97). A 2xx with no id is a failure too:
# there is no fixture to use or clean up.
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
  case "$code" in
    2??) if [ -n "$id" ]; then printf '%s' "$id"; return 0; fi ;;
  esac
  msg=$(message_of "$body")
  [ -z "$id" ] || msg="$msg (the response names user $id, which is not taken as this run's fixture without a 2xx)"
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
