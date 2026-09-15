#!/usr/bin/env python3
"""Keep `ci.yml`, `validate.sh` and `SKILL.md` in the lockstep CLAUDE.md claims.

`CLAUDE.md` says, of the validation gate: "Keep the three in lockstep: `ci.yml`,
`SKILL.md`, `validate.sh`." Nothing enforced that, which is this repository's
single most-recorded defect — a rule written down and connected to nothing —
and it had already drifted three ways when the spec-drift audit looked:

  * `db-push-check.sh` was a CI-only gate for a whole PR, so an 18-of-18 local
    run could not see the one gate that catches an ungranted object
    (`security(0050)`). `concurrency.sh` was the same, one PR later
    (`money(send-once)`), and both were found only when CI refused a commit
    that had passed locally.
  * `docs/dev/session-notes.md` told a fresh session that TWO gates exist only
    in CI. The audit that found it said seven. Measured by this script against
    the tree, there are fifteen — so the note was wrong, and the correction the
    audit proposed would have been wrong too. That is the argument for counting
    it here rather than writing another number into prose.
  * `ci.yml`'s secret-leak step called itself "validate gate 7". Gate 7 is the
    database reset; the secret-leak grep is gate 11.

So every named `run:` step in `ci.yml` is classified here, in one place, as
exactly one of:

  SETUP     — installs a toolchain, not a check. Nothing to mirror.
  <label>   — the `validate.sh` gate that runs the same check locally. The
              label must exist in `validate.sh`, so renaming a gate there
              without looking here is caught.
  CI_ONLY   — genuinely has no local counterpart, and must therefore be named
              VERBATIM in SKILL.md §13, which is the list a person reads to
              find out what a green local run did not tell them.

The map is an allowlist of exceptions to "every check runs in both places",
editable only here and only in the same commit as the step it describes — the
`no-raw-hex.test.ts` / `TEXT_RE_EXEMPTIONS` shape. A step in neither the map
nor §13 fails by name, and so does a §13 entry naming a step that no longer
exists: a stale entry excuses a real check forever, which is the failure mode
`verify-deployment.sh`'s `contract_for` was given the same treatment for.
"""

from __future__ import annotations

import pathlib
import re
import sys

import yaml

ROOT = pathlib.Path(__file__).resolve().parent.parent
CI = ROOT / ".github/workflows/ci.yml"
SKILL = ROOT / ".claude/skills/validate/SKILL.md"
VALIDATE = ROOT / "scripts/validate.sh"
SESSION_NOTES = ROOT / "docs/dev/session-notes.md"

SETUP = "SETUP"
CI_ONLY = "CI_ONLY"

# validate.sh labels that legitimately have no ci.yml step. Both are UMBRELLA
# skip labels: `validate.sh` prints one of these when a whole family's
# prerequisite is missing locally, and then never prints the individual gates
# at all. CI always has deno and a database, so there is nothing for them to
# mirror. Named, never pattern-matched, so the exception is editable only here
# and only in the same commit as the thing it excuses.
LOCAL_ONLY: set[str] = {
    "6. edge functions",   # printed instead of 6a/6b when deno is absent
    "7-8. database",       # printed instead of 7/7b/8/8b/8c/8d with no LOCAL_DB_URL
}

