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

# RUNNABLE validate.sh gates that legitimately have no ci.yml step. Empty
# today, and that is the honest state rather than an oversight: every gate this
# file runs locally is also a CI step.
#
# It used to hold the two UMBRELLA skip labels (`6. edge functions`,
# `7-8. database`), which `validate.sh` prints instead of a family's individual
# gates when deno or a database is missing. Splitting `run` from `skip_gate`
# (Codex on PR #94, round two) made that unnecessary: a skip label is no longer
# a gate as far as this check is concerned, so there is nothing to excuse.
# Kept as the documented escape hatch, with its own stale check, so the day a
# genuinely local-only gate exists the decision is written here rather than
# discovered. Named, never pattern-matched — the `TEXT_RE_EXEMPTIONS` shape.
LOCAL_ONLY: set[str] = set()

# ci.yml step name -> SETUP, CI_ONLY, or the validate.sh gate label that runs
# the same check locally.
COVERAGE: dict[tuple[str, str], str] = {
    # ── frontend ──────────────────────────────────────────────────────────
    ("frontend", "Install"): SETUP,
    ("e2e-today", "Install"): SETUP,
    ("frontend", "Typecheck"): "1. typecheck",
    ("frontend", "Lint (warnings fail)"): "2. lint",
    ("frontend", "Unit tests"): "3. unit tests",
    ("frontend", "Build"): "4. build",
    ("frontend", "The built service worker is stamped, and precaches a usable shell"): CI_ONLY,
    ("frontend", "A production build without Supabase config is refused"): CI_ONLY,
    ("frontend", "Every test file is claimed by a vitest project"): CI_ONLY,
    ("frontend", "The deployed frontend sets its security headers"): CI_ONLY,
    ("frontend", "Deploy workflow gating"): "10c. workflow gating",
    ("frontend", "The three gate lists are in lockstep"): "10g. gate lockstep",
    ("frontend", "CLAUDE.md's counts match the tree"): "10d. status counters",
    ("frontend", "Secret-leak grep (validate gate 11)"): "11. no secret literals",
    ("frontend", "The build stamps the commit it was built from"): CI_ONLY,
    ("frontend", "version.json is excluded from the SPA rewrite"): CI_ONLY,
    ("frontend", "DEV fixtures absent from the production bundle"): CI_ONLY,
    ("frontend", "Every CSS token used is a token that exists"): "12. css tokens defined",
    ("frontend", "Behavioural tests still execute"): CI_ONLY,
    ("frontend", "Exactly one <main>, owned by AppMain"): CI_ONLY,
    # ── e2e ───────────────────────────────────────────────────────────────
    ("e2e-today", "Resolve the Playwright version"): SETUP,
    ("e2e-today", "Chromium browser"): SETUP,
    ("e2e-today", "Today composition (4 viewports)"): "5. e2e",
    ("e2e-today", "Today contrast (sampled from the artwork)"): "5. e2e",
    ("e2e-today", "Tint contrast (rendered component gallery)"): "5. e2e",
    ("e2e-today", "Today plate responsive candidates"): "5. e2e",
    ("e2e-today", "Calendar week geometry"): "5. e2e",
    ("e2e-today", "Every e2e spec is actually run by this workflow"): CI_ONLY,
    # ── edge functions ────────────────────────────────────────────────────
    ("edge-functions", "Typecheck entrypoints"): "6a. deno check",
    ("edge-functions", "Tests"): "6b. deno test",
    ("edge-functions", "Every 5xx throw carries its cause"): CI_ONLY,
    ("edge-functions", "No secret logging grep (phase 01 gate)"): CI_ONLY,
    # ── database ──────────────────────────────────────────────────────────
    ("database", "Reset — shim + migrations 0001..NNNN + seed"): "7. db reset",
    ("database", "Push endpoint allowlist — both implementations agree"): "8c. push endpoint parity",
    ("database", "Walk cost parity — TS leaf, fn_walk_cost and the snapshot trigger agree"): "8d. walk cost parity",
    ("database", "Would `supabase db push` apply this?"): "7b. db push check",
    ("database", "Smoke suite (credit engine + full spec-03 security matrix)"): "8. smoke.sql",
    ("database", "Materializer suite (idempotency, skips, no resurrection)"): "8. materializer.sql",
    ("database", "Concurrency suite (the row lock behind invariant 1)"): "8b. concurrency suite",
    ("database", "Invariant 1 — credit_balance written only by fn_ledger_apply"): CI_ONLY,
    ("database", "The nightly schedule is in a migration"): CI_ONLY,
    ("database", "Generated types match the schema"): "10b. generated types",
    ("database", "Spec 03's definer catalogue matches the migrations"): "10a. definer catalogue",
    ("database", "Spec 01's enum catalogue matches the migrations"): "10e. enum catalogue",
    ("database", "The catalogue generators' proof set holds"): "10f. catalogue generator proofs",
    # ── migrations ────────────────────────────────────────────────────────
    ("migrations-append-only", "No edits to migrations that already exist on the base branch"): "9. append-only migrations",
}


def ci_steps() -> tuple[list[tuple[str, str]], list[str], list[str]]:
    """The named `run:` steps in ci.yml as (job, name), the UNNAMED, the DUPLICATE.

    (job, name), not name — a display name does NOT identify a step, and this
    workflow already proves it: `Install` appears in both `frontend` and
    `e2e-today`. Keyed by name alone, a genuinely new check called `Tests` in
    the `database` job silently inherited `edge-functions`' mapping and the
    lockstep reported PASS having classified nothing (measured, Codex on
    PR #94: `PASS: 47 ci.yml run-steps classified`). Rejecting duplicate names
    outright was the other option offered and would be RED ON A HEALTHY TREE,
    since the two `Install` steps are both legitimate and both SETUP.

    That fix left the same hole one scope in, and the next round found it: two
    steps named `Tests` in the SAME job produce the same tuple, so the new one
    satisfied `s in COVERAGE`, satisfied the stale-map check, inherited
    `6b. deno test`, and the gate reported `PASS: 47` again (measured). There
    is no further discriminator worth having — a POSITIONAL one silently
    re-points at a different step the moment somebody inserts a step above it,
    which is the stale-exception shape this file guards against twice — so a
    duplicate tuple is REFUSED and the remedy is to rename one. Unlike a name
    reused across jobs, that is not red on a healthy tree: measured, this
    workflow has no duplicate (job, name) pair at all.

    A `uses:` step runs an action, not a check of ours, and has nothing to
    mirror. An unnamed `run:` step is a different matter: `- run: python3
    scripts/new-check.py` is valid YAML and a real check, and the first version
    of this filter dropped it — so it was classified by nobody, mirrored by
    nothing, and the lockstep reported success. The invariant is about CI
    CHECKS, not about checks whose author remembered a display name, so an
    unnamed one is returned as a location and fails by name.
    """
    workflow = yaml.safe_load(CI.read_text())
    names: list[tuple[str, str]] = []
    unnamed: list[str] = []
    seen: set[tuple[str, str]] = set()
    duplicate: list[str] = []
    for job_name, job in workflow["jobs"].items():
        for i, step in enumerate(job.get("steps", [])):
            if "run" not in step:
                continue
            if "name" not in step:
                unnamed.append(f"{job_name} step {i + 1}")
                continue
            key = (job_name, step["name"])
            if key in seen:
                duplicate.append(f"{job_name} / {step['name']}")
            else:
                seen.add(key)
                names.append(key)
    return names, unnamed, duplicate


def skill_ci_only() -> list[str]:
    """The steps listed in SKILL.md §13, read as ``- `job / exact name` ``."""
    text = SKILL.read_text()
    m = re.search(r"^## 13\..*?$(.*?)(?=^## |\Z)", text, re.M | re.S)
    if not m:
        return []
    return re.findall(r"^- `([^`]+)`", m.group(1), re.M)


# Bash's reserved words, from its own grammar. A command word can follow any of
# them as well as a separator, so `if run "13. x" cmd; then …` is an invocation
# and a line-anchored reader could not see it (Codex, PR #94). Enumerated from
# the specification rather than from the cases in front of me, which is what
# four consecutive rounds of "one more form" argued for.
SHELL_RESERVED = (
    "if", "then", "elif", "else", "fi", "while", "until", "for", "do", "done",
    "case", "esac", "select", "function", "in", "time", "coproc", "!", "{", "}",
)


def _subst_region(depth: int) -> str:
    """A command substitution in the SKELETON, from its opening `(` to the
    `_SUBST_CLOSE` that matches it.

    The lexer normalises all three spellings to the same pair — `$(`, `<(` and
    a backtick all reach the skeleton as `(`, and every closer as
    `_SUBST_CLOSE` — so one shape reads all of them.

    Balanced to a bounded depth because `re` has no recursion. Two is far past
    anything written here, and past it the region simply does not match, which
    loses the prefix rather than inventing a command: the direction this reader
    fails in everywhere else. A bare `(` is the LAST alternative so a nested
    SUBSHELL, which closes with `)` and not `_SUBST_CLOSE`, is still crossed
    (`MODE=$( (printf a) ) run "…"` runs the gate, measured), and `)` is an
    ordinary character inside the region because a `case` pattern's closer has
    no opener of its own (`MODE=$(case a in a) printf x;; esac) run "…"` runs
    it too, measured).
    """
    if depth == 0:
        return r'\([^(%s]*%s' % (_SUBST_CLOSE, _SUBST_CLOSE)
    return r'\((?:%s|[^(%s]|\()*%s' % (
        _subst_region(depth - 1),
        _SUBST_CLOSE,
        _SUBST_CLOSE,
    )


def _command(body: str) -> str:
    """`body` matched only where a COMMAND can start, captured as `cmd`.

    A command word begins at the start of the text, after a newline, after one
    of the shell separators `; & | ( ) { }`, or after a reserved word — and may
    be preceded by any number of ASSIGNMENT or REDIRECTION prefixes, which bash
    allows before the command word (`MODE=ci run "…"`, `>/dev/null run "…"`).
    Anything else — the middle of a word, an argument position, a variable's
    value — is not an invocation and must not be read as one.

    The prefix is outside the `cmd` group, so a caller reads the command and
    not the keyword in front of it. Getting that wrong made eighteen real gates
    read as unreadable on this rule's first run.
    """
    # `!` has a branch of its own below, because it may be written with no
    # space after it. `}` is excluded outright: it never precedes a command —
    # `{ :; } run "…" true` is a bash SYNTAX ERROR (measured), so a separator
    # always stands between a group's closer and whatever follows it.
    words = "|".join(
        re.escape(w) for w in SHELL_RESERVED if w not in ("!", "}")
    )
    # A reserved word itself begins at a command position, so the SAME set of
    # places must precede it — `cmd;if run "…"` and `(if run "…"` are ordinary
    # bash, and a rule that admitted a reserved word only after whitespace or a
    # newline read neither, in both directions: neither runnable nor unreadable
    # (measured, Codex on PR #94).
    #
    # But bash recognises a reserved word CONTEXTUALLY — only where a command
    # can start — so "preceded by whitespace" is not the same question, and
    # answering it that way let any reserved-word spelling in an ARGUMENT
    # restart command parsing: `echo if run "13. fake" true` runs only `echo`
    # (measured, and the same for `while`, `done` and `then`), while the reader
    # returned `13. fake` — a PHANTOM local gate, which satisfies a ci.yml
    # mapping and keeps the reverse check happy after the real gate has been
    # deleted (measured, Codex on PR #94).
    #
    # So a reserved word is anchored at a genuine separator, and a CHAIN of
    # them is allowed because a reserved word is itself a command position:
    # `if ! run "…"`, `cmd; then run "…"`. `!` takes the same place in the
    # chain rather than a lookbehind of its own, which is also the first thing
    # that pins it — the `(?<=\s!)` it replaces had no row in the matrix.
    #
    # A BRACE is a reserved word rather than a metacharacter, so it belongs in
    # the chain and not in this set. Matching the character itself said "a
    # command can start here" wherever one appeared, including in the middle
    # of an ordinary word: `echo x{ run "13. fake" true`, `echo x} run …`,
    # `echo a{b,c} run …` and `echo ${HOME} run …` all run only `echo`
    # (measured), while the reader returned the label as a runnable gate — a
    # PHANTOM local gate, which satisfies a ci.yml mapping and keeps the
    # reverse check happy after the real gate has been deleted (measured,
    # Codex on PR #94). In the chain a `{` has to stand alone at a command
    # position, which is exactly bash's own rule: `{run "…" true; }` is a
    # syntax error (measured).
    # The separators themselves are `_BOUNDARY_CHARS` below, enumerated by
    # `_find_commands` rather than written here as a lookbehind, so that the
    # match can be tried at each one independently.
    chain = r'(?:[ \t]*(?:(?:%s)[ \t]+|![ \t]*))*' % words
    # `VAR=value` and `>file` / `2>&1` / `<in`, repeated, with the spacing bash
    # allows. Nothing here is captured; the command word follows.
    #
    # The value is a shell WORD, not a run of non-blank characters: a quoted
    # section may contain the whitespace and separators a bare character may
    # not, so `MODE="ci mode" run "13. new check"` is one prefix and one
    # command. The first version stopped at the space inside the quotes, and
    # the `run` after it was then neither at a recognised command boundary nor
    # reported as unreadable — invisible in both directions, so a local gate
    # could lack a CI counterpart while lockstep reported success (measured,
    # Codex on PR #94).
    #
    # An unquoted BACKSLASH escapes the next character, so `MODE=ci\ mode run
    # "13. new check" true` is one prefix and one command to bash (measured),
    # and a bare branch that merely excludes whitespace stopped at the escaped
    # space — invisible in both directions again, the same defect one grammar
    # over from the comment stripper's, which learnt the same rule one round
    # earlier. The escape branch is FIRST and `\\` is excluded from the bare
    # branch, so the four branches stay disjoint by their first character and
    # the nesting still cannot backtrack pathologically. That ordering is a
    # BACKTRACKING property and not a matching one — measured: with the escape
    # branch last and `\\` left in the bare branch the engine backtracks into
    # it and every spelling still reads, so no matrix row can pin the order.
    # What the rows pin is that the branch exists at all.
    #
    # A word also spans a COMMAND SUBSTITUTION, whose contents are real shell
    # and may therefore hold the whitespace, `;`, `&` and `|` that end a bare
    # word: bash runs `run` for `MODE=$(printf ci) run "13. new check" true`,
    # and for the backtick and `<(…)` spellings (measured), while a branch
    # that stopped at the space inside one read none of them — invisible in
    # BOTH directions, so a local gate could lack a CI counterpart while
    # lockstep reported success (measured, Codex on PR #94). `${…}` and
    # `$((…))` already read, because the lexer MASKS their bodies; a
    # substitution's body must stay visible, since a gate inside one is real
    # (round 32), which is why this has to be a balanced scan rather than
    # another masked region.
    word = r"""(?:%s|\\[\s\S]|[^\s;&|'"\\]|'[^']*'|"(?:[^"\\]|\\.)*")*""" % _SUBST_REGION
    # An assignment word is `NAME=`, `NAME+=`, or either with an array
    # SUBSCRIPT: bash runs `run` for `MODE+=x run "…"`, `a[0]=1 run "…"` and
    # `a[1 + 2]=1 run "…"` (measured — the subscript forms also warn "not a
    # valid identifier" at runtime, and still execute the command), while a
    # grammar accepting only `NAME=` read none of them. `MODE+x=1 run "…"` and
    # `9MODE=1 run "…"` are NOT prefixes and bash runs no gate (measured), so
    # the `+` belongs to `+=` alone and the name may not start with a digit.
    #
    # The subscript stops at a NEWLINE, which bash's does not: a subscript runs
    # to its matching `]` wherever that is (`x[y run "…" true` with no `]` at
    # all is a syntax error, "unexpected EOF while looking for matching `]'",
    # measured). Widening it to match was tried and declined, because it buys
    # one shape and cannot close its mirror. `a[1 +`⏎`2]=1 run "…" true` runs
    # the gate and is then read — but `a[1 +`⏎`run "…" true`⏎`x]=2 :` runs
    # NOTHING, the gate being INSIDE the subscript, and is reported anyway,
    # because each boundary is tried independently and nothing here knows a
    # newline can sit inside a subscript. Both of those are the behaviour on
    # the previous head (measured, a miss and a phantom), and this round moves
    # neither: closing the phantom needs the lexer to track `[`, which appears
    # in globs and `[[ … ]]` tests, so the rule would be red on a healthy tree
    # far more often than the shape it guards against occurs.
    assign = r'[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]\n]*\])?\+?='
    prefixes = r'(?:[ \t]*(?:%s%s|[0-9]*[<>]{1,2}&?%s)[ \t]+)*' % (assign, word, word)
    return r'%s[ \t]*%s(?P<cmd>%s)' % (chain, prefixes, body)


