#!/usr/bin/env bash
# Compare a project's LIVE auth configuration against the posture this
# repository intends (review H2, `docs/dev/auth-posture.md`).
#
# Takes the JSON body of `GET /v1/projects/{ref}/config/auth` as a file
# argument, so the checking is separable from the fetching and can be driven
# against fixtures. That split is the point: the first version of this lived
# inline in `staging-smoke.yml`, where nothing could exercise it, and it shipped
# with a defect that only showed up the first time it ever ran against a real
# project — every staging-smoke run between was `skipped`.
#
# ── Absent is not the same as off ────────────────────────────────────────────
#
# The defect was `jq -r '.some_key // false'`. That maps BOTH "the API returned
# false" and "the API has no such key" to the string "false", so a checker
# naming a key this API version does not use is indistinguishable from a
# setting that is genuinely off.
#
# The two need completely different actions. One is a dashboard toggle the
# owner can flip in a minute. The other is a bug in this file that no dashboard
# change can ever satisfy — the gate would stay red forever, through every
# attempt to fix it, with the log insisting the setting is off while it is on.
# That is the "gate that cannot be satisfied" shape, and it is worse than no
# gate at all, because it burns the credibility of every other red this
# repository produces.
#
# So presence is asked separately from value, and an absent key reports itself
# as a checker fault with the response's own key names printed beside it.
#
# ── Values are not dumped ────────────────────────────────────────────────────
#
# `/config/auth` carries SMTP credentials and external provider secrets. This
# script prints the values of the keys it explicitly projects and NEVER the
# whole body; where it needs to show what the API returned in order to be
# diagnosable, it prints key NAMES only.
set -uo pipefail

cfg=${1:-}
if [ -z "$cfg" ] || [ ! -r "$cfg" ]; then
  echo "usage: check-auth-posture.sh <auth-config.json>" >&2
  exit 2
fi

if ! jq -e 'type == "object"' "$cfg" >/dev/null 2>&1; then
  echo "::error title=Auth config is not a JSON object::Could not parse the Management API response as an object. Not printing the body: this endpoint carries SMTP and provider secrets."
  exit 1
fi

fail=0

emit() { echo "$1"; }

# Names the API actually returned. Used only to make an absent key diagnosable.
response_keys() { jq -r 'keys[]' "$cfg"; }