# ci.yml step name -> SETUP, CI_ONLY, or the validate.sh gate label that runs
# the same check locally.
COVERAGE: dict[str, str] = {
    # ── frontend ──────────────────────────────────────────────────────────
    "Install": SETUP,
    "Typecheck": "1. typecheck",
    "Lint (warnings fail)": "2. lint",
    "Unit tests": "3. unit tests",
    "Build": "4. build",
    "The built service worker is stamped, and precaches a usable shell": CI_ONLY,
    "A production build without Supabase config is refused": CI_ONLY,
    "Every test file is claimed by a vitest project": CI_ONLY,
    "The deployed frontend sets its security headers": CI_ONLY,
    "Deploy workflow gating": "10c. workflow gating",
    "The three gate lists are in lockstep": "10g. gate lockstep",
    "CLAUDE.md's counts match the tree": "10d. status counters",
    "Secret-leak grep (validate gate 11)": "11. no secret literals",
    "The build stamps the commit it was built from": CI_ONLY,
    "version.json is excluded from the SPA rewrite": CI_ONLY,
    "DEV fixtures absent from the production bundle": CI_ONLY,
    "Every CSS token used is a token that exists": "12. css tokens defined",
    "Behavioural tests still execute": CI_ONLY,
    "Exactly one <main>, owned by AppMain": CI_ONLY,
    # ── e2e ───────────────────────────────────────────────────────────────
    "Resolve the Playwright version": SETUP,
    "Chromium browser": SETUP,
    "Today composition (4 viewports)": "5. e2e",
    "Today contrast (sampled from the artwork)": "5. e2e",
    "Tint contrast (rendered component gallery)": "5. e2e",
    "Today plate responsive candidates": "5. e2e",
    "Calendar week geometry": "5. e2e",
    "Every e2e spec is actually run by this workflow": CI_ONLY,
    # ── edge functions ────────────────────────────────────────────────────
    "Typecheck entrypoints": "6a. deno check",
    "Tests": "6b. deno test",
    "Every 5xx throw carries its cause": CI_ONLY,
    "No secret logging grep (phase 01 gate)": CI_ONLY,
    # ── database ──────────────────────────────────────────────────────────
    "Reset — shim + migrations 0001..NNNN + seed": "7. db reset",
    "Push endpoint allowlist — both implementations agree": "8c. push endpoint parity",
    "Walk cost parity — TS leaf, fn_walk_cost and the snapshot trigger agree": "8d. walk cost parity",
    "Would `supabase db push` apply this?": "7b. db push check",
    "Smoke suite (credit engine + full spec-03 security matrix)": "8. smoke.sql",
    "Materializer suite (idempotency, skips, no resurrection)": "8. materializer.sql",
    "Concurrency suite (the row lock behind invariant 1)": "8b. concurrency suite",
    "Invariant 1 — credit_balance written only by fn_ledger_apply": CI_ONLY,
    "The nightly schedule is in a migration": CI_ONLY,
    "Generated types match the schema": "10b. generated types",
    "Spec 03's definer catalogue matches the migrations": "10a. definer catalogue",
    "Spec 01's enum catalogue matches the migrations": "10e. enum catalogue",
    "The catalogue generators' proof set holds": "10f. catalogue generator proofs",
    # ── migrations ────────────────────────────────────────────────────────
    "No edits to migrations that already exist on the base branch": "9. append-only migrations",
}


def ci_steps() -> list[str]:
    """Every named `run:` step in ci.yml. A `uses:` step runs an action, not a
    check of ours, and has nothing to mirror."""
    workflow = yaml.safe_load(CI.read_text())
    names: list[str] = []
    for job in workflow["jobs"].values():
        for step in job.get("steps", []):
            if "run" in step and "name" in step:
                names.append(step["name"])
    return names


def skill_ci_only() -> list[str]:
    """The step names listed in SKILL.md §13, read as ``- `exact name` — …``."""
    text = SKILL.read_text()
    m = re.search(r"^## 13\..*?$(.*?)(?=^## |\Z)", text, re.M | re.S)
    if not m:
        return []
    return re.findall(r"^- `([^`]+)`", m.group(1), re.M)


def validate_labels() -> set[str]:
    """Gate labels declared in validate.sh, from `run "…"` and `skip_gate "…"`.

    One label is computed: the SQL suites run from a glob, as
    `for f in supabase/tests/*.sql; do run "8. $(basename "$f")"`, so that a
    suite added there is picked up without anyone remembering to. That is the
    right behaviour and the reason the label cannot simply be read, so the glob
    is expanded here exactly as the shell expands it — five lines, and adding a
    third suite makes its gate label appear on its own.
    """
    text = VALIDATE.read_text()
    # Anchored to a COMMAND position — start of line, optional indent — because
    # the unanchored version read prose. It was not a latent defect: the first
    # version swallowed `the same gates in the same order` out of the sentence
    # in `validate.sh`'s own gate-7b comment and carried it as a gate label.
    # Inert, since nothing mapped to it, and exactly the mention-versus-use
    # distinction this repository has paid for before — a commented-out
    # `# run "10f. …"` would likewise have read as a gate that still runs.
    labels = set(re.findall(r'^[ \t]*(?:run|skip_gate) +"([^"]+)"', text, re.M))
    # `finditer`, not `search`. There is one such loop today; a `search` would
    # expand only the FIRST, and a ci.yml step mapped to a label from a second
    # one would then be reported as claiming a gate validate.sh does not
    # declare — a legible red, but on a healthy tree, and this repository's log
    # calls that the worst shape available. One loop or five costs the same.
    for m in re.finditer(
        r'for (\w+) in (\S+); do\n\s*run "([^"$]*)\$\(basename "\$\1"\)"', text
    ):
        prefix = m.group(3)
        labels.discard(prefix + '$(basename ')
        for f in sorted(ROOT.glob(m.group(2))):
            labels.add(prefix + f.name)
    return labels