# Every offset at which a command may begin, which is what `sep` used to say
# inside the pattern: the start of the text, after a newline, and after one of
# the separators `; & | ( )`. A brace is a reserved WORD and reaches the chain
# instead.
#
# Enumerated rather than matched because the match must be tried AT each one
# independently. `re.finditer` does not overlap, and a prefix that spans a
# substitution SWALLOWS whatever is inside it — so with the prefix grammar
# above, `MODE=$(run "13. inner" true) run "13. outer" true`, which bash runs
# BOTH of (measured), reported only the outer: the round-32 rule that a gate
# inside a substitution is real, undone by the fix for the prefix in front of
# it.
_BOUNDARY_CHARS = "\n;&|()"


def _find_commands(body: str, skel: str) -> list[re.Match]:
    """Every match of `body` at a command position in `skel`, in source order.

    ONE implementation, called by both readers, for the reason
    `shell_gate_labels` is one reader: a rule that only one of them enforces is
    a rule the other can contradict.

    Sorted by where the COMMAND word starts, not by the boundary a match was
    found from, so an outer command whose prefix spans an inner one still reads
    in the order a person does. Two boundaries can reach the same command word;
    it is reported once.
    """
    pattern = re.compile(_command(body))
    offsets = [0] + [i + 1 for i, ch in enumerate(skel) if ch in _BOUNDARY_CHARS]
    found: dict[int, re.Match] = {}
    for off in offsets:
        m = pattern.match(skel, off)
        if m is not None:
            found.setdefault(m.start("cmd"), m)
    return [found[k] for k in sorted(found)]


# Bash's METACHARACTERS, which are what terminate a word — read from the
# grammar rather than from the cases in front of me, and each measured: after
# any of these a `#` opens a comment, and after anything else it does not.
# `{` and `}` are reserved WORDS rather than metacharacters, so they are
# deliberately absent: `echo x}#y` is the single word `x}#y` (measured), and
# including them would blank a real gate on a line that mentions a brace.
_WORD_BREAK = " \t\n|&;()<>"


# What a masked quoted character becomes in the SKELETON. Any single character
# keeps the offsets (Python indexes code points), and this one can carry no
# meaning to any scan here: it is not a quote, not a metacharacter, not `#`.
_MASK = "\x01"


# What the CLOSING character of a command substitution becomes in the skeleton.
# `)` is a metacharacter and a command boundary — but not when it closes a
# substitution: bash runs only `echo` for `echo $(printf x) run "13. fake"
# true`, and the same for `$((…))` and `<(…)` (measured), while a reader that
# saw every `)` as a separator returned `13. fake` — a PHANTOM local gate, the
# quoted-span defect one construct over (measured, Codex on PR #94). A word
# also CONTINUES through such a closer (`echo $(printf a)#b` prints `a#b`,
# where `(printf b)#c` prints `b` — the closer of a SUBSHELL does end a word),
# so the `#` after one is literal and a gate later on that line survives.
#
# Distinct from `_MASK` only so the two reasons stay legible; both are inert to
# every scan here.
_SUBST_CLOSE = "\x02"


# Built once, after the marker it is written in terms of. Depth two: see
# `_subst_region`.
_SUBST_REGION = _subst_region(2)


# A bare word at the point a command can start, used only to recognise the
# reserved words `case` and `esac`. It must END at a metacharacter or the text,
# so `casex` and `case=1` are ordinary words; a quoted or escaped first
# character is handled by branches above this one and never reaches it.
# A brace does not end it, for the same reason it is not a word break above:
# `case{` is the ordinary word `case{` and not the reserved word `case` —
# measured, bash tries to run a command by that name — so reading one as
# reserved pushed a `case` marker that then stopped a substitution's closer
# being a boundary (`echo $(case{ ; :) run "1. x" true` runs only `echo`,
# while the reader reported the label: the same phantom one construct over).
_BARE_WORD = re.compile(r"([A-Za-z]+)(?=[\s;&|()<>]|$)")


def _heredoc_delimiter(text: str, i: int) -> tuple[str, bool, bool]:
    """The word after `<<`: its text, whether any of it was quoted, and
    whether a word was there at all.

    The last of those is not the same as a non-empty text. `cat <<""` is legal
    bash and a real heredoc whose terminator is an EMPTY LINE (measured), so
    queueing on the text alone skipped it and read its body as shell — a
    phantom, in the guard written against one. Only `<<` with no word at all
    queues nothing, and bash refuses that outright ("syntax error near
    unexpected token", measured for both spellings).

    Quoting ANY part of the delimiter suppresses expansion in the body, so
    `<<E\'O\'F` is the delimiter `EOF` with no expansion (measured) — the flag
    is about the body, not about the spelling. The word ends at whitespace or a
    metacharacter, which is why `cat <<EOF; run "…" true` records `EOF` and
    leaves the `;` to the caller.
    """
    out: list[str] = []
    quoted = False
    found = False
    while i < len(text):
        ch = text[i]
        if ch in " \t\n|&;()<>":
            break
        if ch == "'":
            # No escapes at all inside single quotes: `cat <<\'E\\OF\'` is
            # terminated by the literal `E\\OF` (measured).
            quoted = True
            found = True
            end = text.find(ch, i + 1)
            if end == -1:
                out.append(text[i + 1 :])
                i = len(text)
                break
            out.append(text[i + 1 : end])
            i = end + 1
            continue
        if ch == '"':
            # Bash's own rules inside double quotes, character by character. An
            # unconditional `find()` for the next raw quote closed the word at
            # an ESCAPED one: `cat <<"E\\"OF"` is the delimiter `E"OF`, and
            # bash resumes executing commands after a terminator line reading
            # `E"OF` (measured) — while the delimiter this derived ran on into
            # later lines, so the lexer masked the remainder of the file and
            # lost every gate after it, invisible in BOTH directions (measured,
            # Codex on PR #94).
            #
            # A backslash is special ONLY before `"`, `\\`, `$`, a backtick or a
            # newline; everywhere else it is literal — all six measured, and
            # both directions matter, since collapsing `\\n` to `n` would derive
            # a terminator that never arrives and mask the rest of the file
            # just the same. Before a newline it is a line continuation and
            # contributes nothing (`cat <<"EO\\<newline>F"` is `EOF`).
            quoted = True
            found = True
            i += 1
            while i < len(text):
                c = text[i]
                if c == '"':
                    i += 1
                    break
                if c == "\\" and i + 1 < len(text) and text[i + 1] in '"\\$`':
                    out.append(text[i + 1])
                    i += 2
                    continue
                if c == "\\" and i + 1 < len(text) and text[i + 1] == "\n":
                    i += 2
                    continue
                out.append(c)
                i += 1
            continue
        if ch == "\\" and i + 1 < len(text) and text[i + 1] == "\n":
            # A line CONTINUATION, not a quote: `cat <<\\<newline>EOF` is
            # `cat <<EOF` with an UNQUOTED delimiter and bash runs the gate
            # after the body (measured). It contributes nothing and does not
            # make the delimiter quoted. Unreachable from the joined text this
            # is usually given — no `\\<newline>` survives there — and
            # load-bearing for the RAW lex `_join_continuations` runs, which is
            # what decides where a quoted body is.
            i += 2
            continue
        if ch == "\\" and i + 1 < len(text):
            quoted = True
            found = True
            out.append(text[i + 1])
            i += 2
            continue
        out.append(ch)
        found = True
        i += 1
    return "".join(out), quoted, found