# When a key is missing, the useful thing to print is what the API DID return
# that looks related — that turns "this gate is wrong" into "this gate is wrong
# and here is the name it should be using".
candidates() {
  local key=$1 tok
  local -a toks=()
  for tok in ${key//_/ }; do
    [ ${#tok} -ge 5 ] && toks+=("$tok")
  done
  [ ${#toks[@]} -eq 0 ] && return 0
  local pattern
  pattern=$(IFS='|'; echo "${toks[*]}")
  response_keys | grep -E "$pattern" | tr '\n' ' '
}

missing_key() {
  local key=$1 label=$2
  local found
  found=$(candidates "$key")
  emit "::error title=$label cannot be checked::The auth config has no key '$key', so this check cannot say whether the setting is on or off. Either the Management API renamed it and THIS SCRIPT is wrong (fix it here — no dashboard change can satisfy the gate while it names a key that does not exist), or the endpoint stopped returning it. Related key names in the response: ${found:-(none matched)}. See docs/dev/auth-posture.md."
  fail=1
}

# require_true <api key> <label> <why it matters>
require_true() {
  local key=$1 label=$2 why=$3 val
  if ! jq -e --arg k "$key" 'has($k)' "$cfg" >/dev/null 2>&1; then
    missing_key "$key" "$label"
    return
  fi
  val=$(jq -r --arg k "$key" '.[$k]' "$cfg")
  if [ "$val" = "true" ]; then
    emit "  ok    $label is on"
    return
  fi
  # Present but null is worth saying out loud rather than folding into
  # "false": it is what an unset boolean looks like, and a reader who has just
  # been told the key exists should not have to guess why it is not a boolean.
  local shown=$val
  [ "$val" = "null" ] && shown="null (present, unset)"
  emit "::error title=$label is OFF::Live value: $shown. $why"
  fail=1
}

# require_at_least <api key> <label> <minimum> <why it matters>
require_at_least() {
  local key=$1 label=$2 min=$3 why=$4 val
  if ! jq -e --arg k "$key" 'has($k)' "$cfg" >/dev/null 2>&1; then
    missing_key "$key" "$label"
    return
  fi
  val=$(jq -r --arg k "$key" '.[$k]' "$cfg")
  if ! printf '%s' "$val" | grep -qE '^[0-9]+$'; then
    emit "::error title=$label is not a number::Live value: $val. This check expects an integer; the Management API may have changed the shape of '$key'."
    fail=1
    return
  fi
  if [ "$val" -lt "$min" ]; then
    emit "::error title=$label is $val, below $min::$why"
    fail=1
    return
  fi
  emit "  ok    $label is $val"
}

# warn_unless_set <api key> <label> <why it matters>
warn_unless_set() {
  local key=$1 label=$2 why=$3 val
  if ! jq -e --arg k "$key" 'has($k)' "$cfg" >/dev/null 2>&1; then
    emit "::warning title=$label cannot be checked::No key '$key' in the response. Related names: $(candidates "$key")"
    return
  fi
  val=$(jq -r --arg k "$key" '.[$k]' "$cfg")
  if [ -z "$val" ] || [ "$val" = "0" ] || [ "$val" = "null" ]; then
    emit "::warning title=No $label::$why"
    return
  fi
  emit "  ok    $label is $val"
}

warn_unless_true() {
  local key=$1 label=$2 why=$3 val
  if ! jq -e --arg k "$key" 'has($k)' "$cfg" >/dev/null 2>&1; then
    emit "::warning title=$label cannot be checked::No key '$key' in the response. Related names: $(candidates "$key")"
    return
  fi
  val=$(jq -r --arg k "$key" '.[$k]' "$cfg")
  if [ "$val" != "true" ]; then
    emit "::warning title=$label is off::$why"
    return
  fi
  emit "  ok    $label is on"
}

echo "== deployed auth posture =="

# Two are fatal: they are the ones docs/dev/auth-posture.md calls load-bearing
# for a vault of other people's door codes. The rest warn, because turning
# staging red over settings only the owner can change in a dashboard just
# teaches everyone to ignore the colour.

require_true secure_password_change_enabled "secure_password_change" \
  "An attacker holding a live session can call updateUser({password}) with no knowledge of the current password, then satisfy the vault's password check with the one they just set. Turning this on narrows that window but does NOT close it: GoTrue only demands reauthentication when the session is not 'recently signed in', which means created more than 24h ago. Dashboard -> Authentication -> Providers -> Email."

require_at_least password_min_length "Password floor" 12 \
  "config.toml asks for 12. This password is the only thing between a live session and every door code the operator holds."

warn_unless_set sessions_timebox "session timebox" \
  "An exfiltrated session token is valid until its refresh token is revoked. config.toml asks for 12h."

warn_unless_set sessions_inactivity_timeout "inactivity timeout" \
  "An exfiltrated session token is valid until its refresh token is revoked. config.toml asks for 2h."

warn_unless_true mfa_totp_verify_enabled "TOTP verification" \
  "The vault accepts a password alone. With TOTP on, enrolling a factor closes the stolen-session path with no code change — see docs/dev/auth-posture.md."

warn_unless_true mfa_totp_enroll_enabled "TOTP enrolment" \
  "Operators cannot enrol a second factor, so the vault's aal2 path is unreachable."

# ── the interaction that makes one of the two fatals inert ───────────────────
#
# GoTrue requires reauthentication for a password change only when the session
# is NOT "recently signed in", and recently means created within 24h. A session
# timebox caps how old any session can get. So a timebox at or under 24h means
# every live session is always "recent", and `secure_password_change` can never
# fire — the two hardened values this repository asks for cancel each other out.
#
# Worth saying at the moment it becomes true, because the conclusion is
# actionable: with the timebox set, the ONLY thing between a stolen session and
# every door code is the vault's own aal2 gate, which needs a verified second
# factor to do anything. Enrol one.
#
# Fires only when the timebox is actually set. Today it is 0, so
# `secure_password_change` is genuinely load-bearing and this stays quiet.
timebox=$(jq -r '.sessions_timebox // 0' "$cfg" 2>/dev/null || echo 0)
if printf '%s' "$timebox" | grep -qE '^[0-9]+$' && [ "$timebox" -gt 0 ] && [ "$timebox" -le 86400 ]; then
  emit "::notice title=secure_password_change is now inert::The session timebox is ${timebox}s, so no session can ever be older than 24h — and GoTrue only demands reauthentication for a password change when a session is older than that. secure_password_change can no longer fire. The vault's aal2 gate is now the only control on this path: enrol a TOTP factor. See docs/dev/auth-posture.md."
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "AUTH POSTURE FAIL"
else
  echo "AUTH POSTURE PASS"
fi
exit $fail
