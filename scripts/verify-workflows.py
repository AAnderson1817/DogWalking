#!/usr/bin/env python3
"""Structural checks on the workflow files that YAML validity cannot express.

Every rule here exists because the repository shipped the thing it forbids.

The deploy workflows are the least-exercised code in the project — production
has never run at all, and staging runs once per merge with nobody reading the
log unless it goes red. So a mistake in their gating is both easy to make and
slow to find. All four rules below were written after a real failure, and each
one is checked against the shipped files by `verify-workflows.test.py`-style
sabotage in the PR that introduced it.

Run: python3 scripts/verify-workflows.py
"""
from __future__ import annotations

import pathlib
import re
import sys

import yaml

WORKFLOWS = pathlib.Path(".github/workflows")

# The four GitHub status-check functions. Using ANY of them in a job's `if`
# drops the implicit `success()` that would otherwise require every job in
# `needs` to have succeeded — which is the whole point of using one, and also
# the trap: the gating you dropped is now yours to re-state by hand.
STATUS_FUNCS = ("success(", "failure(", "cancelled(", "always(")

failures: list[str] = []
# Checkouts rule 4 inspected: its eyesight precondition (see main).
chained_checkouts = 0


def fail(workflow: str, job: str, message: str) -> None:
    failures.append(f"{workflow} :: {job} :: {message}")


def check(path: pathlib.Path) -> None:
    global chained_checkouts
    doc = yaml.safe_load(path.read_text())
    if not isinstance(doc, dict):
        return
    # YAML 1.1 reads the bare key `on` as the boolean True.
    triggers = doc.get(True, doc.get("on")) or {}
    if isinstance(triggers, str):
        triggers = [triggers]
    chained = "workflow_run" in triggers
    jobs = doc.get("jobs") or {}
    for name, job in jobs.items():
        if not isinstance(job, dict):
            continue
        condition = str(job.get("if") or "")
        needs = job.get("needs") or []
        if isinstance(needs, str):
            needs = [needs]

        # ── Rule 1: a job may not gate on its own result ──────────────────
        # `needs.<self>.result` is not in `needs`, so it evaluates to empty and
        # never equals 'success'. The job silently never runs.
        #
        # This shipped: `verify-functions` in deploy-staging.yml carried
        # `needs.verify-functions.result == 'success'` in its own condition, so
        # the M4 boot probe was inert from the day it merged — a verification
        # step that verified nothing, which is precisely the failure it exists
        # to prevent. It reached main because the YAML was valid and the job
        # graph (`needs`) was correct; only the condition was wrong.
        if f"needs.{name}." in condition:
            fail(path.name, name, f"`if` references its own result (needs.{name}.…), so it can never run")

        # ── Rule 2: dropping the implicit success() means re-stating it ───
        # A condition using a status function must name every job it needs, or
        # a needed job's failure or skip is silently ignored.
        #
        # This shipped too, as the other half of the same swap: `frontend`
        # declared `needs: [migrate, deploy-functions, verify-functions]` and
        # gated on only the first two, so it released a frontend while the
        # verification job was skipped.
        #
        # `always()` is exempt: it means "run regardless" and the gating moves
        # into the steps, which is what `assert-deployed` deliberately does.
        if needs and any(f in condition for f in STATUS_FUNCS) and "always(" not in condition:
            missing = [n for n in needs if f"needs.{n}." not in condition]
            if missing:
                fail(
                    path.name,
                    name,
                    "`if` uses a status function (dropping the implicit success()) "
                    f"but does not gate on {', '.join(missing)}",
                )

        # ── Rule 3: pushing a ref needs the history to prove it ──────────
        # `actions/checkout` defaults to depth 1. Git cannot prove a push is a
        # fast-forward from a single-commit clone, so the server rejects an
        # ordinary push as though history had diverged.
        #
        # This shipped: the `frontend` job's first push CREATED release/staging
        # and succeeded (creating a ref needs no ancestry check); every push
        # after it was rejected, and the job's own error message blamed a
        # non-descendant commit, sending the reader after a rollback that was
        # not happening.
        steps = job.get("steps") or []
        pushes = any(
            re.search(r"\bgit push\b", str(step.get("run") or "")) for step in steps if isinstance(step, dict)
        )
        if pushes:
            depths = [
                (step.get("with") or {}).get("fetch-depth")
                for step in steps
                if isinstance(step, dict) and str(step.get("uses") or "").startswith("actions/checkout")
            ]
            if not depths:
                fail(path.name, name, "runs `git push` but never checks the repository out")
            elif any(d != 0 for d in depths):
                fail(
                    path.name,
                    name,
                    "runs `git push` from a shallow checkout — set `fetch-depth: 0`, or the push is "
                    "rejected as a non-fast-forward even when it is one",
                )

        # ── Rule 4: a chained run checks out the commit it follows ───────
        # On a `workflow_run` event `github.sha` is the default branch's newest
        # commit when the run STARTS, not the commit the upstream run tested or
        # deployed. A checkout with no `ref` therefore runs whatever reached
        # `main` in between — a smoke replay sourcing newer fixture helpers
        # against an older deployment, or a posture check running a script the
        # deploy never shipped. `deploy-staging.yml` pinned all five of its
        # checkouts from the start; the two workflows chained after it did not
        # (Codex, on #97, named one; the other is its sibling).
        if chained:
            for step in steps:
                if not (isinstance(step, dict) and str(step.get("uses") or "").startswith("actions/checkout")):
                    continue
                chained_checkouts += 1
                ref = str((step.get("with") or {}).get("ref") or "")
                if "github.event.workflow_run.head_sha" not in ref:
                    fail(
                        path.name,
                        name,
                        "checks out without `ref: ${{ github.event.workflow_run.head_sha || github.sha }}` in a "
                        "workflow_run-triggered workflow, so it runs main's newest commit rather than the one the "
                        "upstream run tested or deployed",
                    )


def main() -> int:
    files = sorted(WORKFLOWS.glob("*.yml"))
    if not files:
        print("::error::no workflow files found — this check would pass vacuously")
        return 1
    for path in files:
        check(path)

    # Rule 4 passes vacuously if it sees no chained checkout — a trigger parse
    # that stopped reading `on:` would report every checkout pinned. Seven
    # exist today (five in deploy-staging.yml, one each in the two workflows
    # chained after it); if they are ever all gone on purpose, this is the
    # line to revisit.
    if chained_checkouts == 0:
        failures.append("rule 4 inspected no checkout in any workflow_run-triggered workflow — it checked nothing")

    if failures:
        for line in failures:
            print(f"::error::{line}")
        print(f"\nFAIL: {len(failures)} workflow gating problem(s)")
        return 1
    print(
        f"PASS: {len(files)} workflows — no self-referential conditions, no dropped `needs` gate, "
        f"no shallow push, no unpinned checkout after a workflow_run ({chained_checkouts} checked)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