def _lex_shell(
    text: str, literal_heredoc: list[tuple[int, int]] | None = None
) -> tuple[str, str]:
    """Return (clean, skeleton): comments blanked, and quoted contents masked.

    Both are the SAME LENGTH as the input, so a span found in one reads back
    from the other. The command-position scans run on the SKELETON and their
    labels are read out of `clean` at the same span, because a separator
    inside a quoted word is data and not a command boundary — `echo
    'diagnostic; run "13. fake" true'` runs only `echo` (measured), while a
    scan over the raw text read `13. fake` as a runnable gate: a PHANTOM local
    gate, which satisfies a ci.yml mapping and lets quoted diagnostic text keep
    the reverse check happy after the real gate has been deleted (measured,
    Codex on PR #94). The quote DELIMITERS survive masking, so a gate's own
    label is still found by the same pattern and read back intact.

    A command-position reader that did not strip comments would read
    `# run "x"` as a gate — the mention-versus-use distinction this repository
    has paid for before. Lengths are preserved so every offset still lines up.

    `#` opens a comment only at the START OF A WORD. Stripping every unquoted
    occurrence was the same defect facing the other way: `MODE=ci#local run
    "13. new check" true` invokes `run` (measured), while this blanked the rest
    of the line, so the gate was in neither the runnable nor the unreadable set
    — invisible in both directions, and a local gate could then lack a CI
    counterpart while lockstep reported success (measured, Codex on PR #94).
    An ordinary word carrying a `#` anywhere earlier on the line did the same
    to every gate after it.

    A word begins at the start of input and after an unquoted metacharacter;
    it CONTINUES through a closing quote (`echo "a"#b` prints `a#b`) and
    through a backslash escape, so `\\#` is a literal and an escaped space does
    not open a new word (`echo \\ #x` prints ` #x`) — all measured against bash
    rather than reasoned about.
    """
    out = []
    skel = []
    # Spans of every here-document body whose delimiter was QUOTED, for
    # `_join_continuations`. `hd` is never suspended inside one — a quoted
    # delimiter suppresses expansion, so the `(` and backtick branches take
    # their literal paths — which is what makes one open and one close per
    # body enough.
    literal_start: int | None = None

    def masked(chunk: str) -> str:
        # A newline inside a quoted string is a literal newline to bash, and
        # the unreadable scan stops at one, so it is kept rather than masked —
        # the skeleton must not disagree with the text about where lines are.
        #
        # NO MATRIX ROW PINS THIS, and saying so is better than implying one
        # does: masking it changes no verdict I can construct. A command
        # boundary before a real gate is a newline OUTSIDE the quotes, which is
        # never masked either way, so the only behaviour that moves is a label
        # that itself spans lines — refused by name here, read as a multi-line
        # label if masked, and both end in a red naming it. Kept as the
        # conservative reading rather than because a sabotage demanded it.
        if (exp_depth or arith_depth) and hd is None:
            # Inside a parameter expansion nothing is ever read as a gate, so
            # line structure carries no meaning there and the newline is
            # masked with everything else — leaving it would make
            # `_command`'s `(?<=\n)` a boundary inside a word.
            return _MASK * len(chunk)
        return "".join("\n" if c == "\n" else _MASK for c in chunk)

    quote = None
    at_word_start = True
    # One entry per open construct: "subst" for a command, arithmetic or
    # process substitution (`$(`, `$((`, `<(`, `>(`), "paren" for a subshell
    # or a parenthesised case pattern, and "case" for a `case … esac` whose
    # pattern closers carry no `(` of their own.
    #
    # Only a substitution's CLOSER stops being a command boundary. A case
    # pattern's `)` must not consume the entry beneath it: inside a
    # substitution, `echo $(case a in a) run "1. real" true;; esac)` runs
    # `run` (measured) while a reader that popped there saw no command
    # position at all, and the substitution's own closer — now unpaired —
    # became a boundary, so `echo $(case a in a) :;; esac) run "1. fake" true`
    # reported a PHANTOM gate for a `run` bash passes to `echo` (both
    # measured, Codex on PR #94).
    parens: list[str] = []
    # `case` and `esac` are reserved words, so they count only AT a command
    # position: `echo $(echo case) run "…" true` runs no `run` (measured), and
    # a `case` read out of an argument would make the substitution's closer a
    # boundary and invent exactly the phantom above. This flag is used for
    # nothing else, so an imprecision in it can only add or drop a `case`
    # marker — it never moves the boundaries the gate reads.
    at_cmd = True
    # An unquoted backtick is the other spelling of `$( )`: what follows it is
    # a command position (`echo `run "13. x" y`` runs `run` — measured, and the
    # reader found NOTHING for it, invisible in both directions), and the word
    # continues through the closing one exactly as it does through `)`.
    in_backtick = False
    # A command substitution SUSPENDS a double-quoted word: bash evaluates
    # `$(…)` and `` `…` `` inside double quotes as CODE while the quote goes
    # on around them (measured — `result="$(run "13. hidden" true)"` executes
    # `run`, and so does `` result="`run …`" ``), so masking the whole quoted
    # region made a real local gate invisible in BOTH directions, neither
    # runnable nor unreadable, which is how one lacks a CI counterpart while
    # lockstep reports success (measured, Codex on PR #94). A SINGLE quote
    # suspends nothing: everything inside one is literal (measured).
    #
    # Two resume triggers, because the two spellings are tracked differently:
    # a `$(` lands on `parens`, so its quote resumes when that entry is popped;
    # a backtick only flips `in_backtick`, so its quote resumes when that does.
    dq_pending = False
    dq_resume_at: list[int] = []
    dq_resume_backtick = False
    # Inside a backtick substitution an ESCAPED backtick is not an escape at
    # all: it delimits a NESTED substitution, and bash requires that spelling
    # because a bare one would close the outer (measured — `` result="`echo
    # \`run '1. nested' true\``" `` executes `run`, and so does the same
    # nesting with no double quote around it). The generic escape branch
    # consumed both delimiters, so the nested command was masked as ordinary
    # text and the gate inside it was invisible in BOTH directions — neither
    # runnable nor unreadable, which is how one lacks a CI counterpart while
    # lockstep reports success (measured, Codex on PR #94).
    #
    # One level, which is the depth a person writes: a third needs `\\\``,
    # and a bare backtick while the nested region is open is degenerate. This
    # flag is only consulted where `in_backtick` already holds, so an escaped
    # backtick anywhere else stays the literal it is (measured, both spellings).
    nested_backtick = False
    # A PARAMETER EXPANSION is one word: bash does not invoke `run` for
    # `echo ${UNSET:-x; run "12. css tokens defined" true}` (measured), nor for
    # the same body carrying `|`, `&`, a newline, a bare `( … )`, a reserved
    # word or a nested `${ … }` — every separator inside one is part of the
    # word. The reader marked them as command boundaries and returned the
    # label: a PHANTOM local gate, which satisfies a ci.yml mapping and lets
    # the reverse check stay green after the real gate has been deleted
    # (thirteen spellings measured, Codex on PR #94).
    #
    # So the body is MASKED, exactly as a quoted one is — except that a real
    # `$( … )`, `` ` … ` `` or `<( … )` inside it genuinely runs (measured), so
    # it SUSPENDS the masking for its duration and the expansion resumes at the
    # closer: `${UNSET:-$(printf a); run "…" true}` runs nothing, while
    # `${UNSET:-$(echo x; run "…" true)}` runs `run` (both measured). Same
    # shape as the double-quote suspension above, and tracked the same way.
    #
    # Only `${` nests. A bare `{` inside an expansion does not: bash closes at
    # the FIRST unquoted `}`, so `echo ${UNSET:-{a,b}; run "…" true}` really
    # does run `run` (measured). An escaped `\${` is not an expansion either
    # (measured), which is what `escaped_dollar_at` is for, and a quoted or
    # escaped `}` does not close one (measured) — those reach the quote and
    # escape branches above this one.
    #
    # LIMIT, stated rather than chased: an UNTERMINATED `${` masks the rest of
    # the file, so every later gate disappears. Bash refuses such a script
    # outright, so it cannot be a healthy tree, and the loss is loud rather
    # than silent — the map still names the vanished gates, which this check
    # reports as `validate.sh` labels that no longer exist.
    exp_depth = 0
    # ARITHMETIC is not shell. `$((run + 1))` and `((run + 1))` expand to a
    # number and invoke no `run` (measured), so their contents are masked
    # exactly as a parameter expansion's are — this reported `run + 1))` as
    # an unreadable gate call at top level, inside a heredoc body and inside
    # an expansion alike: a gate RED ON A HEALTHY TREE, the worst shape this
    # log records (measured, Codex on PR #94, who named the heredoc; the
    # top-level spelling is the base case and was the same defect).
    #
    # A counter rather than a predicate over `parens`, so the backtick stack
    # can save and restore it: `$(( `run "…" true` ))` genuinely runs
    # (measured), and a backtick pushes nothing onto `parens`.
    arith_depth = 0
    # A HERE-DOCUMENT body is data, not shell: bash passes
    # `cat <<'EOF'\nrun "12. css tokens defined" true\nEOF` to `cat` and
    # invokes nothing (measured), while this reader carried on lexing the body
    # and returned the label — a PHANTOM local gate, which satisfies a ci.yml
    # mapping and lets the reverse check stay green after the real invocation
    # is removed (nine spellings measured, Codex on PR #94). `validate.sh`
    # HAS one, at gate 12, whose body is a Python program.
    #
    # `pending` is queued by the `<<` operator and consumed at the newline
    # ENDING that line, in order, because the rest of the line is still shell:
    # `cat <<EOF; run "…" true` runs `run` and `run "…" true <<EOF` is gate 12's
    # own shape (both measured). Each entry is (delimiter, strip-tabs, quoted).
    #
    # A QUOTED delimiter (`<<'EOF'`, `<<"EOF"`, `<<\EOF`, or any partly-quoted
    # spelling such as `<<E'O'F`) suppresses expansion, so the whole body is
    # literal. An UNQUOTED one expands, and a `$( … )` or `` ` … ` `` inside it
    # genuinely RUNS (measured) — so it SUSPENDS the masking exactly as one
    # inside a parameter expansion does, and the body resumes at the closer. A
    # terminator cannot appear inside an open substitution at all (measured:
    # bash refuses the script), so suspending the terminator scan with it is
    # not an approximation.
    #
    # LIMIT, the same one the parameter expansion states: an UNTERMINATED
    # heredoc masks the rest of the file. Bash refuses such a script, so it
    # cannot be a healthy tree, and the loss is loud — the map still names the
    # vanished gates, which this check reports as labels that no longer exist.
    # Each entry also records the NESTING LEVEL it was queued at, because a
    # heredoc starts its body at the first newline AT THAT LEVEL. Requiring the
    # top level instead was too strict in one direction and too loose in the
    # other: `cat <<EOF $(echo a` must not start its body at the newline inside
    # the substitution, while `echo $(cat <<'EOF'` must start it there — and
    # with the latter never starting, the body was read as shell and its `)`
    # popped the substitution's own entry, so the real closer became a command
    # boundary and the argument after it was reported as a gate (measured).
    pending_heredocs: list[tuple[str, bool, bool, int]] = []
    hd: tuple[str, bool, bool] | None = None
    exp_resume_at: list[tuple[int, int, tuple[str, bool, bool] | None]] = []
    exp_resume_backtick: list[tuple[int, tuple[str, bool, bool] | None]] = []
    escaped_dollar_at = -1
    i = 0
    while i < len(text):
        # A body line that IS the delimiter ends the body. Checked at a line
        # start only, because a terminator must stand alone on its line —
        # `  EOF` indented with spaces does not terminate a plain `<<`
        # (measured), while `<<-` strips leading TABS and only tabs.
        if literal_heredoc is not None:
            in_literal = hd is not None and hd[2]
            if in_literal and literal_start is None:
                literal_start = i
            elif not in_literal and literal_start is not None:
                literal_heredoc.append((literal_start, i))
                literal_start = None
        if hd is not None and (i == 0 or text[i - 1] == "\n"):
            eol = text.find("\n", i)
            eol = len(text) if eol == -1 else eol
            probe = text[i:eol]
            if hd[1]:
                probe = probe.lstrip("\t")
            if probe == hd[0]:
                out.append(text[i:eol])
                skel.append(_MASK * (eol - i))
                hd = None
                i = eol
                continue
        ch = text[i]
        # An ESCAPED `\$(` or ``\` `` is literal and opens nothing (measured),
        # and the backslash is consumed by the quote branch below before this
        # test ever sees the character after it.
        if quote == '"' and (text.startswith("$(", i) or ch == "`"):
            quote = None
            if ch == "`":
                dq_resume_backtick = True
            else:
                dq_pending = True
        if quote:
            out.append(ch)
            if ch == "\\" and quote == '"' and i + 1 < len(text):
                out.append(text[i + 1])
                skel.append(masked(text[i : i + 2]))
                i += 2
                continue
            if ch == quote:
                quote = None
                at_word_start = False
                skel.append(_MASK if (exp_depth or arith_depth) else ch)
            else:
                skel.append(masked(ch))
        elif ch == "\\" and in_backtick and text.startswith("\\`", i):
            # A nested substitution's delimiter — see `nested_backtick` above.
            # Opening carries the boundary a bare backtick spells; closing is
            # inert and the word runs on, exactly as the outer pair behaves.
            out.append(text[i : i + 2])
            skel.append(("\\" + _SUBST_CLOSE) if nested_backtick else "\\(")
            at_word_start = not nested_backtick
            if nested_backtick:
                exp_depth, arith_depth, hd = (
                    exp_resume_backtick.pop()
                    if exp_resume_backtick
                    else (0, 0, None)
                )
            else:
                exp_resume_backtick.append((exp_depth, arith_depth, hd))
                exp_depth = 0
                arith_depth = 0
                hd = None
            nested_backtick = not nested_backtick
            i += 2
            continue
        elif ch == "\\":
            # An unquoted backslash escapes the next character, whatever it is,
            # and the word continues through both.
            #
            # NO heredoc clause here, and that is measured rather than assumed:
            # one that kept the newline changed no verdict, because the
            # terminator scan reads line starts out of the TEXT and a masked
            # body can match nothing either way.
            #
            # A continuation never reaches this branch inside a heredoc body
            # anyway: `_join_continuations` removes it in an UNQUOTED body, as
            # bash does, and KEEPS it in a quoted one, where bash does too — so
            # `cat <<EOF` with `last \`⏎`EOF` leaves the heredoc unterminated
            # and this reader masks to EOF exactly as bash abandons it (both
            # measured, no later gate either way). An earlier version of this
            # comment claimed the reader terminated at the raw line instead;
            # that stopped being true when the join stopped inserting a space,
            # and it is the behaviour above that was measured.
            out.append(ch)
            if i + 1 < len(text):
                out.append(text[i + 1])
                # Inside an expansion the pair is data like everything else:
                # `${UNSET:-\; run "…" true}` runs nothing (measured), and an
                # unmasked `;` in the skeleton is a boundary to `_command`.
                # Outside one the pair is kept, so `\#` stays a literal.
                # No `arith_depth` clause: a backslash inside arithmetic is a
                # bash SYNTAX ERROR ("invalid arithmetic operator", measured,
                # and again before a digit), so the state cannot occur in a
                # healthy tree and a guard for it would be a rule with nothing
                # behind it — the same call the `#` branch below records.
                if exp_depth or hd is not None:
                    skel.append(_MASK * 2)
                else:
                    skel.append(text[i : i + 2])
                if text[i + 1] == "$":
                    # `\${` is a literal `$` and opens no expansion (measured).
                    escaped_dollar_at = i + 1
                i += 2
                at_word_start = False
                continue
            skel.append(ch)
            at_word_start = False
        elif ch in "'\"" and hd is None:
            quote = ch
            out.append(ch)
            # The DELIMITERS survive masking outside an expansion, which is
            # what lets one pattern find a gate's own quoted label; inside one
            # nothing is read, so they are masked with the rest of the body and
            # the invariant stays one rule rather than a list of exceptions.
            skel.append(_MASK if (exp_depth or arith_depth) else ch)
            at_word_start = False
        elif ch == "#" and at_word_start and hd is None:
            # No `exp_depth` clause: `at_word_start` is never true inside a
            # parameter expansion — the opening `{` clears it and every body
            # character keeps it clear — so a guard here would be a rule with
            # nothing behind it (measured: removing one left the whole matrix
            # green). The `hash-in-exp` row pins the behaviour.
            # To the end of the line, replaced by spaces.
            end = text.find("\n", i)
            end = len(text) if end == -1 else end
            out.append(" " * (end - i))
            skel.append(" " * (end - i))
            i = end
            continue
        elif ch == "(":
            # `$`, `<` or `>` immediately before it opens a substitution.
            # `\$(` cannot reach here as anything else: bash refuses it
            # outright ("syntax error near unexpected token `('", measured).
            # `escaped_dollar_at` matters here for the same reason it does at
            # `${`: inside an unquoted heredoc body `\$(run …)` is literal and
            # bash runs nothing (measured), while the raw character one back is
            # still a `$`. At top level bash refuses `\$(` outright ("syntax
            # error near unexpected token `('", measured), so reading it as no
            # substitution there costs nothing either.
            opens_subst = (
                i > 0 and text[i - 1] in "$<>" and escaped_dollar_at != i - 1
            )
            # `$((` is ARITHMETIC EXPANSION, not a command substitution: bash
            # expands `$((run + 1))` to a number and invokes no `run`
            # (measured). Suspending a mask for it therefore read the
            # expression as shell, and `shell_unreadable_calls` reported
            # `run + 1))` — a gate RED ON A HEALTHY TREE, the worst shape this
            # log records (measured, Codex on PR #94). The parameter-expansion
            # mask had the identical hole one construct over and it is closed
            # in the same expression, because two copies of this rule is what
            # keeps diverging here.
            #
            # Recognised by LOOKAHEAD, and the absence of a space is what makes
            # it an arithmetic expansion: `$( (run "…" true) )` is a command
            # substitution around a subshell and genuinely runs (measured), so
            # it must still suspend. `<((` is not arithmetic either, hence the
            # `$` rather than `opens_subst`.
            #
            # Nothing is pushed, so the matching `)`s pop nothing — and the
            # mask staying ON is exactly what keeps a genuine nested
            # substitution readable: `$(( $(run "…" true) + 1 ))` DOES invoke
            # `run` (measured, in a heredoc body and in an expansion alike),
            # and its own `$(` suspends as usual.
            # A DOUBLED parenthesis is ARITHMETIC: `$((1 << 2))` and
            # `((1 << 2))` are left shifts (measured), so this opens a masked
            # region rather than a command. The absence of a SPACE is what
            # makes it arithmetic — `$( (run "…" true) )` is a substitution
            # around a subshell and genuinely runs (measured), so it must
            # still open one.
            #
            # ONE recognition point, at the first half. Marking the second as
            # well is REDUNDANT rather than belt-and-braces: whichever
            # parenthesis opens the region masks the other, which falls
            # through to an inert `paren` inside it and balances on the way
            # out — 187 constructed inputs across eleven contexts, and either
            # clause alone gives the identical answer on every one, so no row
            # could pin the pair. The lookahead is kept because it recognises
            # the construct at its opening and works at offset 0.
            arith_open = text.startswith("((", i)
            if hd is not None and (hd[2] or not opens_subst or arith_open):
                # Literal: everything under a quoted delimiter, and a bare
                # `( … )` under an unquoted one (`cat <<EOF` with `(x)` in the
                # body runs nothing). Nothing pushed, so the matching `)` must
                # pop nothing either.
                out.append(ch)
                skel.append(_MASK)
                at_word_start = False
                at_cmd = False
                i += 1
                continue
            if exp_depth and (not opens_subst or arith_open):
                # `echo ${UNSET:-x ( run "…" true )}` runs nothing (measured),
                # and the matching `)` must not pop a construct this never
                # pushed, so both are ordinary masked characters. `arith_open`
                # for the reason above: `${UNSET:-$((run + 1))}` invokes
                # nothing (measured) and reported `run + 1))}"` before this.
                out.append(ch)
                skel.append(_MASK)
                at_word_start = False
                at_cmd = False
                i += 1
                continue
            # `arith` also keeps the `<<` branch below from reading a heredoc
            # out of a left shift — it would queue a delimiter that never
            # arrives and mask the rest of the file, losing every gate after it
            # silently.
            kind = "arith" if arith_open else ("subst" if opens_subst else "paren")
            parens.append(kind)
            # Always recorded, even at depth 0, so open and close stay
            # symmetric and restoring is a no-op where nothing was masked.
            exp_resume_at.append((len(parens) - 1, exp_depth, arith_depth, hd))
            if kind == "arith":
                # Opens a masked region and NO command position: only a genuine
                # substitution runs commands. The enclosing masks are left
                # alone, which is what keeps a nested `$(` live — `$(( $(run
                # "…" true) + 1 ))` really does invoke `run` (measured, at top
                # level, in a heredoc body and in an expansion alike).
                arith_depth += 1
            elif kind == "subst":
                exp_depth = 0
                arith_depth = 0
                hd = None
            if dq_pending:
                # The `$` one character back suspended a double quote; this is
                # the entry whose closer resumes it.
                dq_resume_at.append(len(parens) - 1)
                dq_pending = False
            out.append(ch)
            # A lone `(` INSIDE arithmetic is grouping — `$(( (1+2) * 3 ))` —
            # so it pushes like any other and is masked like everything else
            # here; one entry per character, so `))` needs no pair matching and
            # `$(( (1+2)))` stays balanced.
            inert = kind == "arith" or arith_depth > 0
            skel.append(_MASK if inert else ch)
            at_word_start = not inert
            at_cmd = not inert
        elif ch == ")":
            if hd is not None:
                # Nothing inside a heredoc body pushed, so nothing may pop.
                out.append(ch)
                skel.append(_MASK)
                at_word_start = False
                at_cmd = False
                i += 1
                continue
            if exp_depth:
                # Nothing inside an expansion pushed, so nothing may pop.
                out.append(ch)
                skel.append(_MASK)
                at_word_start = False
                at_cmd = False
                i += 1
                continue
            if parens and parens[-1] == "case":
                # A case pattern's closer: a real command position (`case a in
                # a) run "…" x;; esac` runs `run`, measured) that closes no
                # `(`, so the construct beneath it stays open.
                closed = "case"
            else:
                closed = parens.pop() if parens else None
            substitution = closed == "subst"
            out.append(ch)
            # An arithmetic closer is part of the operator, not a boundary, and
            # opens no command position either: `echo $((1+1)) run "…" true`
            # passes `run` to `echo` (measured). `arith_depth` itself is
            # restored by the resume loop below, which every push records an
            # entry for.
            inert = closed == "arith" or arith_depth > 0
            skel.append(
                _SUBST_CLOSE if substitution else (_MASK if inert else ch)
            )
            at_word_start = not substitution and not inert
            at_cmd = not substitution and not inert
        elif ch == "`" and hd is not None and hd[2]:
            # No expansion under a quoted delimiter, so a backtick is data.
            out.append(ch)
            skel.append(_MASK)
            at_word_start = False
            at_cmd = False
        elif ch == "`":
            out.append(ch)
            # Opening: a command starts after it, so the skeleton carries the
            # boundary `(` already spells. Closing: inert, and the word runs on.
            skel.append(_SUBST_CLOSE if in_backtick else "(")
            at_word_start = not in_backtick
            if in_backtick:
                exp_depth, arith_depth, hd = (
                    exp_resume_backtick.pop()
                    if exp_resume_backtick
                    else (0, 0, None)
                )
            else:
                exp_resume_backtick.append((exp_depth, arith_depth, hd))
                exp_depth = 0
                arith_depth = 0
                hd = None
            in_backtick = not in_backtick
        elif (
            ch == "<"
            and text.startswith("<<", i)
            and hd is None
            and exp_depth == 0
            and "arith" not in parens
        ):
            # The heredoc OPERATOR. A doubled parenthesis is arithmetic, so
            # `<<` inside one is a left shift and queues nothing. The delimiter
            # is read for the record only; the loop carries on from just after
            # the operator so the word itself — and its quotes — lex exactly as
            # they did before.
            if text.startswith("<<<", i):
                # A here-STRING takes no body. All THREE characters are
                # consumed together, because merely declining to queue one here
                # let the scan re-enter at the second `<`, read `<<` out of the
                # middle of the operator and queue a heredoc whose delimiter was
                # the here-string's own word — which masked the rest of the file
                # and lost every gate after it (measured, found by a sabotage
                # that stayed green).
                out.append(text[i : i + 3])
                skel.append(text[i : i + 3])
                at_word_start = True
                i += 3
                continue
            j = i + 2
            strip = False
            if j < len(text) and text[j] == "-":
                strip = True
                j += 1
            k = j
            while k < len(text) and text[k] in " \t":
                k += 1
            delim, delim_quoted, delim_found = _heredoc_delimiter(text, k)
            if delim_found:
                level = len(parens) + in_backtick + nested_backtick
                pending_heredocs.append((delim, strip, delim_quoted, level))
            out.append(text[i:j])
            skel.append(text[i:j])
            at_word_start = True
            i = j
            continue
        elif ch in "{}" and hd is not None:
            # An expansion inside a heredoc body cannot run a command, and the
            # body is masked either way, so a brace is data like everything
            # else — no nesting to track.
            out.append(ch)
            skel.append(_MASK)
            at_word_start = False
            at_cmd = False
        # No `arith_depth` clause: a BARE brace inside arithmetic is a bash
        # syntax error ("operand expected", measured, and "invalid arithmetic
        # operator" for a brace token), while `${x}` inside one is masked by
        # the `$`-prefixed disjunct below whatever the arithmetic depth is — so
        # a guard here would be a rule with nothing behind it (measured:
        # removing one left every row and every invariant green).
        elif ch in "{}" and (
            exp_depth
            or (ch == "{" and i > 0 and text[i - 1] == "$" and escaped_dollar_at != i - 1)
        ):
            if ch == "{" and i > 0 and text[i - 1] == "$" and escaped_dollar_at != i - 1:
                exp_depth += 1
            elif ch == "}" and exp_depth:
                exp_depth -= 1
            out.append(ch)
            skel.append(_MASK)
            # A closing `}` opens no command position: `echo ${UNSET:-x}run …`
            # is one word and `echo ${#HOME} run …` passes `run` to `echo`
            # (both measured); a separator AFTER the expansion is real again
            # (`x=${UNSET:-a; b}; run "…" true` runs `run`, measured).
            at_word_start = False
            at_cmd = False
        elif ch in "{}":
            # A brace is a RESERVED WORD, not a metacharacter: it counts only
            # where it stands alone at a command position, so `echo x{ …` and
            # `echo ${HOME} …` carry no boundary (measured). Even standing
            # alone only `{` opens a command position — `{ :; } run` is a
            # syntax error (measured), so something else always separates a
            # group's closer from the next command.
            #
            # This flag's only consumer is the `case` marker, so an imprecision
            # here can add or drop one; the boundaries themselves are decided
            # by `_command`, which carries the same rule in its chain.
            opens = (
                ch == "{"
                and at_word_start
                and at_cmd
                and (i + 1 >= len(text) or text[i + 1] in _WORD_BREAK)
            )
            out.append(ch)
            skel.append(ch)
            at_word_start = opens
            at_cmd = opens
        elif exp_depth or arith_depth or hd is not None:
            # Data: a separator, a newline, a reserved word, a `#` — none of
            # them is a command boundary inside a parameter expansion
            # (measured). The newline is masked too, unlike the one inside a
            # quoted string that `masked()` keeps: nothing here is ever read as
            # a gate, so line structure carries no meaning, and leaving it
            # would make `_command`'s `(?<=\n)` a boundary — the phantom.
            out.append(ch)
            # A heredoc body keeps its newlines, exactly as a quoted string
            # does; an expansion is one word and masks them.
            #
            # NO ROW PINS THIS, and saying so is better than implying one does
            # — measured, by masking them: every row stayed green. The
            # terminator scan reads line starts out of the TEXT rather than the
            # skeleton, and the terminator's own newline is emitted after the
            # body has ended, so the only thing that moves is how far an
            # unreadable-call capture runs before it stops — a failure message,
            # not a verdict. Kept as the conservative reading, which is also
            # what stops the skeleton disagreeing with the text about where the
            # lines are.
            # ARITHMETIC masks them too, and that half IS pinned: a newline
            # inside one is legal bash (`echo $(( 1 +\nrun ))` prints 2 and
            # invokes nothing, measured), so leaving it would put the variable
            # `run` at a command position — the phantom this whole branch is
            # about.
            skel.append(
                "\n"
                if ch == "\n" and exp_depth == 0 and arith_depth == 0
                else _MASK
            )
            at_word_start = False
            at_cmd = False
        else:
            if at_word_start and at_cmd and not ch.isspace():
                # The word about to start decides whether the NEXT one is also
                # at a command position. Whitespace is still IN FRONT of that
                # word — evaluating it would find no bare word and clear the
                # flag before the word itself was ever looked at. Only a bare word can be reserved: a
                # quoted `"case"` is not (bash refuses it as one), and neither
                # branch above reaches here.
                word = _BARE_WORD.match(text, i)
                name = word.group(1) if word else ""
                at_cmd = name in SHELL_RESERVED
                if name == "case":
                    parens.append("case")
                elif name == "esac" and "case" in parens:
                    # Back to and including the nearest `case`; a well-formed
                    # script leaves nothing above it.
                    del parens[len(parens) - 1 - parens[::-1].index("case"):]
            out.append(ch)
            skel.append(ch)
            at_word_start = ch in _WORD_BREAK
            if ch in ";&|\n":
                at_cmd = True
            if (
                ch == "\n"
                and hd is None
                and pending_heredocs
                and pending_heredocs[0][3] == len(parens) + in_backtick + nested_backtick
            ):
                # The body starts on the line AFTER the operator, and several
                # queued on one line are consumed in order (measured). A queue
                # entry left behind by a substitution that has since closed can
                # never match again, which is the conservative direction: it
                # masks nothing rather than masking the wrong lines.
                hd = pending_heredocs.pop(0)[:3]
        # The substitution that suspended a double-quoted word has closed, so
        # the quote resumes for the rest of it. Checked after every branch
        # rather than inside the `)` one, because `esac` can shrink the stack
        # too; `<=` for the same reason.
        # The substitution that suspended a parameter expansion has closed,
        # so its body is data again. Same trigger as the double quote above,
        # and for the same reason `esac` can shrink the stack too.
        while exp_resume_at and len(parens) <= exp_resume_at[-1][0]:
            _, exp_depth, arith_depth, hd = exp_resume_at.pop()
        while dq_resume_at and len(parens) <= dq_resume_at[-1]:
            dq_resume_at.pop()
            quote = '"'
        if dq_resume_backtick and not in_backtick:
            dq_resume_backtick = False
            quote = '"'
        i += 1
    if literal_heredoc is not None and literal_start is not None:
        literal_heredoc.append((literal_start, len(text)))
    clean, skeleton = "".join(out), "".join(skel)
    assert len(clean) == len(text) and len(skeleton) == len(text)
    return clean, skeleton


