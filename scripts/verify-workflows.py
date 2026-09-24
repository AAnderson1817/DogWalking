#!/usr/bin/env python3
"""Structural checks on the workflow files that YAML validity cannot express.

Every rule here exists because the repository shipped the thing it forbids.

The deploy workflows are the least-exercised code in the project — production
has never run at all, and staging runs once per merge with nobody reading the
log unless it goes red. So a mistake in their gating is both easy to make and
slow to find. All five rules below were written after a real failure (rule 5
after a drift that had not failed yet), and each was proven by sabotage against
the shipped files in the PR that introduced it. Rules 4 and 5 are also driven by
`app/scripts/verify-workflows.test.ts`, which runs this script over fixture
workflows. Rule 4 reads an expression, which has more ways to be wrong than any
file in the tree exercises. Rule 5 compares workflows with one another, and a
tree that agrees never shows it a disagreement.

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
# Rule 5's evidence, gathered across every workflow and judged in main:
# (workflow, job, setup-cli commit, CLI version) and (workflow, job, flags).
cli_pins: list[tuple[str, str, str, str]] = []
function_deploys: list[tuple[str, str, frozenset[str]]] = []
# The two workflows rule 5 exists to hold together. Each must show it its own
# evidence (see main): counted across all workflows, staging's pin and deploy
# alone satisfied the rule, so production could vouch for nothing and pass.
DEPLOY_WORKFLOWS = ("deploy-staging.yml", "deploy-production.yml")

# The value a chained checkout must choose first: the commit the upstream run
# tested or deployed. And what to write, which every chained checkout uses.
UPSTREAM_SHA = "github.event.workflow_run.head_sha"
PIN = "${{ github.event.workflow_run.head_sha || github.sha }}"


def shell_code(script: str) -> str:
    """A `run:` script reduced to the commands bash would run, for rule 5.

    What bash does before it runs anything, done here too:
    - comments are dropped. `#` starts one only at the start of a word, so
      `${#fns[@]}`, `$#` and `a#b` are code;
    - a backslash-newline is removed, joining a continued command into one
      line. Codex on #100 (round 3): `supabase functions deploy \` with its
      flags on the next line read as a deploy with NO flags, so staging's
      `--use-api` against production's nothing compared equal;
    - quote marks are removed and the quoted text stays in its word, so
      `"--use-api"` is still a flag. Whitespace and operators inside it are
      neutralised, so a quoted `a; supabase ...` stays one word and never
      becomes a command;
    - heredoc bodies are skipped. They are data to the command reading
      them, and a deploy mentioned in one used to be counted (round 3; an
      earlier version of this docstring claimed the opposite);
    - an array literal (`x=(...)`) is one word of data, so its contents are
      never read as a command (round 4).

    Stated boundary: this reads what a script says, not which branch runs.
    A deploy in an `if false` branch or a function never called still
    counts. A deploy run through a heredoc fed to bash, a `bash -c` string,
    a wrapper (`timeout 300 supabase ...`) or an unquoted variable
    (`$SB functions deploy`) is missed, which fails loudly as "no deploy"
    when it is the workflow's only one.
    """
    neutral = str.maketrans({ch: "_" for ch in " \t\n;&|()<>#"})
    out: list[str] = []
    i, n = 0, len(script)
    word_start = True
    heredocs: list[tuple[str, bool]] = []  # (delimiter, strip tabs), pending until the line ends
    while i < n:
        c = script[i]
        if c == "\\" and i + 1 < n:
            if script[i + 1] == "\n":
                i += 2
                continue
            out.append(script[i + 1].translate(neutral))
            i += 2
            word_start = False
            continue
        if c == "'":
            end = script.find("'", i + 1)
            end = n if end < 0 else end
            out.append(script[i + 1 : end].translate(neutral))
            i = end + 1
            word_start = False
            continue
        if c == '"':
            j, text = i + 1, []
            while j < n and script[j] != '"':
                if script[j] == "\\" and j + 1 < n:
                    text.append(script[j + 1])
                    j += 2
                else:
                    text.append(script[j])
                    j += 1
            out.append("".join(text).translate(neutral))
            i = j + 1
            word_start = False
            continue
        if c == "#" and word_start:
            end = script.find("\n", i)
            i = n if end < 0 else end
            continue
        if script.startswith("<<", i) and not script.startswith("<<<", i):
            j = i + 2
            strip_tabs = j < n and script[j] == "-"
            j += 1 if strip_tabs else 0
            while j < n and script[j] in " \t":
                j += 1
            delim: list[str] = []
            while j < n and not script[j].isspace() and script[j] not in ";&|()<>":
                ch = script[j]
                if ch in "'\"":
                    close = script.find(ch, j + 1)
                    close = n if close < 0 else close
                    delim.append(script[j + 1 : close])
                    j = close + 1
                elif ch == "\\" and j + 1 < n:
                    delim.append(script[j + 1])
                    j += 2
                else:
                    delim.append(ch)
                    j += 1
            heredocs.append(("".join(delim), strip_tabs))
            out.append("<< ")
            i = j
            word_start = False
            continue
        if c == "\n" and heredocs:
            out.append("\n")
            i += 1
            for delimiter, strip_tabs in heredocs:
                while i < n:
                    end = script.find("\n", i)
                    end = n if end < 0 else end
                    line = script[i:end]
                    i = end + 1
                    if (line.lstrip("\t") if strip_tabs else line) == delimiter:
                        break
            heredocs = []
            word_start = True
            continue
        if c == "(" and out and out[-1] == "=":
            # An array literal (`x=(...)`, `x+=(...)`, `declare -a x=(...)`):
            # its words are data, not a command. Split at `(` like a subshell,
            # `deploy=(supabase functions deploy --use-api ...)` counted as a
            # deploy that never ran (Codex on #100, round 4). A `$(...)` inside
            # one does run, and is missed: the loud direction.
            end = matching_paren(script, i)
            out.append(script[i + 1 : end].translate(neutral))
            i = end + 1
            word_start = False
            continue
        out.append(c)
        word_start = c.isspace() or c in ";&|()<>"
        i += 1
    return "".join(out)


def matching_paren(script: str, i: int) -> int:
    """The index of the `)` closing the `(` at `i`, past quoted strings and
    escapes; the end of the script when it never closes."""
    depth, j, n = 0, i, len(script)
    while j < n:
        ch = script[j]
        if ch == "\\":
            j += 2
            continue
        if ch == "'":
            close = script.find("'", j + 1)
            j = n if close < 0 else close + 1
            continue
        if ch == '"':
            k = j + 1
            while k < n and script[k] != '"':
                k += 2 if script[k] == "\\" else 1
            j = k + 1
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return j
        j += 1
    return n


# Words that may stand before a command without being one, so the command is
# the next word: `if supabase functions deploy ...; then`.
COMMAND_PREFIX = {"if", "then", "else", "elif", "do", "while", "until", "!", "{", "time"}


def deploy_invocations(script: str) -> list[tuple[frozenset[str], list[str]]]:
    """Every `supabase functions deploy` a run: script runs: its flags, and
    the arguments whose flags cannot be read.

    Only in command position: a simple command (split at newlines and
    `; & | ( )`) whose command word, after any prefix word or `NAME=value`
    assignment, is `supabase` followed by `functions deploy`. So
    `echo supabase functions deploy ...` is an echo, not a deploy (Codex on
    #100, round 3). `x=$(supabase functions deploy ...)` is a deploy: the
    substitution runs.

    An argument holding a `$` expansion is expanded when the step runs, so
    the flags it supplies are invisible here: `"${flags[@]}"` in both
    workflows compared equal whatever the arrays held. Those arguments are
    returned as unreadable, and the caller refuses them. The one exemption
    is the value of `--project-ref`, which the real workflows take from a
    secret and which is an argument, not a flag.
    """
    found: list[tuple[frozenset[str], list[str]]] = []
    for segment in re.split(r"[\n;&|()]", shell_code(script)):
        words = segment.split()
        while words and (words[0] in COMMAND_PREFIX or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=\S*", words[0])):
            words.pop(0)
        if words[:3] == ["supabase", "functions", "deploy"]:
            args = words[3:]
            flags = frozenset(m.group(0) for w in args if (m := re.match(r"--[a-z][a-z0-9-]*", w)))
            unreadable = [
                w
                for k, w in enumerate(args)
                if "$" in w and not w.startswith("--project-ref=") and not (k > 0 and args[k - 1] == "--project-ref")
            ]
            found.append((flags, unreadable))
    return found


def skip_string(expr: str, i: int) -> int | None:
    """The index just past the single-quoted string starting at `i`, or None if it never closes.

    Neither a `||` nor a parenthesis inside a string is structure. A GitHub
    expression writes a quote inside a string as `''`, which needs no case of
    its own here: read as one string closing and the next opening, it covers
    exactly the same characters.
    """
    end = expr.find("'", i + 1)
    return None if end < 0 else end + 1


def split_or(expr: str) -> list[str] | None:
    """An expression split on its top-level `||`, or None if its brackets or strings never close."""
    parts: list[str] = []
    depth = start = i = 0
    while i < len(expr):
        c = expr[i]
        if c == "'":
            end = skip_string(expr, i)
            if end is None:
                return None
            i = end
            continue
        if c in "([":
            depth += 1
        elif c in ")]":
            depth -= 1
            if depth < 0:
                return None
        elif depth == 0 and expr.startswith("||", i):
            parts.append(expr[start:i])
            i += 2
            start = i
            continue
        i += 1
    if depth != 0:
        return None
    parts.append(expr[start:])
    return parts


def unparen(expr: str) -> str:
    """An expression without the parentheses that wrap ALL of it: `(a || b)` is `a || b`, `(a) || (b)` stays."""
    s = expr.strip()
    while s.startswith("(") and s.endswith(")"):
        depth, i = 0, 0
        while i < len(s):
            if s[i] == "'":
                end = skip_string(s, i)
                if end is None:
                    return s
                i = end
                continue
            if s[i] == "(":
                depth += 1
            elif s[i] == ")":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        if i != len(s) - 1:
            return s  # the first parenthesis closes early, so it wraps only part
        s = s[1:-1].strip()
    return s


def choices(expr: str) -> list[str] | None:
    """The operands of a `||` chain in the order they are tried, through wrapping parentheses and nested chains.

    None if the chain is unreadable: a bracket or string that never closes, or
    a `||` with nothing on one side.
    """
    parts = split_or(unparen(expr))
    if parts is None:
        return None
    if len(parts) == 1:
        operand = unparen(parts[0])
        return [operand] if operand else None
    out: list[str] = []
    for part in parts:
        sub = choices(part)
        if sub is None:
            return None
        out.extend(sub)
    return out


def pin_problem(ref: str) -> str | None:
    """Why a chained checkout's `ref` may check out the wrong commit, or None if it cannot.

    `||` yields its first truthy operand, and on a `workflow_run` event
    head_sha is always set, so it must be the FIRST choice: anything before it
    wins over it (Codex, on #97: `${{ github.sha || … head_sha }}` passed a
    substring test while `github.sha`, always set, was the value chosen). What
    follows it is the fallback, chosen on any other event, where head_sha is
    empty; every chained workflow here can also be dispatched by hand, and a
    dispatch should check out the commit it was dispatched on, which is
    `github.sha`. So each later choice must be exactly that (Codex, on #97,
    one round later: `head_sha || inputs.ref` checked out whatever ref the
    dispatcher typed). The fallback is required, not just checked when
    present: with none, a dispatch checks out an empty ref, and what that
    means is actions/checkout's default rather than anything this file can
    read. It is checked even where nothing but `workflow_run` triggers the
    workflow, where it is dead code — one trigger away from not being.

    The ref must be one `${{ }}` expression and nothing else, since text
    around it becomes part of the ref. Only the canonical spelling is read:
    another case, index syntax or a function of the SHA is refused rather than
    guessed at, and the message says what to write instead.
    """
    run_commit = (
        "so on a workflow_run event it may run main's newest commit rather than the one the upstream run "
        "tested or deployed"
    )
    dispatch = "so on a manual dispatch, where the upstream SHA is empty,"
    text = ref.strip()
    if not text:
        return f"checks out without a `ref`, {run_commit}"
    whole = re.fullmatch(r"\$\{\{(.*)\}\}", text, re.S)
    if not whole or "${{" in whole.group(1) or "}}" in whole.group(1):
        return f"checks out `ref: {text}`, which is not one `${{{{ }}}}` expression the check can read, {run_commit}"
    chain = choices(whole.group(1))
    if chain is None:
        return (
            f"checks out `ref: {text}`, which the check cannot read as a `||` chain (a bracket or string "
            f"never closes, or a `||` has no operand), {run_commit}"
        )
    if chain[0] != UPSTREAM_SHA:
        return f"checks out `ref: {text}`, whose first choice is `{chain[0]}`, not `{UPSTREAM_SHA}`, {run_commit}"
    if len(chain) == 1:
        return (
            f"checks out `ref: {text}`, which has no fallback, {dispatch} the ref is empty too, and what is "
            "checked out is actions/checkout's default rather than anything this ref names"
        )
    for fallback in chain[1:]:
        if fallback != "github.sha":
            return (
                f"checks out `ref: {text}`, whose fallback is `{fallback}`, not `github.sha`, {dispatch} it may "
                "check out a commit other than the one it was dispatched on"
            )
    return None


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
        # (Codex, on #97, named one; the other is its sibling). The ref is read
        # as an expression, not searched for a name, and the fallback a manual
        # dispatch checks out is read with it: see `pin_problem`.
        if chained:
            for step in steps:
                if not (isinstance(step, dict) and str(step.get("uses") or "").startswith("actions/checkout")):
                    continue
                chained_checkouts += 1
                why = pin_problem(str((step.get("with") or {}).get("ref") or ""))
                if why:
                    fail(path.name, name, f"{why} — write `ref: {PIN}`")

        # Rule 5's evidence (judged in main, across workflows): every Supabase
        # CLI this job installs, and every function deploy it runs.
        for step in steps:
            if not isinstance(step, dict):
                continue
            uses = str(step.get("uses") or "")
            if uses.startswith("supabase/setup-cli@"):
                version = str((step.get("with") or {}).get("version") or "")
                cli_pins.append((path.name, name, uses.split("@", 1)[1].strip(), version))
            for flags, unreadable in deploy_invocations(str(step.get("run") or "")):
                function_deploys.append((path.name, name, flags))
                for word in unreadable:
                    fail(
                        path.name,
                        name,
                        f"rule 5 cannot read the flags of `supabase functions deploy`: `{word}` is expanded when the step "
                        "runs, so the flags it supplies are invisible to the comparison — write the flags out",
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

    # ── Rule 5: one Supabase CLI, and one way to deploy functions ────────
    # Staging is the only place a CLI version or a deploy path is exercised
    # before production runs it — no workflow a pull request triggers uses the
    # CLI — so production must run exactly what staging ran. Every setup-cli
    # step carried "keep in lockstep with deploy-staging.yml", a rule written
    # down and connected to nothing, and it had already drifted: the owner's
    # 4c45ab1 moved staging's function deploy to `--use-api` and production's
    # stayed on the Docker bundler. So: one setup-cli commit, one exact CLI
    # release, and the same flags on every `supabase functions deploy`.
    #
    # And each deploy workflow must show the rule its OWN pin and its own
    # function deploy. This used to be a global "saw nothing" check, which
    # staging's evidence alone satisfied: with production's deploy removed, or
    # wrapped past the scanner as `${SB:-supabase} functions deploy`, the
    # comparisons ran over staging alone and passed (Codex, on #100; both
    # reproduced). Agreement with nothing is not agreement.
    present = {p.name for p in files}
    for workflow in DEPLOY_WORKFLOWS:
        if workflow not in present:
            failures.append(f"rule 5: there is no {workflow}, so it cannot hold staging and production to one CLI and one deploy path")
            continue
        if not any(w == workflow for w, _, _, _ in cli_pins):
            failures.append(
                f"rule 5 read no supabase/setup-cli step in {workflow}, so it cannot tell which CLI that workflow deploys with"
            )
        if not any(w == workflow for w, _, _ in function_deploys):
            failures.append(
                f"rule 5 read no `supabase functions deploy` in {workflow}, so it cannot tell which path that workflow "
                "deploys by — a deploy the scanner cannot read would let the other workflow vouch for it"
            )
    for workflow, job, ref, version in cli_pins:
        if not re.fullmatch(r"[0-9a-f]{40}", ref):
            fail(workflow, job, f"supabase/setup-cli is pinned to `{ref}`, not a commit SHA")
        if not re.fullmatch(r"\d+\.\d+\.\d+", version):
            fail(workflow, job, f"the Supabase CLI version is `{version or '(unset)'}`, not an exact release — pin X.Y.Z")
    for what, values in (
        ("supabase/setup-cli commit", {(w, j, r) for w, j, r, _ in cli_pins}),
        ("Supabase CLI version", {(w, j, v) for w, j, _, v in cli_pins}),
    ):
        distinct = {v for _, _, v in values}
        if len(distinct) > 1:
            listed = "; ".join(f"{w} :: {j} = {v}" for w, j, v in sorted(values))
            failures.append(f"rule 5: the {what} differs between jobs, so production would run what staging never did: {listed}")
    if len({flags for _, _, flags in function_deploys}) > 1:
        listed = "; ".join(
            f"{w} :: {j} = {' '.join(sorted(f)) or '(no flags)'}" for w, j, f in sorted(function_deploys, key=lambda t: (t[0], t[1]))
        )
        failures.append(f"rule 5: `supabase functions deploy` runs with different flags, so staging does not rehearse production's path: {listed}")

    if failures:
        for line in failures:
            print(f"::error::{line}")
        print(f"\nFAIL: {len(failures)} workflow gating problem(s)")
        return 1
    version = cli_pins[0][3]
    print(
        f"PASS: {len(files)} workflows — no self-referential conditions, no dropped `needs` gate, "
        f"no shallow push, no unpinned checkout after a workflow_run ({chained_checkouts} checked), "
        f"one Supabase CLI ({version}, {len(cli_pins)} pins) and one function-deploy path ({len(function_deploys)} deploys)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
