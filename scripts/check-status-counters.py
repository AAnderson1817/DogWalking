#!/usr/bin/env python3
"""CLAUDE.md's two hand-maintained counters must match the tree.

`CLAUDE.md` states, in prose, how many migrations and edge functions this
repository ships. Its own note says the numbers had already gone stale twice
("review H21", then again by 0043) and that "nothing enforces these two
counts" — which is this repository's most-recorded defect wearing a docs hat:
a rule written down and connected to nothing. They went stale a third time at
`0051`, and a handoff reads those numbers as fact.

The check is deliberately narrow. It asserts the two figures, and it FAILS
when it cannot find the sentence carrying one — a parser that matches nothing
reports agreement, which is how `column-grants.test.ts` and
`db-push-check.sh`'s object derivation both had to be fixed.
"""
import os
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CLAUDE_MD = ROOT / "CLAUDE.md"

def deployable_functions(root):
    """The functions this repository actually ships.

    Asks `scripts/repo-functions.sh`, which is also what
    `scripts/verify-deployment.sh` asks — so "N edge functions" here is the
    same set the deploy probe compares against the Management API, by
    construction rather than by two implementations agreeing.

    They did not agree. Codex found both divergences on PR #87: an enumerated
    `{"_lib", "_tests"}` where the shell excluded any leading underscore and
    required `index.ts`, and then `Path.iterdir()` yielding dot-directories
    that the shell glob `*/` never matched. A cross-reference comment was the
    first answer to that and the second finding is what refuted it, so the
    second implementation is gone.
    """
    helper = ROOT / "scripts" / "repo-functions.sh"
    try:
        out = subprocess.run(
            [str(helper)],
            cwd=ROOT,
            env={**os.environ, "FUNCTIONS_DIR": str(root)},
            capture_output=True,
            text=True,
        )
    except OSError as e:
        # A named sentence, not a traceback: an unrunnable helper reads as a
        # broken gate rather than a broken rule, which is the smoke.sql
        # lesson (`session-notes.md`, "assert on a named sentence").
        raise SystemExit(f"FAIL: could not run {helper.relative_to(ROOT)}: {e}")
    if out.returncode != 0:
        raise SystemExit(
            "FAIL: scripts/repo-functions.sh exited "
            f"{out.returncode}: {out.stderr.strip()}"
        )
    return sorted(n for n in out.stdout.split("\n") if n)


failures = []
text = CLAUDE_MD.read_text()

# ── migrations ────────────────────────────────────────────────────────────
m = re.search(r"Migrations run through `(\d+)`", text)
if m is None:
    failures.append(
        "CLAUDE.md no longer carries the sentence \"Migrations run through "
        "`NNNN`\". Either restore it or delete this gate deliberately — a "
        "check that silently matches nothing is worse than no check."
    )
else:
    claimed = m.group(1)
    files = sorted(p.name for p in (ROOT / "supabase" / "migrations").glob("[0-9]*.sql"))
    if not files:
        failures.append("no migrations found under supabase/migrations/")
    else:
        actual = files[-1].split("_", 1)[0]
        if claimed != actual:
            failures.append(
                f"CLAUDE.md says migrations run through `{claimed}`; the tree's "
                f"highest is `{actual}` ({files[-1]})"
            )

# ── edge functions ────────────────────────────────────────────────────────
m = re.search(r"there are (\d+) edge\s+functions", text)
if m is None:
    failures.append(
        "CLAUDE.md no longer carries the sentence \"there are N edge "
        "functions\". Same rule as above."
    )
else:
    claimed = int(m.group(1))
    fns = deployable_functions(ROOT / "supabase" / "functions")
    if not fns:
        failures.append("no edge functions found under supabase/functions/")
    elif claimed != len(fns):
        failures.append(
            f"CLAUDE.md says there are {claimed} edge functions; the tree has "
            f"{len(fns)}: {', '.join(fns)}"
        )

for f in failures:
    print(f"FAIL: {f}")
if failures:
    print()
    print("CLAUDE.md's Phase status paragraph is what a fresh session reads as")
    print("fact. Update it in the same commit as the change that moved a count.")
    sys.exit(1)

print("PASS: CLAUDE.md's migration and edge-function counts match the tree")