def _join_continuations(source: str) -> str:
    r"""Remove every unescaped line continuation, as bash does — except inside
    a here-document body whose delimiter was QUOTED, where bash keeps it.

    ONE definition, called by both readers, which duplicated the substitution
    and could therefore disagree about what a line is.

    It removes the pair and contributes NOTHING. It used to leave a SPACE and
    to swallow the next line's indent, and both were wrong: bash JOINS the two
    halves (`ec\<newline>ho hi` runs `echo hi`, measured) and does not consume
    the following whitespace.

    A backslash at end of line is a continuation only when it is not itself
    escaped: `echo a\\` prints `a\` and the NEXT line runs (measured), so the
    run of backslashes is counted and an odd one leaves the newline standing.

    QUOTED-delimiter bodies are the one context where bash keeps the pair, and
    applying the substitution there was a real loss rather than a cosmetic one:
    a body line ending in `\` immediately before the terminator was joined to
    it, so `last \`⏎`EOF` became `last EOF`, the terminator was never found,
    and the lexer masked the remainder of the file — every later gate gone,
    invisible in BOTH directions (measured against bash for `<<'EOF'` and
    `<<"EOF"`, Codex on PR #94). An UNQUOTED body is the opposite: there the
    pair IS a continuation (`cat <<EOF` with `body \`⏎`more` prints one line,
    measured), so joining it matches bash, and when that lands on the
    terminator bash leaves the heredoc unterminated and runs no later gate —
    which is exactly what this reader then reports.

    The spans come from lexing the RAW text, because that is the only reader
    here that knows what a heredoc is; duplicating the rule in a second scanner
    is the divergence this file keeps paying for. Stated limit: a `<<` split
    by a continuation (`<\`⏎`<EOF`) is one operator to bash and two characters
    to that lex, so its body is not recognised — no migration or script in this
    tree writes one, and the failure direction is the safe one, since an
    unrecognised body is joined exactly as today.

    Still applied inside single quotes, where bash also keeps the pair. That
    changes DATA and never structure — the removal adds and removes no quote
    character, so nothing can become a command or stop being one, and unlike a
    heredoc a quoted string carries no line-structural terminator.
    """
    literal: list[tuple[int, int]] = []
    _lex_shell(source, literal_heredoc=literal)

    def inside(pos: int) -> bool:
        return any(start <= pos < end for start, end in literal)

    out: list[str] = []
    last = 0
    for m in re.finditer(r"(\\*)\\\n", source):
        if len(m.group(1)) % 2:
            # The backslash before the newline is itself escaped.
            continue
        if inside(m.end() - 2):
            continue
        out.append(source[last : m.end() - 2])
        last = m.end()
    out.append(source[last:])
    return "".join(out)


# A TAB separates a command from its argument exactly as a space does —
# `run\t"1. x" true` invokes the gate (measured) — while this matched only
# spaces, so the label reader missed it and the unreadable reader then
# refused a real gate BY NAME: a gate red on a healthy tree. A newline is
# not a separator here, since it ends the command.
_QUOTED_LABEL = r'%s[ \t]+(?P<q>["\'])(?P<label>.+?)(?P=q)'



def shell_gate_labels(source: str, word: str) -> list[str]:
    """Every `word "label"` invoked at a command position in `source`.

    ONE reader, called by `validate_labels` and driven by `_SPELLINGS`, so the
    matrix proves the rules the real run uses. It was two: the matrix drove the
    pattern directly while `validate_labels` did its own scanning, and a
    sabotage of the real one therefore stayed GREEN — a rule with nothing
    behind it, in the commit that added the rule.

    Matched on the SKELETON so a separator inside a quoted word cannot look
    like a command boundary, then read out of the clean text at the same span
    so the label is the real text (the quote delimiters survive masking, which
    is what lets one pattern do both).
    """
    code, skel = _lex_shell(_join_continuations(source))
    return [
        code[m.start("label") : m.end("label")]
        for m in _find_commands(_QUOTED_LABEL % word, skel)
    ]


