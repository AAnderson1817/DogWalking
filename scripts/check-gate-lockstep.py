#!/usr/bin/env python3
"""The three gate lists agree: `ci.yml`, `SKILL.md` and `validate.sh`.

`CLAUDE.md` calls them a lockstep and nothing checked it, so they drifted the
way an unchecked list does:

  * `db-push-check.sh` and `concurrency.sh` were in `ci.yml` and `SKILL.md`
    and missing from `validate.sh`, each found only after a green local run
    that CI refused, one PR apart (gates 7b and 8b);
  * `session-notes.md` said two gates existed only in CI when there were
    seven, and `SKILL.md` §13 closed its own list with "read the workflow
    rather than trusting this list to stay complete" (spec-drift audit);
  * one CI step's name said "validate gate 7" for a check that is gate 11
    (gate 7 is `db reset`).

So `SKILL.md` §13 is now a table of EVERY named `ci.yml` step and where it
runs here, and this script holds the three files to it:

  1. every named `ci.yml` step has exactly one row, and every row names a step
     that exists (a stale row excuses nothing, which is how an exception
     outlives the thing it excused). Two steps may share a name only if they
     are the same step — the two `Install`s run one command in two jobs — or
     a copied step that runs something else under the old name would be
     described by a row written for the first (Codex, PR #97);
  2. each row says a SKILL.md gate id, `CI only` (a check with no local gate),
     or `setup` (an install, not a check), and a gate id must be a heading;
  3. every SKILL.md gate is run by `validate.sh` under the same id, and every
     gate `validate.sh` runs is a SKILL.md heading. Exactly: the first version
     let any lettered gate stand for its parent, so `8b` still "covered" gate
     8 with gate 8's own run deleted, and an undeclared `7c` passed as part of
     7 (Codex, PR #97). A heading that holds two gates names both, as
     `## 6a / 6b.` and `## 10a / 10b.` do;
  4. a `ci.yml` step that runs a command has a name, or no list can track it.

It fails rather than passing when it can read none of the three — a checker
that saw nothing reports agreement (the `column-grants.test.ts` lesson).
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

import yaml

ROOT = pathlib.Path(__file__).resolve().parent.parent
CI = ROOT / ".github" / "workflows" / "ci.yml"
SKILL = ROOT / ".claude" / "skills" / "validate" / "SKILL.md"
VALIDATE = ROOT / "scripts" / "validate.sh"

TABLE_SECTION = "13"
KINDS = {"setup", "CI only"}

# `## 10a / 10b. Generated artefacts …` is two gates under one heading.
HEADING = re.compile(r"^## (\d+[a-z]?(?:\s*/\s*\d+[a-z]?)*)\.\s", re.M)
# A table row: | `<ci step name>` | <where> |. A name that itself contains a
# backtick (`Would `supabase db push` apply this?`) is written in a double-
# backtick code span, the CommonMark way.
ROW = re.compile(r"^\|\s*(`{1,2})(.+?)\1\s*\|\s*([^|]*?)\s*\|\s*$", re.M)
# `run "7b. db push check" …` — the id before the dot. Skip labels are not
# read: a gate is skipped in one branch and run in the other.
RUN_LABEL = re.compile(r'^\s*run\s+"(\d+[a-z]?)\.', re.M)


def ci_steps(doc: dict) -> tuple[set[str], list[str]]:
    first: dict[str, tuple[str, int, str]] = {}
    problems: list[str] = []
    for job, spec in (doc.get("jobs") or {}).items():
        for i, step in enumerate(spec.get("steps") or [], start=1):
            name = step.get("name")
            if name is None:
                if "run" in step:
                    problems.append(
                        f"ci.yml job `{job}` step {i} runs a command and has no name, so no list can track it"
                    )
                continue
            # The whole step, not only its command: a copy that changes its
            # `with:` or `env:` is a different step too.
            body = json.dumps(step, sort_keys=True, default=str)
            if name in first and first[name][2] != body:
                where = first[name]
                problems.append(
                    f"ci.yml steps `{name}` in job `{where[0]}` (step {where[1]}) and job `{job}` (step {i}) "
                    "share a name and differ, so one SKILL.md row would describe both — name them apart"
                )
            first.setdefault(name, (job, i, body))
    return set(first), problems


def skill_gates(text: str) -> set[str]:
    ids: set[str] = set()
    for m in HEADING.finditer(text):
        ids.update(part.strip() for part in m.group(1).split("/"))
    return ids


def skill_table(text: str) -> tuple[dict[str, str], list[str]]:
    start = re.search(rf"^## {TABLE_SECTION}\.\s", text, re.M)
    if not start:
        return {}, [f"SKILL.md has no `## {TABLE_SECTION}.` section to hold the CI step table"]
    nxt = re.search(r"^## ", text[start.end():], re.M)
    section = text[start.end(): start.end() + nxt.start()] if nxt else text[start.end():]
    table: dict[str, str] = {}
    problems: list[str] = []
    for _, name, where in ROW.findall(section):
        if name in table:
            problems.append(f"SKILL.md §{TABLE_SECTION} lists `{name}` twice")
        table[name] = where
    return table, problems


def validate_ids(text: str) -> set[str]:
    return set(RUN_LABEL.findall(text))


def main() -> int:
    problems: list[str] = []
    try:
        doc = yaml.safe_load(CI.read_text())
        skill = SKILL.read_text()
        validate = VALIDATE.read_text()
    except (OSError, yaml.YAMLError) as e:
        print(f"FAIL: could not read the gate lists: {e}", file=sys.stderr)
        return 1

    steps, step_problems = ci_steps(doc)
    gates = skill_gates(skill)
    table, table_problems = skill_table(skill)
    runs = validate_ids(validate)
    problems += step_problems + table_problems

    # Preconditions, each named: a list read as empty would agree with anything.
    for what, found, floor in (
        ("named ci.yml steps", steps, 20),
        (f"SKILL.md §{TABLE_SECTION} table rows", table, 20),
        ("SKILL.md gate headings", gates, 10),
        ("validate.sh run gates", runs, 10),
    ):
        if len(found) < floor:
            problems.append(f"read only {len(found)} {what} — the parser is not seeing the file")

    gates_here = gates - {TABLE_SECTION}
    for name in sorted(steps - table.keys()):
        problems.append(
            f"ci.yml step `{name}` has no row in SKILL.md §{TABLE_SECTION} — say which gate runs it "
            "here, or `CI only`, or `setup`"
        )
    for name in sorted(table.keys() - steps):
        problems.append(f"SKILL.md §{TABLE_SECTION} lists `{name}`, which is not a ci.yml step — a stale row")
    for name, where in sorted(table.items()):
        if where not in KINDS and where not in gates_here:
            problems.append(
                f"SKILL.md §{TABLE_SECTION} maps `{name}` to `{where}`, which is neither a gate heading "
                f"nor one of {sorted(KINDS)}"
            )

    for gate in sorted(gates_here, key=lambda g: (int(re.match(r"\d+", g).group()), g)):
        if gate not in runs:
            problems.append(f"SKILL.md gate {gate} is not run by validate.sh")
    for run in sorted(runs):
        if run not in gates:
            problems.append(f"validate.sh runs gate {run}, which has no SKILL.md heading")

    if problems:
        for p in problems:
            print(f"FAIL: {p}", file=sys.stderr)
        return 1
    print(
        f"GATE LOCKSTEP PASS: {len(steps)} ci.yml steps tabulated, {len(gates_here)} SKILL.md gates, "
        f"all run by validate.sh"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
