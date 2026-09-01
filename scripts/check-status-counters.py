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
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CLAUDE_MD = ROOT / "CLAUDE.md"

def deployable_functions(root):
    """The functions this repository actually ships.

    The predicate is `repo_functions()` in `scripts/verify-deployment.sh`
    (skip a leading-underscore directory, require `index.ts`), which is the
    inventory the deploy probe compares against the Management API — so it is
    what "N edge functions" means. An enumerated exception list was the first
    version and Codex was right to refuse it: `{"_lib", "_tests"}` counts the
    next `_shared/` helper or a scaffold directory with no entrypoint, and a
    gate that goes red on a healthy tree is the one that gets deleted by
    whoever is trying to ship something else. Keep the two in step; a guard
    whose scope disagrees with what it guards is this repository's
    most-repeated defect.
    """
    return sorted(
        p.name
        for p in root.iterdir()
        if p.is_dir() and not p.name.startswith("_") and (p / "index.ts").is_file()
    )

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
