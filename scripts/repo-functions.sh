#!/usr/bin/env bash
# The edge functions this repository ships, one name per line, sorted.
#
# ONE implementation, because two disagreed twice. `verify-deployment.sh` had
# this predicate inline and `check-status-counters.py` reimplemented it in
# Python; Codex found both divergences on PR #87 within three rounds:
#
#   1. the Python side enumerated `{"_lib", "_tests"}` where this excludes ANY
#      leading-underscore directory and requires `index.ts`;
#   2. `Path.iterdir()` yields dot-directories and the glob `*/` does not, so
#      a `.fixtures/index.ts` counted here and not there.
#
# After the first, a cross-reference comment was judged proportionate and the
# argument written into the PR was that a two-line directory predicate has "no
# input space to disagree over". The second finding refuted that by building
# the input. So the sibling is gone rather than annotated: this is the file,
# and both callers ask it.
#
# The rule is the Supabase CLI's: a directory under supabase/functions/ that
# has an index.ts and whose name does not start with `_`. Dot-directories are
# excluded because they are tooling, never a deployable function — and saying
# so explicitly is what makes the rule independent of one language's directory
# listing happening to hide them.
#
#   FUNCTIONS_DIR   override the source directory (tests)
set -uo pipefail

FUNCTIONS_DIR="${FUNCTIONS_DIR:-supabase/functions}"

shopt -s nullglob
for d in "$FUNCTIONS_DIR"/*/; do
  d=$(basename "$d")
  case "$d" in _* | .*) continue ;; esac
  [ -f "$FUNCTIONS_DIR/$d/index.ts" ] || continue
  printf '%s\n' "$d"
done | sort
