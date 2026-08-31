#!/usr/bin/env bash
# Verify the walk photo integrity records written since migration 0047.
#
# ── Why this exists in the same commit as the columns ─────────────────────
#
# 0047 adds `walk_photos.sha256` / `.byte_size`, and no product surface reads
# them: the report card shows the photo, not its digest. A column that is
# written and never read is a shape this repository has shipped repeatedly and
# regretted every time — a `refunded` status nothing wrote, an `active` column
# that never existed, `updateClient` with zero importers. The specific danger
# here is worse than usual, because there is no feedback at all: a digest taken
# over the WRONG bytes looks identical to a correct one until something checks,
# and the wrong version of that line is one word from natural.
#
# So this is the consumer. It belongs to the disaster-recovery rehearsal
# (docs/dev/disaster-recovery.md §6), not to the app.
#
# ── What a mismatch means, and what it does NOT mean ──────────────────────
#
# THIS IS NOT TAMPER EVIDENCE, and the wording below is deliberate. The digest
# is computed by the operator's own browser over bytes the operator chose, and
# stored in a row the operator may delete and re-insert at will (`authenticated`
# holds SELECT/INSERT/DELETE on `walk_photos`). Anyone wanting a different photo
# on a report deletes the row, uploads new bytes and inserts a fresh row whose
# digest matches perfectly.
#
# A mismatch therefore means STORAGE DIVERGENCE — an object replaced, a
# faithless copy restored from a mirror, bit-rot. It is not evidence of
# misconduct by a named person about a named house, and the most probable cause
# of one is a bug of ours. Nothing here prints the word "tampering".
#
# ── Three states, never two ───────────────────────────────────────────────
#
# match / mismatch / not-recorded. Collapsing the last two is the failure this
# is built to avoid: rows predating 0047 are permanently NULL by design (a
# digest cannot be reconstructed, and a guessed one is indistinguishable from a
# real one), and so is any row `complete-walk` won the race for, since it has
# paths but no bytes and the table carries no UPDATE grant to fill one in later.
#
# COVERAGE is therefore the number that matters most, and it is printed on
# every run including a clean one. A digest path that silently writes nothing
# shows up here as coverage that stops climbing — and would otherwise show up
# as a run with zero mismatches, which reads exactly like success.
#
# Exit status: non-zero ONLY on a genuine mismatch. Absent digests never fail
# the run; a check that goes red on a healthy tree is a check that gets deleted
# by whoever is trying to ship something unrelated.
#
#   DB_URL=postgresql://...  SUPABASE_URL=https://x.supabase.co \
#   SUPABASE_SERVICE_ROLE_KEY=...  scripts/verify-photo-integrity.sh [--limit N]
set -uo pipefail

DB_URL="${DB_URL:-${LOCAL_DB_URL:-}}"
LIMIT=""
[ "${1:-}" = "--limit" ] && LIMIT="limit ${2:?--limit needs a number}"

if [ -z "$DB_URL" ]; then
  echo "FAIL: set DB_URL (or LOCAL_DB_URL) to the database to verify" >&2
  exit 2
fi
for tool in psql curl sha256sum; do
  command -v "$tool" >/dev/null || { echo "FAIL: $tool is required" >&2; exit 2; }
done

# ── Coverage first, and unconditionally ───────────────────────────────────
read -r total recorded < <(psql "$DB_URL" -tA -F' ' -c \
  "select count(*), count(sha256) from walk_photos" 2>/dev/null) || {
  echo "FAIL: could not read walk_photos from \$DB_URL" >&2; exit 2; }

echo "walk_photos rows:      $total"
echo "with a digest:         $recorded"
if [ "$total" -gt 0 ]; then
  echo "coverage:              $(( recorded * 100 / total ))%"
fi

if [ "$recorded" -eq 0 ]; then
  # Not a failure: before 0047 every row is NULL by design. It IS the thing to
  # look at if photos have been taken since, so say which case this is rather
  # than reporting a serene "0 mismatches".
  echo
  echo "No digests recorded yet. Every row predating 0047 is permanently NULL;"
  echo "if photos have been uploaded since 0047 deployed, the digest path is"
  echo "not running and that is the finding."
  exit 0
fi

if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  echo
  echo "Coverage only: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to fetch"
  echo "the objects and compare them. Nothing was verified." >&2
  exit 0
fi

# ── Compare recorded bytes against stored bytes ───────────────────────────
match=0; mismatch=0; missing=0
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT

while IFS=$'\t' read -r id path want_sha want_size; do
  [ -z "$id" ] && continue
  code=$(curl -sS -o "$tmp" -w '%{http_code}' \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    "$SUPABASE_URL/storage/v1/object/walk-photos/$path" 2>/dev/null) || code="000"

  if [ "$code" != "200" ]; then
    # The object is gone, not wrong. A missing object is a storage-divergence
    # finding of its own, but it is not a byte mismatch and must not be counted
    # as one.
    missing=$((missing + 1))
    echo "GONE      $path (HTTP $code) — row $id has a digest but no object"
    continue
  fi

  got_sha=$(sha256sum "$tmp" | cut -d' ' -f1)
  got_size=$(wc -c < "$tmp" | tr -d ' ')
  if [ "$got_sha" = "$want_sha" ]; then
    match=$((match + 1))
  else
    mismatch=$((mismatch + 1))
    echo "DIVERGED  $path"
    echo "          recorded at upload: $want_sha ($want_size bytes)"
    echo "          stored now:         $got_sha ($got_size bytes)"
    echo "          The bytes at this path are not the bytes recorded when it"
    echo "          was uploaded. Most likely storage divergence — an object"
    echo "          replaced, or a copy restored from a mirror."
  fi
done < <(psql "$DB_URL" -tA -F$'\t' -c \
  "select id, storage_path, sha256, byte_size from walk_photos
    where sha256 is not null order by created_at $LIMIT")

echo
echo "verified:              $match"
echo "diverged:              $mismatch"
echo "object gone:           $missing"

[ "$mismatch" -eq 0 ] || exit 1