def shell_unreadable_calls(source: str) -> list[str]:
    """Every `run`/`skip_gate` invocation in `source` whose label cannot be read.

    A parser that sees nothing reports agreement, so an invocation this cannot
    read is REFUSED BY NAME rather than skipped — the rule
    `gen-enum-catalog.py` needed forty-three rounds to arrive at, in a third
    language. A DEFINITION (`run() {`) is not an invocation and is excluded by
    the `(`, which the first version of this went red on.

    On the SKELETON for the same reason the label reader is, and in the
    direction that matters more here: `echo 'note; run'` reported `run'` as an
    unreadable gate off the raw text (measured) — a gate RED ON A HEALTHY TREE,
    the worst shape this log records.
    """
    code, skel = _lex_shell(_join_continuations(source))
    out = []
    # The command word must be EXACTLY the gate's name. Bash splits a word at
    # metacharacters and nowhere else, so `run=1`, `run+=b`, `run[0]=1` and
    # `run]=2` are each ONE word that is not `run`: the first three invoke
    # nothing at all and the last invokes a command by that name, which is not
    # this gate helper (all measured). Reading them as invocations was a gate
    # RED ON A HEALTHY TREE, the worst shape this log records.
    #
    # One rule, and it subsumes the separate assignment test it replaces —
    # which asked the narrower question "is this an assignment?" and therefore
    # missed `run]=2`, the word bash produces when an array subscript spans
    # lines (`a[1 +`⏎`run]=2`, measured: legal, and no `run` is invoked). The
    # boundary is the ABSENCE of a separator, measured in both directions:
    # `run =1` and `run == 1` really do invoke `run` with a strange argument
    # and must stay refused.
    #
    # A `(` is excluded by the pattern below rather than here, because
    # `run() {` is a DEFINITION and not an invocation at all.
    for m in _find_commands(
        r'(?:run|skip_gate)(?=[\s;&|)<>]|$)[^\n;&|]*', skel
    ):
        call = code[m.start("cmd") : m.end("cmd")].strip()
        if not re.match(r'^(?:run|skip_gate)[ \t]+(["\']).+?\1', call):
            out.append(call)
    return out