def main() -> int:
    steps = ci_steps()
    if not steps:
        print("FAIL: read no named run-steps out of ci.yml — this check is blind")
        return 2

    failures: list[str] = []

    # 1. Every ci.yml check is classified. A new step is in neither the map nor
    #    §13, so it fails here rather than drifting silently.
    unclassified = [n for n in steps if n not in COVERAGE]
    for n in unclassified:
        failures.append(
            f"ci.yml step {n!r} is not classified in scripts/check-gate-lockstep.py — "
            "give it a validate.sh gate label, or CI_ONLY and a SKILL.md §13 entry"
        )

    # 2. A mapped validate.sh label must exist there, or renaming a gate
    #    locally leaves this map pointing at nothing.
    labels = validate_labels()
    if not labels:
        failures.append("read no gate labels out of validate.sh — this check is blind")
    # The GATE LABELS the map names, which is not the same as its values: SETUP
    # and CI_ONLY are sentinels, and comparing a validate.sh label against
    # `COVERAGE.values()` would let a local gate named `CI_ONLY` excuse itself.
    # Contrived as a name, wrong as a rule — the question is whether a ci.yml
    # step claims this label, and a sentinel is not a step claiming anything.
    mapped = {v for v in COVERAGE.values() if v not in (SETUP, CI_ONLY)}
    for name, target in COVERAGE.items():
        if target in (SETUP, CI_ONLY):
            continue
        if target not in labels:
            failures.append(
                f"{name!r} claims validate.sh gate {target!r}, which validate.sh does not declare"
            )

    # 2b. And the OTHER direction, which the first version did not ask: a gate
    #     added to validate.sh with no ci.yml step behind it. Codex found it on
    #     PR #94 — the check only ever iterated COVERAGE into labels, so a new
    #     local gate that CI does not run reported the three lists in lockstep,
    #     which is the invariant inverted. LOCAL_ONLY is the allowlist.
    for label in sorted(labels - LOCAL_ONLY):
        if label not in mapped:
            failures.append(
                f"validate.sh declares gate {label!r}, which no ci.yml step runs — "
                "add the step, or add the label to LOCAL_ONLY with a reason"
            )

    # 2c. A stale LOCAL_ONLY entry excuses a gate that no longer exists, the
    #     same failure as a stale map entry one rule down.
    for label in sorted(LOCAL_ONLY - labels):
        failures.append(
            f"scripts/check-gate-lockstep.py excuses {label!r} as local-only, "
            "which validate.sh does not declare"
        )

    # 3. A map entry naming a step ci.yml no longer has is stale, and a stale
    #    exception excuses a real check forever.
    for name in COVERAGE:
        if name not in steps:
            failures.append(
                f"scripts/check-gate-lockstep.py maps {name!r}, which is not a step in ci.yml"
            )

    # 4. Every CI_ONLY step is named verbatim in SKILL.md §13, and every §13
    #    entry names one — both directions, because each rots on its own.
    ci_only = sorted(n for n, t in COVERAGE.items() if t == CI_ONLY)
    listed = skill_ci_only()
    if not listed:
        failures.append("read no entries out of SKILL.md §13 — this check is blind")
    for name in ci_only:
        if name not in listed:
            failures.append(f"CI-only step {name!r} is not listed in SKILL.md §13")
    for name in listed:
        if name not in ci_only:
            failures.append(
                f"SKILL.md §13 lists {name!r}, which is not a CI-only step in ci.yml"
            )

    # 5. session-notes tells a fresh session how many gates a green local run
    #    did not cover. It said two; there were seven.
    notes = SESSION_NOTES.read_text()
    m = re.search(r"\*\*(\w+) gates? (?:still )?exists? only in CI\*\*", notes)
    if not m:
        failures.append(
            "docs/dev/session-notes.md no longer carries a sentence of the form "
            '"**N gates still exist only in CI**" — it is the count a fresh session reads'
        )
    else:
        words = {
            "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
            "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11,
            "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
            "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19,
            "twenty": 20,
        }
        token = m.group(1)
        # A numeral is as good as a word, and a word this map does not know is
        # reported as unreadable rather than silently counted as a mismatch —
        # the difference between "the note is wrong" and "this check cannot
        # read the note" is the whole point of the presence-vs-value split
        # `check-auth-posture.sh` had to be given.
        said = int(token) if token.isdigit() else words.get(token.lower())
        if said is None:
            failures.append(
                f"docs/dev/session-notes.md states the CI-only count as {token!r}, "
                "which this check cannot read as a number"
            )
        elif said != len(ci_only):
            failures.append(
                f"docs/dev/session-notes.md says {m.group(1)!r} gates exist only in CI; "
                f"there are {len(ci_only)}"
            )

    if failures:
        for f in failures:
            print(f"FAIL: {f}")
        return 1

    print(
        f"PASS: {len(steps)} ci.yml run-steps classified — "
        f"{len(ci_only)} CI-only, all named in SKILL.md §13 and counted in session-notes"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