def validate_labels() -> tuple[set[str], set[str], list[str], list[str]]:
    """Gate labels in validate.sh: RUNNABLE, skipped, DUPLICATE, UNREADABLE.

    Two sets, not one, and the split is the fix for a real hole: several gates
    have both a `run` and a `skip_gate` fallback (4, 5, 8c, 8d, 10b), so a
    combined set let the `skip_gate` alone satisfy a mapped ci.yml step.
    Commenting out `run "8c. push endpoint parity"` while leaving its no-deno
    `skip_gate` made this check report PASS on a `validate.sh` that could no
    longer run 8c at all — measured. A mapped step has to be backed by a
    command that can actually execute.

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
    #
    # OCCURRENCES first, then the set. A label is a gate's identity here, so a
    # second `run` accidentally reusing one is the `ci_steps()` duplicate a
    # file over: the existing COVERAGE entry satisfies the label and the new
    # command is mirrored by nobody, while the check reports lockstep
    # (measured, Codex on PR #94 — a planted second `run "12. css tokens
    # defined"` passed). Measured green on the tree: no label is declared
    # twice. The remedy is to rename one, as it is for a duplicate step name.
    #
    # BOTH shell quote styles, with a backreference so `run "x'` matches
    # nothing. Nothing in this repository enforces a quote style — no shfmt,
    # no shellcheck rule — so `run '13. new check'` is valid shell and was
    # invisible here: the reverse check then never required a CI counterpart
    # for a real local gate, and reported lockstep (measured, Codex on
    # PR #94). Same defect as `gen-enum-catalog.py`'s round twenty-five, in a
    # different language.
    #
    # Line continuations are JOINED first. `run \` + newline + `"13. new
    # check" …` is one command to the shell and was invisible to a
    # same-line regex, so a real local gate could be absent from CI while
    # the reverse check reported lockstep (measured, Codex on PR #94).
    found = shell_gate_labels(text, "run")
    duplicate = sorted({lbl for lbl in found if found.count(lbl) > 1})
    runnable = set(found)
    skipped = set(shell_gate_labels(text, "skip_gate"))

    unreadable = shell_unreadable_calls(text)
    # `finditer`, not `search`. There is one such loop today; a `search` would
    # expand only the FIRST, and a ci.yml step mapped to a label from a second
    # one would then be reported as claiming a gate validate.sh does not
    # declare — a legible red, but on a healthy tree, and this repository's log
    # calls that the worst shape available. One loop or five costs the same.
    for m in re.finditer(
        r'for (\w+) in (\S+); do\n\s*run "([^"$]*)\$\(basename "\$\1"\)"', text
    ):
        prefix = m.group(3)
        runnable.discard(prefix + '$(basename ')
        for f in sorted(ROOT.glob(m.group(2))):
            runnable.add(prefix + f.name)
    return runnable, skipped, duplicate, unreadable


# The command-position reader's SPELLING MATRIX, asserted on every run.
#
# `validate_labels()` reads one real file, so every rule about boundaries,
# prefixes and quoting was proven under sabotage and by nothing that runs
# again afterwards — the "rule written down and connected to nothing" shape
# this repository records more than any other. Five consecutive Codex rounds
# landed in this reader; each is a row here now.
#
# Both directions, because a reader that matched everything would satisfy the
# left column and a reader that matched nothing would satisfy the right.
#
# When `validate.sh --list-gates` lands (backlog item 1) the shell parses the
# shell and this reader goes away — this matrix becomes the test of the
# lister's output rather than being deleted.
_SPELLINGS: tuple[tuple[str, list[str]], ...] = (
    ('run "1. plain" cmd', ["1. plain"]),
    ("run '1. single' cmd", ["1. single"]),
    ('  run "1. indented" cmd', ["1. indented"]),
    ('if run "1. control" cmd; then :; fi', ["1. control"]),
    ('cmd; run "1. after-separator" x', ["1. after-separator"]),
    # A reserved word begins at a command position too, so every separator that
    # can precede a command can precede one of these.
    ('cmd;if run "1. separator-then-reserved" true; then :; fi', ["1. separator-then-reserved"]),
    ('cmd&&if run "1. and-then-reserved" true; then :; fi', ["1. and-then-reserved"]),
    ('(if run "1. paren-then-reserved" true; then :; fi)', ["1. paren-then-reserved"]),
    # A `{` is a reserved word, so a GROUP opens a command position wherever
    # one may start — and it chains with the others exactly as they chain with
    # each other. All seven measured against bash.
    ('{ run "1. group" true; }', ["1. group"]),
    ('echo a; { run "1. group-after-separator" true; }',
     ["1. group-after-separator"]),
    ('f() { run "1. group-in-function" true; }; f', ["1. group-in-function"]),
    ('echo a | { run "1. group-after-pipe" true; }', ["1. group-after-pipe"]),
    ('true && { run "1. group-after-and" true; }', ["1. group-after-and"]),
    ('{ ! run "1. group-then-bang" true; }', ["1. group-then-bang"]),
    ('{ if run "1. group-then-reserved" true; then :; fi; }',
     ["1. group-then-reserved"]),
    # A command position opens inside every substitution, and after a bare `(`
    # and a case pattern's `)` — all four measured, and all four must survive
    # the rule that stops a substitution's CLOSER being one.
    ('(run "1. subshell" x)', ["1. subshell"]),
    ('echo $(run "1. inside-subst" x)', ["1. inside-subst"]),
    ('case a in a) run "1. case-pattern" x;; esac', ["1. case-pattern"]),
    ('echo `run "1. backtick" x`', ["1. backtick"]),
    # A command substitution SUSPENDS a double-quoted word: its contents are
    # CODE, so a gate inside one runs (measured for all four) while a reader
    # that masked the whole quoted region saw nothing — invisible in BOTH
    # directions, so the gate could be dropped from CI with lockstep still
    # reporting success (Codex, PR #94).
    ('result="$(run \'1. dq-subst\' true)"', ["1. dq-subst"]),
    ('result="`run \'1. dq-backtick\' true`"', ["1. dq-backtick"]),
    ('echo "$(run \'1. arg-dq-subst\' true)"', ["1. arg-dq-subst"]),
    ('MODE="$(printf a; printf b)" run \'1. prefix-dq-subst\' true',
     ["1. prefix-dq-subst"]),
    # Inside a backtick substitution an ESCAPED backtick opens a NESTED one —
    # the only spelling bash accepts there — so the command inside it runs
    # (measured, with and without the double quote the reviewer's case had).
    ('result="`echo \\`run \'1. nested-bt\' true\\``"', ["1. nested-bt"]),
    ('result=`echo \\`run \'1. bare-nested-bt\' true\\``', ["1. bare-nested-bt"]),
    # A case pattern's `)` closes no `(`, so a `case` inside a substitution
    # must not consume it: bash runs `run` here (measured) where a reader that
    # popped saw no command position at all.
    ('echo $(case a in a) run "1. case-in-subst" true;; esac)',
     ["1. case-in-subst"]),
    # …and the constructs the `case` rule must not break, all measured.
    ('case a in (a|b) run "1. paren-pattern" x;; esac', ["1. paren-pattern"]),
    ('case a in a) case b in b) run "1. nested-case" x;; esac;; esac',
     ["1. nested-case"]),
    ('case a in a) (run "1. subshell-in-case" x);; esac',
     ["1. subshell-in-case"]),
    # SECOND pattern of the same `case`: one marker, two closers, so a rule
    # that merely popped the marker would pop the substitution here instead
    # (found by a sabotage that stayed green against the rows above).
    ('echo $(case b in a) :;; b) run "1. second-pattern" true;; esac)',
     ["1. second-pattern"]),
    # `!` is a reserved word too and sits in the same chain. Nothing pinned the
    # lookbehind this replaced, so these are the first rows it has had.
    ('if ! run "1. negated" x; then :; fi', ["1. negated"]),
    ('! run "1. bang-first" x', ["1. bang-first"]),
    ('MODE=ci run "1. assignment" x', ["1. assignment"]),
    # A quoted assignment value holds the whitespace a bare word may not. The
    # reader stopped at the space and the `run` after it was invisible in both
    # directions — neither runnable nor unreadable (Codex, PR #94).
    ('MODE="ci mode" run "1. quoted-assignment" x', ["1. quoted-assignment"]),
    ("MODE='ci mode' run \"1. sq-assignment\" x", ["1. sq-assignment"]),
    ('MODE=a"b c"d run "1. mixed-word" x', ["1. mixed-word"]),
    ('A=1 B="x y" run "1. two-prefixes" x', ["1. two-prefixes"]),
    ('>"my file" run "1. redirect" x', ["1. redirect"]),
    # An unquoted backslash escapes the next character, so each of these is
    # one prefix and one command to bash (measured). The bare branch stopped
    # at the escaped character and the gate saw nothing (Codex, PR #94).
    ('MODE=ci\\ mode run "1. escaped-space-prefix" x', ["1. escaped-space-prefix"]),
    ('MODE=a\\;b run "1. escaped-separator-prefix" x', ["1. escaped-separator-prefix"]),
    ('>my\\ file run "1. escaped-redirect-target" x', ["1. escaped-redirect-target"]),
    # Ties the comment stripper's backslash rule to this grammar, and is red
    # under a sabotage of EITHER: the escaped space keeps the `#` mid-word so
    # the stripper must not blank the line, and the word must carry both.
    ('MODE=a\\ #b run "1. escaped-space-then-hash" x', ["1. escaped-space-then-hash"]),
    ('run \\\n  "1. continuation" x', ["1. continuation"]),
    # `#` opens a comment only at the START OF A WORD. Stripping every
    # unquoted one blanked the rest of the line, so a gate after an ordinary
    # word carrying a `#` was invisible in both directions (Codex, PR #94).
    ('MODE=ci#local run "1. hash-in-prefix" x', ["1. hash-in-prefix"]),
    ('echo a#b; run "1. hash-in-word" x', ["1. hash-in-word"]),
    ('echo \\#lit; run "1. escaped-hash" x', ["1. escaped-hash"]),
    ('echo "a"#b; run "1. gate-after-quoted-hash" x', ["1. gate-after-quoted-hash"]),
    # An ESCAPED space does not open a new word, so the `#` after it is
    # literal and the gate behind it survives (`echo \\ #x` prints ` #x` —
    # measured). Without the backslash rule the space opens a word, the `#`
    # opens a comment and the gate after the `;` disappears.
    ('echo \\ #x; run "1. escaped-space" y', ["1. escaped-space"]),
    # `}` is a reserved WORD and not a metacharacter, so it does not end a
    # word and the `#` after it is literal (`echo x}#y; run "L" z` invokes
    # `run` — measured). Putting braces in the break set would blank the gate.
    ('echo x}#y; run "1. brace-in-word" z', ["1. brace-in-word"]),
    # A separator inside a QUOTED word is data, not a command boundary, so the
    # label still reads back intact through the mask (read off the skeleton it
    # would come back as mask characters).
    ('run "1. label with ; and # inside" x', ["1. label with ; and # inside"]),
    # NOT invocations: a comment, an argument, and a definition.
    ('# run "1. commented" x', []),
    # `echo` is the only command here — bash runs nothing else (measured).
    ("echo 'diagnostic; run \"1. phantom\" true'", []),
    # A quoted string may span lines, and only the `echo` and the gate on the
    # NEXT line run (measured). The gate inside the quotes must stay invisible
    # while the real one after it is still found.
    ('echo \'a\nrun "1. inside-multiline" x\'\nrun "1. after-multiline" true',
     ["1. after-multiline"]),
    ('echo "double; run \'1. phantom-dq\' true"', []),
    ('echo x;#run "1. comment-after-separator" x', []),
    # The FIRST of these is what makes comment stripping LOAD-BEARING rather
    # than decorative: a bare space is not a command position, so `# run "x"`
    # is refused by the boundary alone — but a `;` INSIDE the comment text is
    # one, and without stripping the prose would be read as a gate. Found by a
    # sabotage that stayed green.
    ('# cmd; run "1. separator-inside-comment" x', []),
    # The second no longer distinguishes, and saying so beats implying it
    # does: it was red under the same sabotage until a reserved word had to be
    # at a command position itself, and `# if …` is now refused by the
    # boundary whether or not the comment is stripped. Kept because it is
    # still a case a reader expects to see, not as evidence for the stripper.
    ('# if run "1. reserved-inside-comment" x', []),
    # A word CONTINUES through a closing quote, so this `run` is an argument
    # of `echo` and not a command (measured against bash).
    ('echo "a"#b run "1. hash-after-quote" x', []),
    ('npm --prefix app run lint', []),
    # A `)` that CLOSES A SUBSTITUTION is not a command boundary: bash runs
    # only `echo` for each of these three (measured), while a reader that saw
    # every `)` as a separator returned the label as a runnable gate.
    ('echo $(printf x) run "1. subst-closer" true', []),
    ('echo $((1+2)) run "1. arith-closer" true', []),
    ('echo <(printf x) run "1. proc-closer" true', []),
    # …and the word CONTINUES through one, so the `#` after it is literal and
    # the gate later on the line survives (`echo $(printf a)#b` prints `a#b`).
    ('echo $(printf a)#b; run "1. after-subst-hash" x',
     ["1. after-subst-hash"]),
    ('echo `printf a`#b; run "1. after-backtick-hash" x',
     ["1. after-backtick-hash"]),
    # The SUBSHELL closer is the other side of that rule and must keep ending
    # a word: `(printf b)#c; run "…" x` prints `b` and runs nothing else
    # (measured), because `#c` opens a comment that swallows the rest.
    ('(printf b)#c; run "1. after-subshell-hash" x', []),
    # The other half of the case rule: the substitution's OWN closer must
    # still be one, or it stays a boundary and invents a gate out of a word
    # bash hands to `echo` (measured — `run` does not execute here).
    ('echo $(case a in a) :;; esac) run "1. after-case-subst" true', []),
    ('echo $(case b in a) :;; b) :;; esac) run "1. after-two-patterns" true',
     []),
    # And `case` counts only AT a command position: as an argument it is an
    # ordinary word, so the closer after it is the substitution's (measured).
    ('echo $(echo case) run "1. word-case" true', []),
    # …and the boundaries of that suspension, each measured: a SINGLE quote
    # suspends nothing, an escaped `\\$(` or ``\\` `` opens nothing, a `$` not
    # followed by `(` is an expansion rather than a substitution, and the
    # quote RESUMES at the closer, so text after one is literal again.
    ("result='$(run \"1. sq-literal\" true)'", []),
    ('result="note; run \'1. dq-plain\' true"', []),
    ('result="\\$(run \'1. esc-dollar\' true)"', []),
    ('result="\\`run \'1. esc-backtick\' true\\`"', []),
    ('result="$HOME run \'1. dollar-var\' true"', []),
    ('result="${HOME} run \'1. dq-bracevar\' true"', []),
    ('result="$((1+2)) run \'1. dq-arith\' true"', []),
    ('result="$(printf a) run \'1. after-subst-in-dq\' true"', []),
    ('result="\'; run \\"1. sq-in-dq\\" true\'"', []),
    # The RESUME is what these four pin, and they are the rows that
    # distinguish it: with the quote never coming back the `;` after the
    # substitution would be a command boundary and the literal text behind it
    # a PHANTOM gate, where bash runs only the substitution (measured).
    ('result="$(printf a); run \'1. after-subst-semi\' true"', []),
    ('result="`printf a`; run \'1. after-backtick-semi\' true"', []),
    ('result="$HOME; run \'1. dollar-var-semi\' true"', []),
    ('result="$((1+2)); run \'1. arith-semi\' true"', []),
    # …and the boundaries of the nested rule, each measured: an escaped
    # backtick OUTSIDE any substitution is the literal it looks like, and the
    # nested pair resumes the OUTER region rather than ending it, so the
    # double quote is still suspended until the outer closer and literal
    # after it is literal.
    ('result=\\`run \'1. esc-bt-bare\' true\\`', []),
    ('result="`echo \\`printf a\\``; run \'1. after-nested\' true"', []),
    ('result="`echo \\`printf a\\`` run \'1. after-nested-word\' true"', []),
    # The nested CLOSER behaves as the outer one does — the word runs on
    # through it, so a `#` after it is literal and a gate behind that `;`
    # survives, while a word glued straight onto it is one word and not a
    # command (all three measured). These are the rows that distinguish a
    # closer from a second opener; without them a delimiter that only ever
    # opens passes the whole matrix.
    ('result="`echo \\`printf a\\`run \'1. glued-after-nested\' true`"', []),
    ('result="`echo \\`printf a\\`#b; run \'1. after-nested-hash\' true`"',
     ["1. after-nested-hash"]),
    ('result="`echo \\`printf a\\`; run \'1. sep-inside-outer\' true`"',
     ["1. sep-inside-outer"]),
    # A reserved word is reserved only WHERE A COMMAND CAN START. In an
    # argument it is an ordinary word, so bash runs only `echo` here (measured
    # for all three), while a rule that accepted a reserved word after any
    # whitespace read a PHANTOM gate — which satisfies a ci.yml mapping and the
    # reverse check after the real local gate has been deleted.
    ('echo if run "1. reserved-as-argument" true', []),
    ('echo while run "1. reserved-as-argument-2" true', []),
    ('printf "%s" then run "1. reserved-as-argument-3" true', []),
    # …and a BRACE is reserved only when it stands alone, so one inside an
    # ordinary word carries no boundary at all. Bash runs only `echo` for each
    # of these (measured), while a reader that matched the character returned
    # the label as a runnable gate — the same phantom, reachable from four
    # spellings the reviewer's own example is only the first of.
    ('echo x{ run "1. brace-opens-word" true', []),
    ('echo x} run "1. brace-closes-word" true', []),
    ('echo a{b,c} run "1. brace-expansion" true', []),
    ('echo ${HOME} run "1. parameter-expansion" true', []),
    # The same rule one construct over: `case{` is the ordinary word `case{`
    # and not the reserved word, so reading it as reserved pushed a `case`
    # marker, the substitution's closer stopped being a boundary, and the
    # argument after it was reported as a gate (measured — `run` does not
    # execute here). This row is what pins `_BARE_WORD`'s terminator set; the
    # four above are all satisfied by the boundary fix alone.
    ('echo $(case{ ; :) run "1. brace-after-case" true', []),
    # The lexer carries the same rule for its own command-position flag, whose
    # only consumer is the `case` marker: a brace inside a word must not make
    # the next word reserved (bash runs only `echo` here — measured), and a
    # standalone one must, or a group's `case` goes unseen and the pattern
    # closer inside it stops being the boundary it is (measured, `run` does
    # execute there).
    ('echo $(echo x{ case) run "1. lexer-brace" true', []),
    ('echo $({ case a in a) run "1. group-case" true;; esac; })',
     ["1. group-case"]),
    # A PARAMETER EXPANSION is one word, so every separator inside one is data.
    # Bash runs nothing for any of these (measured), while the reader marked
    # the separator as a command boundary and returned the label — a PHANTOM
    # local gate, which satisfies a ci.yml mapping and lets the reverse check
    # stay green after the real gate has been deleted. The reviewer's own
    # example is the first; the rest are the same hole in other spellings.
    ('echo ${UNSET:-x; run "12. css tokens defined" true}', []),
    ('echo ${UNSET:-x | run "1. pipe-in-exp" true}', []),
    ('echo ${UNSET:-x & run "1. amp-in-exp" true}', []),
    ('echo ${UNSET:-x\nrun "1. nl-in-exp" true}', []),
    ('echo ${UNSET:-x ( run "1. paren-in-exp" true )}', []),
    # …and neither parenthesis may touch the stack, or the ENCLOSING
    # substitution loses its entry and its own closer becomes a boundary.
    # `run` is an argument to `echo` in both of these (measured). The first is
    # what pins the `)` guard — a reader that popped there reported the label,
    # measured — while the second goes red only against a reader with no
    # expansion tracking at all, so it is a regression pin rather than a proof
    # of the `(` guard, which the `paren-in-exp` row above carries.
    ('echo $(echo ${UNSET:-a)b}) run "1. paren-pops-subst" true', []),
    ('echo $(echo ${UNSET:-a(b}) run "1. lparen-in-exp-in-sub" true', []),
    ('echo ${UNSET:-x; if run "1. reserved-in-exp" true; then :; fi}', []),
    ('echo ${UNSET:-a; #b\nrun "1. hash-in-exp" true}', []),
    ('echo ${UNSET:-x; case a in a) run "1. case-in-exp" true;; esac}', []),
    ('echo ${UNSET:-$((1)); run "1. arith-in-exp" true}', []),
    # An escaped pair inside one is data too: an unmasked `;` in the skeleton
    # is a boundary to `_command`, so the escape branch masks both characters.
    ('echo ${UNSET:-\; run "1. esc-sep-in-exp" true}', []),
    # Only `${` nests. A bare `{` does not — bash closes the expansion at the
    # FIRST unquoted `}`, so `run` really does execute in the second of these
    # (both measured), and a reader that counted every brace would lose it.
    ('echo ${UNSET:-${OTHER:-x; run "1. nested-exp" true}}', []),
    ('echo ${UNSET:-{a,b}; run "1. inner-braces" true}', ["1. inner-braces"]),
    # `$` immediately before the brace and not itself escaped: an escaped or
    # separated one opens no expansion, and `run` executes (both measured).
    ('echo \\${UNSET:-x; run "1. escaped-dollar" true}', ["1. escaped-dollar"]),
    ('echo $ {UNSET:-x; run "1. space-brace" true}', ["1. space-brace"]),
    # A real substitution inside an expansion SUSPENDS the masking and runs
    # (measured, all three spellings) — the half a blanket mask would lose.
    ('echo ${UNSET:-$(run "1. cmdsub-in-exp" true)}', ["1. cmdsub-in-exp"]),
    ('echo ${UNSET:-`run "1. backtick-in-exp" true`}', ["1. backtick-in-exp"]),
    ('echo ${UNSET:-<(run "1. procsub-in-exp" true)}', ["1. procsub-in-exp"]),
    # …and the expansion RESUMES at its closer, so the separator after one is
    # data again (measured, both spellings), including a `${ … }` reached
    # through a substitution that was itself reached through an expansion.
    ('echo ${UNSET:-$(printf a); run "1. after-nested-sub" true}', []),
    ('echo ${UNSET:-`printf a`; run "1. after-nested-bt" true}', []),
    ('echo ${UNSET:-$(echo ${OTHER:-y; run "1. exp-in-sub-in-exp" true})}', []),
    # A quoted or escaped `}` does not close an expansion (measured), so the
    # separator after it is still data.
    ('echo ${UNSET:-"}"; run "1. quoted-brace" true}', []),
    ("echo ${UNSET:-'}'; run \"1. sq-brace\" true}", []),
    ('echo ${UNSET:-a\\}b; run "1. escaped-close" true}', []),
    # A second expansion on the same line is masked in its own right, and a
    # word GLUED to a closer is one word (both measured).
    ('echo ${UNSET:-x} ${OTHER:-y; run "1. two-exps" true}', []),
    ('echo ${UNSET:-x}run "1. glued-after-exp" true', []),
    # Once the expansion has closed, a separator is a real boundary again —
    # the direction a blanket mask would break, so each is its own row.
    ('echo ${UNSET:-x}; run "1. after-exp" true', ["1. after-exp"]),
    ('x=${UNSET:-a; b}; run "1. assign-then-gate" true', ["1. assign-then-gate"]),
    ('echo ${UNSET:-a} && run "1. andand-after-exp" true',
     ["1. andand-after-exp"]),
    ('echo ${UNSET:-a;b}\nrun "1. next-line" true', ["1. next-line"]),
    ('echo ${UNSET:-$(printf a)}; run "1. after-exp-with-sub" true',
     ["1. after-exp-with-sub"]),
    ('echo $(( ${UNSET:-1} )); run "1. arith-exp" true', ["1. arith-exp"]),
    # An expansion reached through a backtick — plain and nested — is masked
    # like any other, and its own save must not be lost when the backtick
    # closes (measured, bash runs nothing for either).
    ('result="`echo ${UNSET:-x; run \'1. exp-in-bt-in-dq\' true}`"', []),
    ('result="`echo \\`echo ${UNSET:-x; run \'1. exp-in-nested-bt\' true}\\``"',
     []),
    # A NESTED backtick inside an expansion is a real substitution too, so it
    # gets the same save and restore: bash runs the first of these and not the
    # second (measured), which a reader carrying the expansion's depth into the
    # nested body would have masked away.
    ('result="`echo ${UNSET:-x \\`run \'1. bt-in-exp-in-bt\' true\\` ; run \'1. masked-after\' true}`"',
     ["1. bt-in-exp-in-bt"]),
    # A HERE-DOCUMENT body is data. Bash passes each of these to `cat` and
    # invokes nothing (measured), while the reader lexed the body as shell and
    # returned the label — a PHANTOM local gate, which satisfies a ci.yml
    # mapping and lets the reverse check stay green after the real invocation
    # is removed. The delimiter may be quoted four ways and none expands.
    ('cat <<\'EOF\'\nrun "12. css tokens defined" true\nEOF\n', []),
    ('cat <<EOF\nrun "1. unq-body" true\nEOF\n', []),
    ('cat <<"EOF"\nrun "1. dq-delim" true\nEOF\n', []),
    ('cat <<\\EOF\nrun "1. esc-delim" true\nEOF\n', []),
    ('cat <<E\'O\'F\nrun "1. split-delim" true\nEOF\nrun "1. after-split" true\n',
     ["1. after-split"]),
    ('cat << EOF\nrun "1. space-delim" true\nEOF\nrun "1. after-space" true\n',
     ["1. after-space"]),
    ('cat <<XyZ\nrun "1. word-delim" true\nXyZ\nrun "1. after-word" true\n',
     ["1. after-word"]),
    # Quotes, `#` and separators inside a body are data too, so nothing in it
    # opens a comment, a quoted span or a command position.
    ('cat <<\'EOF\'\n# x\nrun "1. hash-body" true\nEOF\nrun "1. after-hash" true\n',
     ["1. after-hash"]),
    ("cat <<'EOF'\nit's; run \"1. quote-body\" true\nEOF\nrun \"1. after-quote\" true\n",
     ["1. after-quote"]),
    # The rest of the OPERATOR's line is still shell — which is gate 12's own
    # shape in `validate.sh`, a real gate whose argument is a heredoc — and
    # shell resumes after the terminator.
    ('cat <<EOF; run "1. same-line" true\nbody\nEOF\n', ["1. same-line"]),
    ('run "1. before-hd" true <<EOF\nrun "1. in-body" true\nEOF\n', ["1. before-hd"]),
    ('cat <<\'EOF\'\nbody\nEOF\nrun "1. after-term" true\n', ["1. after-term"]),
    # A terminator must stand alone on its line. `<<-` strips leading TABS and
    # only tabs, so an indented `  EOF` under a plain `<<` terminates nothing
    # and the body swallows the rest (measured — `run` there does not execute).
    ('cat <<-\'EOF\'\n\trun "1. dash-body" true\n\tEOF\nrun "1. after-dash" true\n',
     ["1. after-dash"]),
    ('cat <<-EOF\n\tbody\n  EOF\nrun "1. dash-space" true\n\tEOF\nrun "1. after-dash-space" true\n',
     ["1. after-dash-space"]),
    ('cat <<\'EOF\'\nbody\n  EOF\nrun "1. not-term" true\nEOF\n', []),
    # Several queued on one line are consumed in order.
    ('cat <<A <<B\nrun "1. body-a" true\nA\nrun "1. body-b" true\nB\nrun "1. after-two" true\n',
     ["1. after-two"]),
    # An UNQUOTED delimiter expands, so a real substitution inside the body
    # RUNS (measured, both spellings and across lines) and must stay readable —
    # while the same text under a quoted delimiter is literal, and an escaped
    # `\$(` is literal under either.
    ('cat <<EOF\n$(run "1. subst-unq" true)\nEOF\n', ["1. subst-unq"]),
    ('cat <<EOF\n`run "1. bt-unq" true`\nEOF\n', ["1. bt-unq"]),
    ('cat <<EOF\n$(echo a\nrun "1. multiline-subst" true)\nEOF\n', ["1. multiline-subst"]),
    # …and the body RESUMES at the closer, so what follows a substitution is
    # data again and the terminator is still found (measured, both spellings).
    # Nothing else distinguishes the resume: without it the body simply ends at
    # the substitution and every row above stayed green.
    ('cat <<EOF\n$(printf a); run "1. after-sub-in-body" true\nEOF\nrun "1. after-hd" true\n',
     ["1. after-hd"]),
    ('cat <<EOF\n`printf a`; run "1. after-bt-in-body" true\nEOF\nrun "1. after-bt-hd" true\n',
     ["1. after-bt-hd"]),
    # A newline INSIDE an open substitution is that substitution's own text, so
    # a queued heredoc must not start its body there: bash runs both of these
    # (measured), while popping at any newline masked the rest of the
    # substitution and lost the gate inside it.
    ('cat <<EOF $(echo a\nrun "1. inside-subst" true)\nbody\nEOF\nrun "1. after-pending" true\n',
     ["1. inside-subst", "1. after-pending"]),
    ('cat <<EOF `echo a\nrun "1. inside-bt" true`\nbody\nEOF\nrun "1. after-bt-pending" true\n',
     ["1. inside-bt", "1. after-bt-pending"]),
    # …and the mirror: a heredoc queued INSIDE a substitution starts its body
    # at the newline in there. Bash runs nothing in either of these (measured):
    # the body is data, so its parenthesis touches no stack and the real closer
    # stays a substitution's, which is not a command boundary.
    ('echo $(cat <<\'EOF\'\n)\nEOF\n) run "1. paren-pops-subst" true\n', []),
    ('echo $(cat <<\'EOF\'\n(\nEOF\n) run "1. lparen-in-body" true\n', []),
    ('echo `cat <<\'EOF\'\n)\nEOF\n` ; run "1. after-hd-bt" true\n', ["1. after-hd-bt"]),
    ('cat <<\'EOF\'\n$(run "1. subst-q" true)\nEOF\n', []),
    ('cat <<EOF\n\\$(run "1. escaped-subst" true)\nEOF\nrun "1. after-esc" true\n',
     ["1. after-esc"]),
    # …and an expansion is not a substitution: it runs no command, and the
    # body around it stays masked.
    ('cat <<EOF\n${HOME}\nEOF\nrun "1. after-expansion" true\n', ["1. after-expansion"]),
    # Three things that LOOK like the operator and are not: a here-STRING takes
    # no body, a doubled parenthesis is arithmetic (`<<` is a left shift), and
    # a quoted or commented-out operator is text. Reading a heredoc out of any
    # of them queues a delimiter that never arrives and masks the rest of the
    # file, losing every gate after it in silence.
    ('cat <<<\'run "1. herestring" true\'\n', []),
    ('cat <<<\'x\'\nrun "1. after-herestring" true\n', ["1. after-herestring"]),
    # An EMPTY delimiter is legal when it was quoted, and its terminator is an
    # empty line (measured) — so the operator queues on whether a word was
    # there, not on whether the word had characters in it.
    ('cat <<""\nrun "1. empty-body" true\n\nrun "1. after-empty" true\n',
     ["1. after-empty"]),
    ('echo $((1 << 2))\nrun "1. dollar-arith" true\n', ["1. dollar-arith"]),
    ('((1 << 2))\nrun "1. bare-arith" true\n', ["1. bare-arith"]),
    ('echo \'<<EOF\'\nrun "1. quoted-op" true\n', ["1. quoted-op"]),
    ('# cat <<EOF\nrun "1. hd-comment" true\n', ["1. hd-comment"]),
    # A quoted DELIMITER honours bash's escape rules, and an unconditional
    # `find()` for the next raw quote closed the word at an ESCAPED one:
    # `cat <<"E\"OF"` is terminated by a line reading `E"OF`, after which bash
    # resumes executing commands (measured, Codex on PR #94), while the
    # delimiter this derived ran into later lines and masked the rest of the
    # file — every gate after it lost, invisible in BOTH directions. A
    # backslash is special ONLY before `"`, `\`, `$`, a backtick or a newline;
    # everywhere else it is literal, and collapsing one that is not would
    # derive a terminator that never arrives and lose the file just the same.
    ('cat <<"E\\"OF"\nx\nE"OF\nrun "1. hd-esc-quote" true\n', ["1. hd-esc-quote"]),
    ('cat <<"E\\\\OF"\nx\nE\\OF\nrun "1. hd-esc-bslash" true\n', ["1. hd-esc-bslash"]),
    ('cat <<"E\\$OF"\nx\nE$OF\nrun "1. hd-esc-dollar" true\n', ["1. hd-esc-dollar"]),
    ('cat <<"E\\`OF"\nx\nE`OF\nrun "1. hd-esc-tick" true\n', ["1. hd-esc-tick"]),
    ('cat <<"E\\nOF"\nx\nE\\nOF\nrun "1. hd-literal-bslash" true\n',
     ["1. hd-literal-bslash"]),
    ('cat <<"E\\ OF"\nx\nE\\ OF\nrun "1. hd-literal-space" true\n',
     ["1. hd-literal-space"]),
    ("cat <<'E\\OF'\nx\nE\\OF\nrun \"1. hd-sq-bslash\" true\n", ["1. hd-sq-bslash"]),
    # A line CONTINUATION inside one contributes nothing, so the terminator is
    # `EOF`: joining the halves with a SPACE derived `EO F` and masked the rest
    # of the file, the same outcome through the other door.
    ('cat <<"EO\\\nF"\nx\nEOF\nrun "1. hd-cont-delim" true\n', ["1. hd-cont-delim"]),
    # A continuation JOINS the halves anywhere (`ec\<newline>ho hi` runs `echo
    # hi`, measured), and a backslash at end of line is one only when it is not
    # itself escaped (`echo a\\` prints `a\` and the next line runs).
    ('ru\\\nn "1. cont-midword" true\n', ["1. cont-midword"]),
    ('echo a\\\\\nrun "1. after-esc-bslash" true\n', ["1. after-esc-bslash"]),
    # ARITHMETIC is not shell: `$((…))` and `((…))` expand to a number and
    # invoke nothing (measured), so their contents are masked and their closer
    # opens no command position — `echo $((1+2)) run "…" true` passes `run` to
    # `echo`. Reading the contents as shell reported `run + 1))` as an
    # unreadable gate call: a gate RED ON A HEALTHY TREE.
    ('echo $((1+2)) run "1. arith-closer" true', []),
    ('echo $(( (1+2) * 3 ))\nrun "1. arith-group" true\n', ["1. arith-group"]),
    ('echo $(( (1+2)))\nrun "1. arith-tight" true\n', ["1. arith-tight"]),
    ('echo $(( ((1)) ))\nrun "1. arith-nested" true\n', ["1. arith-nested"]),
    # …while a genuine substitution INSIDE one still runs, at top level, in a
    # heredoc body and in an expansion alike (all measured), and a backtick
    # does too — which is why the depth is a counter the backtick stack can
    # save rather than a predicate over the parenthesis stack.
    ('echo $(( $(run "1. arith-subst" true; echo 1) + 1 ))\n', ["1. arith-subst"]),
    ('echo $(( `run "1. arith-tick" true; echo 1` + 1 ))\n', ["1. arith-tick"]),
    ('cat <<EOF\n$(( $(run "1. hd-arith-subst" true; echo 1) + 1 ))\nEOF\n',
     ["1. hd-arith-subst"]),
    ('echo "${UNSET:-$(( $(run "1. exp-arith-subst" true; echo 1) + 1 ))}"\n',
     ["1. exp-arith-subst"]),
    # A SPACE is what tells the two apart: `$( (…) )` is a substitution around
    # a subshell and genuinely runs (measured), so it must still open one.
    ('echo $( (run "1. subst-subshell" true) )\n', ["1. subst-subshell"]),
    # A NEWLINE inside arithmetic is legal bash and `run` there is a
    # VARIABLE: `echo $(( 1 +\nrun ))` prints 2 and invokes nothing (measured),
    # so an unmasked newline would put the name at a command position.
    ('run=1\necho $(( 1 +\nrun ))\nrun "1. arith-newline" true\n',
     ["1. arith-newline"]),
    # Inside an ALREADY-MASKED body nothing is pushed at all, so `$((` is
    # literal there rather than opening a region of its own. Letting it open
    # one desyncs the stack: the pair's closers take the body's literal branch
    # and pop nothing, so the entry is never removed — `"arith" in parens`
    # then refuses every LATER heredoc in the file and the depth is never
    # restored, so the rest of the file stays masked and every gate after it
    # is lost, invisible in both directions. Both rows are green with the
    # clause and red without it.
    ('cat <<EOF\n$((1 + 1))\nEOF\ncat <<EOF2\nrun "1. phantom" true\nEOF2\n'
     'run "1. after-hd-arith" true\n', ["1. after-hd-arith"]),
    ('echo ${UNSET:-$((1 + 1))}\ncat <<EOF\nrun "1. phantom" true\nEOF\n'
     'run "1. after-exp-arith" true\n', ["1. after-exp-arith"]),
    # A QUOTED delimiter keeps a `\`+newline in its body: bash reads the next
    # line as the terminator and runs the gate after it (measured for both
    # spellings), while joining the pair made `last \`+`EOF` into `last EOF`,
    # so the terminator was never found and every later gate was lost —
    # invisible in BOTH directions.
    ('cat <<\'EOF\'\nlast \\\nEOF\nrun "1. hd-sq-cont" true\n', ["1. hd-sq-cont"]),
    ('cat <<"EOF"\nlast \\\nEOF\nrun "1. hd-dq-cont" true\n', ["1. hd-dq-cont"]),
    ('cat <<\'EOF\'\nrun "1. phantom" true \\\nEOF\nrun "1. hd-cont-gate" true\n',
     ["1. hd-cont-gate"]),
    # …while an UNQUOTED body is the opposite: there the pair IS a
    # continuation, so the body joins and the terminator still arrives.
    ('cat <<EOF\nbody \\\nmore\nEOF\nrun "1. hd-unq-cont" true\n', ["1. hd-unq-cont"]),
    # …and when that lands on the terminator bash joins `last \\`+`EOF`, leaves
    # the heredoc unterminated and runs NO later gate (measured), so exempting
    # an unquoted body would report a PHANTOM. This is the row that
    # distinguishes the two, since a mid-body join still reaches its
    # terminator either way.
    ('cat <<EOF\nlast \\\nEOF\nrun "1. phantom" true\n', []),
    # A continuation between the operator and its delimiter is one operator to
    # bash, with an UNQUOTED delimiter, and the gate after the body runs.
    ('cat <<\\\nEOF\nbody\nEOF\nrun "1. hd-op-cont" true\n', ["1. hd-op-cont"]),
    # …and the delimiter reader's own continuation rule is what keeps that
    # body from being mistaken for a QUOTED one running to EOF, which would
    # exempt every later continuation in the file: without it the raw lex reads
    # the delimiter as an escaped newline plus `EOF`, and the mid-word gate
    # after the body disappears.
    ('cat <<\\\nEOF\nbody\nEOF\nru\\\nn "1. after-op-cont" true\n',
     ["1. after-op-cont"]),
    # An UNTERMINATED quoted body runs to EOF, and the span has to be closed
    # there: joining inside it could MAKE a terminator out of two body lines
    # (`E\\`+`OF` is not `EOF` to bash, which abandons the heredoc and runs no
    # gate — measured) and report a phantom.
    ('cat <<\'EOF\'\nE\\\nOF\nrun "1. phantom" true\n', []),
    # A mid-word continuation after a quoted body must still be joined — the
    # span ends at the terminator, so nothing later is exempt.
    ('cat <<\'EOF\'\nx\nEOF\nru\\\nn "1. cont-after-hd" true\n', ["1. cont-after-hd"]),
    # A TAB is a separator too (measured), so a tab-indented gate is read
    # rather than refused by name.
    ('run\t"1. tab-separated" true', ["1. tab-separated"]),
    # An assignment word is `NAME=`, `NAME+=`, or either with an array
    # SUBSCRIPT, and its VALUE is a word that may span a command substitution.
    # A grammar accepting only `NAME=` with a value of bare and quoted
    # characters read NONE of the next eleven — invisible in BOTH directions,
    # so a local gate could lack a CI counterpart while lockstep reported
    # success. Every expectation measured against bash.
    ('MODE+=x run "1. plus-equals" true', ["1. plus-equals"]),
    ('MODE+= run "1. plus-equals-empty" true', ["1. plus-equals-empty"]),
    ('MODE=$(printf ci) run "1. subst-value" true', ["1. subst-value"]),
    ('MODE=$(printf ci)x run "1. subst-glued" true', ["1. subst-glued"]),
    ('MODE=`printf ci` run "1. backtick-value" true', ["1. backtick-value"]),
    ('MODE=<(printf ci) run "1. procsub-value" true', ["1. procsub-value"]),
    # The separators a substitution's body may contain are exactly what a bare
    # word stops at, which is why spanning it is the whole rule.
    ('MODE=$(printf a; printf b) run "1. subst-separator" true',
     ["1. subst-separator"]),
    ('MODE=$(echo $(printf a)) run "1. subst-nested" true', ["1. subst-nested"]),
    ('MODE=$( (printf a) ) run "1. subst-subshell" true', ["1. subst-subshell"]),
    ('MODE=$(case a in a) printf x;; esac) run "1. subst-case" true',
     ["1. subst-case"]),
    # The row that pins BOTH requirements at once: the substitution's body is
    # real shell, so a gate inside it is real (round 32), AND the prefix spans
    # it, so the gate after it is real too. Bash runs both (measured); a
    # non-overlapping scan reported only the outer.
    ('MODE=$(run "1. subst-inner" true) run "1. subst-outer" true',
     ["1. subst-inner", "1. subst-outer"]),
    ('>$(printf /dev/null) run "1. redirect-subst" true', ["1. redirect-subst"]),
    ('MODE=$(printf ci) MODE2=x run "1. two-prefixes" true', ["1. two-prefixes"]),
    # TWO boundaries reach this one command word — the start of the text, and
    # the `;` INSIDE the substitution, after which `MODE2=1` reads as a prefix
    # of its own. Bash runs the gate once (measured); without the dedup the
    # reader reported it twice.
    ('MODE=$(printf a; MODE2=1) run "1. subst-two-boundaries" true',
     ["1. subst-two-boundaries"]),
    ('a[0]=1 run "1. subscript" true', ["1. subscript"]),
    ('a[1 + 2]=1 run "1. subscript-spaces" true', ["1. subscript-spaces"]),
    # …and the two that are NOT assignment words. Bash runs no gate for either
    # (measured: `command not found`), so reading them as prefixes would be a
    # PHANTOM local gate — the `+` belongs to `+=` alone, and a name may not
    # begin with a digit.
    ('MODE+x=1 run "1. phantom" true', []),
    ('9MODE=1 run "1. phantom" true', []),
    ('run() {\n  :\n}', []),
)


# The UNREADABLE reader's own two rows. It answers a different question from
# the label reader, so the spelling matrix above cannot speak for it — and its
# failure direction is the worse one: off the raw text `echo 'note; run'` was
# reported as an unreadable gate (measured), a gate red on a healthy tree.
_UNREADABLE_SPELLINGS: tuple[tuple[str, list[str]], ...] = (
    # ARITHMETIC contains no commands, so a variable named `run` inside one is
    # not an invocation: `$((run + 1))` and `((run + 1))` invoke nothing
    # (measured) and were reported as `run + 1))` — a gate RED ON A HEALTHY
    # TREE, at top level, inside a heredoc body, inside an expansion and
    # inside a double-quoted word alike. Codex named the heredoc; the
    # top-level spelling is the base case and was the same defect.
    ('echo $((run + 1))', []),
    ('((run + 1))', []),
    ('a=$((run + 1))', []),
    ('echo "$((run + 1))"', []),
    ('cat <<EOF\n$((run + 1))\nEOF\n', []),
    ('echo "${UNSET:-$((run + 1))}"', []),
    # A newline inside arithmetic is legal and `run` after it is a VARIABLE.
    ('echo $(( 1 +\nrun ))', []),
    # The command word must be EXACTLY the gate's name. An array subscript may
    # span lines in an assignment, and bash then invokes nothing at all
    # (`a[1 +`⏎`run]=2`, measured) — this reported `run]=2`, a gate RED ON A
    # HEALTHY TREE. In an ARGUMENT position bash really does split there and
    # run a command called `run]=2` (measured), which is not this gate helper,
    # so both spellings are correctly silent for the same reason.
    ('run=1\na[1 +\nrun]=2', []),
    ('echo a[1 +\nrun]=2', []),
    # A quoted body keeps its continuation, so a real unreadable call after the
    # terminator is still seen rather than swallowed with the rest of the file.
    ('cat <<\'EOF\'\nlast \\\nEOF\nrun $label true\n', ['run $label true']),
    # …and a real invocation inside one is still refused BY NAME, so the rule
    # is not "arithmetic hides everything".
    ('echo $(( $(run $label true) + 1 ))', ['run $label true) + 1 ))']),
    # An ASSIGNMENT is not an invocation. `run=1` invokes nothing (measured)
    # and was reported as an unreadable gate — latent only because
    # `validate.sh` carries no such assignment today (checked, not assumed),
    # and it is the setup line of the arithmetic case above, so the reviewer's
    # own example would have stayed red after the fix they asked for. The
    # boundary is the ABSENCE of a space, measured in both directions.
    ('run=1', []),
    ('run+=b', []),
    ('run[0]=1', []),
    ('skip_gate=0', []),
    ('run =1', ['run =1']),
    ('run == 1', ['run == 1']),
    # A quoted delimiter that honours escapes keeps a later gate visible; one
    # that does not masks the rest of the file, so the UNREADABLE reader sees
    # nothing there either — the invisible-in-both-directions half of the
    # heredoc rows above.
    ('cat <<"E\\"OF"\nx\nE"OF\nrun $label true\n', ['run $label true']),
    # A real invocation whose label is not a literal must be refused BY NAME.
    ('run $label x', ["run $label x"]),
    # A quoted MENTION is data and must be invisible in both directions.
    ("echo 'note; run'", []),
    # The same suspension, on the reader whose failure direction is the worse
    # one: a non-literal label inside a double-quoted substitution is a real
    # invocation (measured) and must be refused BY NAME, while a mention
    # inside an ordinary double-quoted word stays invisible.
    ('result="$(run $label true)"', ['run $label true)"']),
    ('result="note; run"', []),
    # A non-literal label inside a NESTED substitution is a real invocation
    # (measured) and must be refused by name, not swallowed as escaped text.
    # A parameter expansion is data, so a non-literal label inside one is a
    # mention and must be invisible in both directions — while one inside a
    # substitution that expansion contains is a real invocation (measured) and
    # must still be refused BY NAME.
    ('echo ${UNSET:-x; run $label true}', []),
    ('echo ${UNSET:-$(run $label true)}', ['run $label true)}']),
    ('result="`echo \\`run $label true\\``"', ['run $label true\\``"']),
    # The prefix grammar belongs to BOTH readers, so an unreadable call behind
    # one must be refused BY NAME rather than left invisible — and the shape
    # that is no prefix at all must stay invisible in both directions.
    ('MODE+=x run bare', ['run bare']),
    ('MODE=$(printf ci) run bare', ['run bare']),
    ('MODE+x=1 run bare', []),
)


# Structural rows for the parameter-expansion mask: every character of a body
# masked, and a real substitution inside one left alone. NO BEHAVIOURAL ROW CAN
# PIN THESE, and saying so is better than implying one does — measured, by
# unmasking the escape pair and then the newline, each of which left the whole
# matrix green. The body mask already hides `run` and its quoted label, and an
# unmasked separator inside an expansion cannot reach a word OUTSIDE it either:
# the closing `}` always stands between them, and `_command` excludes `}`
# outright because it never precedes a command (`{ :; } run "…" true` is a bash
# syntax error, measured). So the mask is stated as an INVARIANT rather than
# left resting on that argument — no character of a body reaches the skeleton
# unmasked, which is one rule a reader can check instead of a list of
# characters somebody has to remember to extend.
#
# `True`: every character of the fragment must be masked. `False`: none may be.
_EXPANSION_MASK: tuple[tuple[str, str, bool], ...] = (
    ('echo ${UNSET:-x; run "1. mask-sep" true}', '; run "1. mask-sep" true', True),
    ('echo ${UNSET:-x\nrun "1. mask-nl" true}', '\nrun "1. mask-nl" true', True),
    ('echo ${UNSET:-\; run "1. mask-esc" true}', '\; run', True),
    ('echo ${UNSET:-x | y & z}', '| y & z', True),
    ('echo ${UNSET:-$(run "1. unmasked" true)}', 'run', False),
    ('echo ${UNSET:-`run "1. unmasked-bt" true`}', 'run', False),
)


# The same invariant for a HERE-DOCUMENT body, and for the same reason: the
# behavioural rows above already fail on a phantom label, so no row can pin
# that (say) a quote or a `#` inside a body reached the skeleton intact. The
# fragments carry no newline, because a heredoc body KEEPS its newlines — the
# terminator scan reads line starts, and the command after the terminator needs
# the boundary its own newline carries.
_HEREDOC_MASK: tuple[tuple[str, str, bool], ...] = (
    ("cat <<'EOF'\nrun '1. hd-mask' true\nEOF\n", "run '1. hd-mask' true", True),
    ("cat <<'EOF'\nit's; x # y\nEOF\n", "it's; x # y", True),
    ("cat <<'EOF'\n# x\nEOF\n", "# x", True),
    ('cat <<EOF\nrun "1. hd-unq" true\nEOF\n', 'run "1. hd-unq" true', True),
    ("cat <<'EOF'\nEOF\nrun '1. after' true\n", 'EOF', True),
    ('cat <<EOF\n$(run "1. hd-sub" true)\nEOF\n', 'run', False),
    ('cat <<EOF\n`run "1. hd-bt" true`\nEOF\n', 'run', False),
)


# The same invariant for an ARITHMETIC expression. A newline inside one is
# legal bash (`echo $(( 1 +\nrun ))` prints 2 and invokes nothing, measured),
# so that half IS pinned behaviourally by the row above; a quote, a brace or a
# separator inside one is not, because the body mask already hides the name
# `run` and nothing readable can follow an unmasked character there. Stated as
# an invariant for the same reason the other two are: one rule a reader can
# check, rather than a list of characters somebody has to remember to extend.
_ARITH_MASK: tuple[tuple[str, str, bool], ...] = (
    ('echo $((run + 1))', 'run + 1', True),
    ('((run + 1))', 'run + 1', True),
    ('echo $(( "1" + run ))', '"1" + run', True),
    ('echo $(( ${x} + 1 ))', '${x} + 1', True),
    ('echo $(( 1 +\nrun ))', '\nrun ', True),
    ('echo $(( (1+2) * 3 ))', '(1+2) * 3', True),
    ('echo $(( $(run "1. unmasked" true) + 1 ))', 'run', False),
    # A quoted subscript may carry a NEWLINE and is legal bash (`m["a\nb"]`
    # in an associative-array subscript, measured), which is the one thing
    # `masked()` decides differently inside arithmetic.
    ('echo $(( m["a\nb"] + 1 ))', '"a\nb"', True),
    ('echo $(( `run "1. unmasked-bt" true` + 1 ))', 'run', False),
)


def _self_check() -> list[str]:
    """Drive the command-position reader over `_SPELLINGS`.

    With its own blindness precondition, because a matrix that iterates
    nothing reports success having verified nothing — measured, by emptying
    it: this file printed PASS. Both directions must be represented too, since
    a matrix of only-positive rows is satisfied by a reader that matches
    everything and a matrix of only-negative rows by one that matches nothing.
    """
    bad = []
    # Counted INSIDE the loop, so the precondition speaks for what was
    # actually driven rather than for what the list happens to hold: an
    # emptied `_SPELLINGS` and a loop that iterates something else both fail
    # here, and only one of those is caught by reading the list.
    positive = negative = 0
    for src, expected in _SPELLINGS:
        if expected:
            positive += 1
        else:
            negative += 1
        got = shell_gate_labels(src, "run")
        if got != expected:
            bad.append(
                f"the command-position reader answers {got!r} for {src!r}, expected {expected!r}"
            )
    unreadable_pos = unreadable_neg = 0
    for src, expected in _UNREADABLE_SPELLINGS:
        if expected:
            unreadable_pos += 1
        else:
            unreadable_neg += 1
        got = shell_unreadable_calls(src)
        if got != expected:
            bad.append(
                f"the unreadable-call reader answers {got!r} for {src!r}, expected {expected!r}"
            )
    if unreadable_pos < 1 or unreadable_neg < 1:
        bad.append(
            f"the unreadable-call matrix drove {unreadable_pos} refusals and "
            f"{unreadable_neg} mentions — it cannot prove that reader in both directions"
        )
    mask_all = mask_none = 0
    bodies = [("an expansion", r) for r in _EXPANSION_MASK]
    bodies += [("a heredoc", r) for r in _HEREDOC_MASK]
    bodies += [("arithmetic", r) for r in _ARITH_MASK]
    for kind, (src, fragment, want_masked) in bodies:
        at = src.find(fragment)
        if at == -1:
            bad.append(
                f"the body-mask matrix names a fragment {fragment!r} that is "
                f"not in {src!r}"
            )
            continue
        span = _lex_shell(src)[1][at : at + len(fragment)]
        if want_masked:
            mask_all += 1
            if any(c != _MASK for c in span):
                bad.append(
                    f"{kind} body reaches the skeleton unmasked: {fragment!r} "
                    f"in {src!r}"
                )
        else:
            mask_none += 1
            if any(c == _MASK for c in span):
                bad.append(
                    f"a substitution inside {kind} body is masked: {fragment!r} "
                    f"in {src!r}"
                )
    if mask_all < 1 or mask_none < 1:
        bad.append(
            f"the body-mask matrix drove {mask_all} masked bodies and "
            f"{mask_none} suspensions — it cannot prove the mask in both directions"
        )
    if positive < 2 or negative < 2:
        bad.append(
            f"the command-position spelling matrix drove {positive} invocations and "
            f"{negative} non-invocations — it cannot prove the reader in both directions"
        )
    return bad


def main() -> int:
    # The reader is proven before it is believed: a matrix that cannot fail
    # would let every other assertion here pass for the wrong reason.
    spelling = _self_check()
    if spelling:
        for s in spelling:
            print(f"FAIL: {s}")
        return 2

    steps, unnamed, duplicate = ci_steps()
    if not steps:
        print("FAIL: read no named run-steps out of ci.yml — this check is blind")
        return 2

    failures: list[str] = []

    # 0. An unnamed `run:` step is a check with nothing to classify it by.
    for where in unnamed:
        failures.append(
            f"ci.yml has an unnamed `run:` step ({where}) — give it a `name:`, "
            "or it is a CI check this file cannot classify and nobody mirrors"
        )

    # 0b. And a name reused inside ONE job is no identity either: the second
    #     step inherits the first's classification and is mirrored by nobody.
    for where in duplicate:
        failures.append(
            f"ci.yml has two `run:` steps named {where!r} — rename one. A step "
            "is identified by (job, name) here, so the second silently "
            "inherits the first's mapping and is classified by nobody"
        )

    # 1. Every ci.yml check is classified. A new step is in neither the map nor
    #    §13, so it fails here rather than drifting silently.
    unclassified = [s for s in steps if s not in COVERAGE]
    for job, name in unclassified:
        failures.append(
            f"ci.yml step {name!r} in job {job!r} is not classified in "
            "scripts/check-gate-lockstep.py — give it a validate.sh gate label, "
            "or CI_ONLY and a SKILL.md §13 entry"
        )

    # 2. A mapped validate.sh label must exist there, or renaming a gate
    #    locally leaves this map pointing at nothing.
    labels, skipped, dupe_labels, unreadable_gates = validate_labels()
    for line in unreadable_gates:
        failures.append(
            f"validate.sh has a gate this check cannot read: {line!r} — its label "
            "must be a quoted string on the command, or nothing mirrors it"
        )
    for lbl in dupe_labels:
        failures.append(
            f"validate.sh declares gate {lbl!r} twice — rename one. A label is a "
            "gate's identity here, so the second command inherits the first's "
            "ci.yml mapping and is mirrored by nobody"
        )
    if not labels:
        failures.append("read no runnable gates out of validate.sh — this check is blind")
    if not skipped:
        failures.append("read no skip_gate labels out of validate.sh — this check is blind")
    # The GATE LABELS the map names, which is not the same as its values: SETUP
    # and CI_ONLY are sentinels, and comparing a validate.sh label against
    # `COVERAGE.values()` would let a local gate named `CI_ONLY` excuse itself.
    # Contrived as a name, wrong as a rule — the question is whether a ci.yml
    # step claims this label, and a sentinel is not a step claiming anything.
    mapped = {v for v in COVERAGE.values() if v not in (SETUP, CI_ONLY)}
    for (job, name), target in COVERAGE.items():
        if target in (SETUP, CI_ONLY):
            continue
        if target not in labels:
            # Named separately when the label exists only as a `skip_gate`,
            # because the two have different fixes: one is a rename, the other
            # is a gate that can no longer run.
            how = (
                "declares only as a skip_gate, so it can never run"
                if target in skipped
                else "does not declare"
            )
            failures.append(
                f"{name!r} (job {job!r}) claims validate.sh gate {target!r}, "
                f"which validate.sh {how}"
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
    for job, name in COVERAGE:
        if (job, name) not in steps:
            failures.append(
                f"scripts/check-gate-lockstep.py maps {name!r} in job {job!r}, "
                "which is not a step in ci.yml"
            )

    # 4. Every CI_ONLY step is named verbatim in SKILL.md §13, and every §13
    #    entry names one — both directions, because each rots on its own.
    ci_only = sorted(f"{job} / {name}" for (job, name), t in COVERAGE.items() if t == CI_ONLY)
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
