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

# The reserved words that take a WORD rather than a command: `for NAME`,
# `select NAME`, the subject of a `case`, and the patterns after an `in`. Every
# other reserved word here either precedes a command (`then`, `do`, `{`) or
# terminates one (`fi`, `done`, `esac`), and `function`/`time` carry their own
# grammar above.
#
# Treating them as command positions was wrong in BOTH directions, on files
# bash parses and runs. A PHANTOM: `echo $(for case in x; do :; done) run
# "G-fake" true` invokes nothing, while the name `case` was looked up, found
# reserved, and pushed a case marker — which then consumed the substitution's
# own closer as a pattern `)`, making it a command boundary and inventing a
# gate out of a word bash passes to `echo` (measured, Codex on PR #94; the
# `select` spelling and the `case`-subject one do the same, and a subject
# spelled `esac` POPS the marker its own `case` pushed, which is the mirror).
# And a gate RED ON A HEALTHY TREE: `for run in a; do :; done` is ordinary
# bash, and `_command`'s chain read the loop's NAME as a gate invocation whose
# label it could not parse, so `shell_unreadable_calls` refused it by name
# (`run in a`) — the same for `select run in a`, `case run in *)`, and the
# `skip_gate` spelling of each.
#
# Codex's own remedy was to track a name position after `for` and `select` the
# way the lexer tracks one after `function`, where the command position
# SURVIVES the name because the body's `{` needs it. Measured, that closes its
# own example and opens a new phantom: with the position surviving, `in` is
# then recognised as reserved, the command position carries into the WORD LIST,
# and `echo $(for x in case; do :; done) run "G-fake" true` — legal bash that
# runs nothing — reports the gate. A `for` name is not a `function` name: what
# follows it is a word list, not a body, so the honest rule is that no command
# position opens at all.
SHELL_WORD_TAKING = ("for", "select", "case", "in")


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
        re.escape(w)
        for w in SHELL_RESERVED
        if w not in ("!", "}", "time", "function", "coproc")
        and w not in SHELL_WORD_TAKING
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
    # `time` is the ONE reserved word that takes OPTIONS, and bash's grammar
    # for them was read off the shell rather than guessed: at most one `-p`,
    # then at most one `--`, in that order, each separated by blanks. Every
    # cell measured — `time -p`, `time --` and `time -p -- ` all run the
    # pipeline, while `time -- -p`, `time -p -p`, `time -p -- --`, `time -pv`,
    # `time -x` and `time -` each make that word the COMMAND instead, and a
    # quoted `time "-p"` or escaped `time \-p` does the same.
    #
    # Without this the chain expected the command word immediately after
    # `time`, so `time -p run "13. new check" true` — which bash runs
    # (measured) — was read by NEITHER this reader nor `shell_unreadable_calls`:
    # invisible in BOTH directions, so a timed local gate could have no CI
    # counterpart while lockstep reported success (Codex, PR #94). Ten
    # spellings shared that hole, including `time --`, `time -p --`, the tab
    # spelling, `skip_gate`, and `time -p` after a separator, inside `if`,
    # before `!`, before an assignment prefix and before a redirection.
    #
    # ANCHORED TO `time` rather than allowed loose in the chain: a bare `-p`
    # before a command is an ordinary argument, so `foo -p run "13. fake" true`
    # and `echo -p run "13. fake" true` invoke no gate (measured) and a
    # free-floating option would have invented a PHANTOM out of each.
    timespec = r'time[ \t]+(?:-p[ \t]+)?(?:--[ \t]+)?'
    # `!` takes a delimiter like every other reserved word, and the `*` here
    # was a PHANTOM: `!run "1. fake" true` makes bash look for a command
    # literally called `!run` and find none, so no gate runs (measured), while
    # this read the label — and a phantom satisfies a ci.yml mapping after the
    # real local gate has been deleted. Glued, it is not the reserved word at
    # all: `!case a in a) …` is a bash SYNTAX ERROR (measured). A newline after
    # it needs no clause, because a newline is itself a command position.
    # `function` is the second reserved word that is not followed by a command
    # — it is followed by the function's NAME, and only then by the body. Left
    # in the plain set above, the chain stopped at the name, and the body's `{`
    # was then reachable from no boundary at all (a `{` is a reserved word
    # rather than a metacharacter, so it is not in `_BOUNDARY_CHARS`): `function
    # checks { run "13. new check" true; }; checks` runs the gate (measured)
    # and was read by NEITHER this reader nor `shell_unreadable_calls` —
    # invisible in BOTH directions, so a local gate written in this supported
    # spelling could have no CI counterpart while lockstep reported success
    # (Codex, PR #94). Six spellings shared the hole, including the extra-blank
    # and tab forms, `skip_gate`, inside a substitution and after a separator.
    #
    # ONLY the `function NAME {` form: `function NAME() {`, the POSIX `NAME()
    # {`, a newline before the brace and a `( … )` body all read already,
    # because each puts a `(` or a newline — real boundaries — between the name
    # and the body (all measured).
    #
    # The NAME's own grammar was swept off the shell rather than guessed: every
    # printable ASCII character was tried inside one, and bash accepts
    # `!#%+,-./:?@]^_{}~`, the digits and the letters, while `$` and a
    # backslash are refused outright ("not a valid identifier") and a QUOTED
    # name is refused the same way — so the definition never happens and its
    # body never runs, which is why a masked (quoted or escaped) character and
    # a `$` are excluded here: admitting them would report a gate that bash
    # cannot define. The rest end the word anyway.
    #
    # A blank after the name is bash's own rule and not a convenience:
    # `function f {echo x; }` is a SYNTAX ERROR, and so is a newline between
    # `function` and the name (both measured, both pinned by a row). What NO
    # ROW PINS is the `+` rather than a `*`: scanned over 2080 constructed
    # inputs — every name spelling above against every separator and every
    # body opener — 143 answer differently and bash refuses to PARSE all 143,
    # so on every input that could distinguish them nothing runs and neither
    # answer is right. It is a `+` because that is what bash does.
    #
    # STATED RESIDUAL, in the other direction: a `{` is legal INSIDE a name
    # (`function f{g { run "…" true; }; f{g` runs the gate, measured), so the
    # class admits one — and a name ending in `{` therefore reads a gate that
    # cannot run, since `function f{ run "…" true; }` is a syntax error. That
    # is a phantom in a file bash refuses outright; excluding `{` would trade
    # it for a MISS on a legal spelling, which is the defect this whole rule
    # is about.
    funcspec = r'function[ \t]+[^ \t\n|&;()<>$%s]+[ \t]+' % re.escape(_MASK)
    # `coproc` is the third reserved word that may be followed by something
    # other than a command: an OPTIONAL name, and only then the body. Left in
    # the plain set, the chain read the name as the command and stopped, so
    # the body's `{` was reachable from no boundary and `coproc checks { run
    # "13. new check" true; }` — which bash runs — was read by NEITHER reader:
    # invisible in both directions, a local gate with no CI counterpart while
    # lockstep reported success (Codex, PR #94). The same hole for a tab
    # before the brace, a redirection after the group, a `$NAME` and a quoted
    # name, and a gate at the HEAD of a named `until`/`if` — and the OTHER
    # direction one word over: `coproc run { run "…" true; }` names the
    # coprocess `run`, and the chain read that name as an unlabelled
    # invocation, so `shell_unreadable_calls` refused a healthy file by name.
    #
    # The name is admitted only where `_COPROC_OPENER` says bash reads one —
    # before a compound-command opener, across blanks and never a newline —
    # which is what keeps `coproc checks run "1. fake" true` (a command called
    # `checks`) from being read as a gate. The lexer asks the same question at
    # the word's end, so the command position survives the name and the
    # body's `{` opens one.
    # The name is a skeleton WORD — a substitution region, an escape, a bare
    # character that is not a metacharacter, or a quoted run — because
    # `coproc $(printf checks) { … }` names the coprocess `checks` and runs
    # the body (measured), and a bare character class read none of the
    # substitution spellings (Codex, PR #94). Non-empty, and followed by
    # the opener the lexer asks for, so the two halves agree.
    name_piece = (
        r"""(?:%s|\\[\s\S]|[^\s;&|'"\\()<>%s%s]|'[^']*'|"(?:[^"\\]|\\.)*")"""
        % (_SUBST_REGION, _NOCLOBBER, _SUBST_CLOSE)
    )
    coprocspec = r'coproc[ \t]+(?:%s+(?=%s))?' % (name_piece, _COPROC_OPENER.pattern)
    chain = r'(?:[ \t]*(?:%s|%s|%s|(?:%s)[ \t]+|![ \t]+))*' % (
        timespec,
        funcspec,
        coprocspec,
        words,
    )
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
    word_piece = (
        r"""(?:%s|\\[\s\S]|[^\s;&|'"\\%s%s]|'[^']*'|"(?:[^"\\]|\\.)*")"""
        % (_SUBST_REGION, _NOCLOBBER, _SUBST_CLOSE)
    )
    word = word_piece + "*"
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
    # A REDIRECTION prefix, read off bash's own operator set rather than
    # approximated by "one or two angle brackets with an optional `&`", which
    # was three holes at once and every one of them measured:
    #
    #   * `>|`, the noclobber override, matched nothing at all, so
    #     `2>|g.err run "…" true` — which bash runs — was reported by NEITHER
    #     reader: invisible in both directions, which is how a local gate lacks
    #     a CI counterpart while lockstep reports success (Codex on PR #94).
    #   * a `{varname}` target, bash's allocate-a-descriptor form, the same
    #     (`{fd}>g.fd run "…" true` runs, and `{fd}>|`, `{fd}<`, `{fd}>>`,
    #     `{fd}<>`, `{fd}>&` and `{fd}<<<` with it).
    #   * and the most ordinary spelling of all, a SPACE between the operator
    #     and its target: `> g.a run "…" true`, `2> g.a …`, `>> g.a …`,
    #     `< g.in …` and `>& 2 …` all run the gate and all read as nothing,
    #     because the word had to start immediately after the operator.
    #
    # The target is a decimal descriptor or `{name}`, attached with NO space —
    # `2 >|g.a run "…"` runs a command called `2` (measured) — while `&>` and
    # `&>>` take no target at all: `2&>f` and `{fd}&>f` are both "command not
    # found". Operators are longest-first so `<<<` is not read as `<<` and a
    # word beginning `<`.
    #
    # The target word must be NON-EMPTY, which closes a PHANTOM the old
    # grammar had: with an empty word allowed, `> run "1. fake" true` read as
    # a redirection with no target followed by the gate, while bash redirects
    # stdout to a file NAMED `run` and then tries to execute the label —
    # no gate runs (measured), and reporting one satisfies a ci.yml mapping
    # for a gate that does not exist.
    redirect = (
        r'(?:(?:[0-9]+|\{[A-Za-z_][A-Za-z0-9_]*\})?'
        r'(?:<<<|<<-|<<|<>|<&|>%s|>>|>&|<|>)|&>>|&>)' % _NOCLOBBER
    )
    prefixes = r'(?:[ \t]*(?:%s%s|%s[ \t]*%s)[ \t]+)*' % (
        assign, word, redirect, word_piece + "+"
    )
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


def _backslash_run(text: str, i: int) -> int:
    """How many consecutive backslashes end at `i`, inclusive.

    A nested backtick's delimiter is recognised by PARITY, not by the pair in
    front of the scan: bash reads the body of a backtick substitution once,
    turning `\\\\` into `\\` and `` \\` `` into a bare backtick, and then parses
    the RESULT as shell — so a run of N backslashes before a backtick opens a
    nested substitution only when N % 4 == 1. Measured across N = 0..8: bash
    invokes the inner command at N = 1 and N = 5 and at no other length, and
    N = 3 and N = 7 leave the backtick literal because the first pass emits an
    ODD number of backslashes in front of it and the second pass then reads
    them as escaping it.

    The scan is backward over `text` because the escape branch below has
    already consumed the earlier pairs of the same run, so the character at `i`
    alone cannot say how long the run is.

    The `i - n >= 0` bound is defensive and NO ROW PINS IT, which is said here
    rather than left looking tested: the one caller fires only inside a
    backtick region, so a backtick always stands before the run and `i - n`
    can never reach 0 on a backslash. Measured by narrowing it to `> 0` — the
    whole matrix stays green.
    """
    n = 0
    while i - n >= 0 and text[i - n] == "\\":
        n += 1
    return n


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


# What the `|` of a `>|` noclobber override becomes in the skeleton. It is one
# operator with the `>` before it, so the `|` is not a pipe and opens no
# command — `>| run "1. fake" true` redirects stdout to a file NAMED `run` and
# then tries to execute the label, running no gate (measured), while a `|` left
# as a boundary reported one.
#
# Its OWN marker rather than `_MASK`, because the redirection grammar in
# `_command` still has to recognise the operator: masked as an ordinary
# character it became an unreadable target word and the phantom came back
# through the word instead of through the boundary (measured).
_NOCLOBBER = "\x03"


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

# The `!` reserved word, which `_BARE_WORD` cannot match because it is not a
# letter. It needs a BLANK after it for the same reason every reserved word
# does — `!case` glued is a bash syntax error and `!run` is an ordinary command
# word (both measured). A newline after it is not spelled here: a newline opens
# a command position on its own.
#
# NO BEHAVIOURAL ROW PINS THE LOOKAHEAD, and saying so is better than implying
# one does. `_WORD_BREAK` excludes `!`, so a character glued to one is never a
# word start and is never examined either way; what the lookahead changes is
# whether the flag SURVIVES a word like `!xy`, and for that to matter the next
# word must be `case` or `esac` at a command position — which cannot happen
# once `!xy` is the command word, since `case a in a)` in an ARGUMENT position
# is a bash syntax error. Measured over 45 constructed inputs across five
# contexts: the twelve that answer differently all exit 2.
#
# Kept because the rule belongs here as much as in `_command`'s chain, which
# requires the same blank: without it the two would mean different things by
# "the `!` reserved word", the one-rule-two-scopes disagreement these rounds
# keep finding.
_BANG = re.compile(r"!(?=[ \t])")

# The option words bash's `time` accepts, with `_BARE_WORD`'s terminator set so
# that a word merely STARTING with one is not read as it: `time -pv`, `time -x`
# and `time --p` each make that word the COMMAND (measured), and only `-p` and
# `--` are options at all.
#
# NO BEHAVIOURAL ROW PINS THE LOOKAHEAD, and saying so is better than implying
# one does. `_command`'s own grammar requires a blank after the option, so the
# label reader refuses `time -pv run "…"` whatever this says; the lookahead
# reaches only `at_cmd`, whose single consumer is the `case` marker — and for
# that to differ the word after the option would have to be `case` at a
# command position, which it cannot be once the option-like word IS the
# command, since `case a in a)` in an ARGUMENT position is a bash syntax
# error. Measured over 35 constructed inputs: the ten that answer differently
# are all files bash refuses to parse (exit 2), where neither answer is right
# because nothing runs.
#
# Kept because the rule belongs in both places: without it this and
# `_command`'s `-p[ \t]+` would mean different things by "an option", which is
# the one-rule-two-scopes disagreement these rounds keep finding.
_TIME_OPTION = re.compile(r"(-p|--)(?=[\s;&|()<>]|$)")

# `coproc [NAME] command`: the word after `coproc` is a NAME exactly when what
# follows IT opens a compound command — bash's own rule, read off the shell
# rather than the manual (`help coproc` gives the grammar and says nothing
# about how the two readings are told apart): `coproc checks { run "…" true;
# }` runs `run`, and so do the `(`, `((`, `[[`, `while`, `until`, `for`, `if`
# and `case` heads after a name, with a tab or several blanks, with the `(`
# glued (`checks(`), with a quoted name and with a `$NAME` one — while `coproc
# checks run "…" true` runs a command CALLED `checks` and hands it `run` as an
# argument, and so do `coproc checks time run …` and `coproc checks X=1 run …`
# (all measured, bash 5.2). A NEWLINE ends the question: `coproc checks`⏎`{
# run "…" true; }` is a coproc of `checks` followed by a group in the main
# shell, so the lookahead crosses blanks and nothing else. A reserved word in
# the name position stays reserved (`coproc if …` is an unnamed coproc of the
# `if`; `coproc fi {` is a syntax error), so this is consulted only for a bare
# word that is not one. The name's own class is a shell WORD, quotes, masks
# and `$` included, because bash validates the identifier only at RUN time —
# and, as with a function name, a name bash then refuses reads a gate that
# never runs, which is a phantom in a file bash rejects and is the stated
# residual rather than a miss on a legal spelling.
#
# The name is a WORD, and a word may span a COMMAND SUBSTITUTION: `coproc
# $(printf checks) { run "…" true; }` expands to the identifier `checks` and
# runs the body, and so do the backtick, the double-quoted, the glued
# (`checks$(printf 2)`) and the nested spellings, a substitution carrying a
# `;`, and one whose body invokes a gate of its own (all measured, bash 5.2).
# A character class that stopped at the substitution's `(` read none of them
# — invisible in both directions, so a local gate could lack a CI counterpart
# while lockstep reported success (Codex, PR #94). So there is no name regex:
# the chain reads the name as a skeleton word, substitution regions included,
# exactly as it reads an assignment's value, and the lexer decides at the
# word's END, where its own tokenisation has already carried it through
# whatever the word contained. What the two share is the question asked
# after the word — this lookahead, anchored at the word-break character —
# so they cannot disagree about which opener makes a name.
_COPROC_OPENER = re.compile(
    r"(?:[ \t]*\(|[ \t]+(?:\{|\[\[|while|until|for|if|case|select)(?=[ \t\n;&|()<>]|$))"
)


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
    # process substitution (`$(`, `$((`, `<(`, `>(`), "paren" for a subshell,
    # "glob" for an extglob group, which is part of a word rather than a
    # subshell and is therefore inert at both ends,
    # and "case-pat"/"case-body" for a `case … esac`, whose pattern closers
    # carry no `(` of their own.
    #
    # A case carries WHICH HALF of a clause it is in, because bash allows an
    # OPTIONAL leading parenthesis on a pattern and that `(` is not a subshell:
    # `case x in (run) :;; esac` invokes nothing (measured) while an
    # unconditional boundary there made the pattern read as a command, so
    # `shell_unreadable_calls` refused `run) :` — a gate RED ON A HEALTHY TREE
    # (Codex, PR #94), with `(skip_gate)`, `(a|run)`, a second clause's
    # pattern, the newline form and `( run )` behind it. Worse, the `(` left a
    # command position open, so a pattern spelled `case` or `esac` was read as
    # reserved: the marker it pushed swallowed the pattern's own closer and the
    # leading paren went unpopped, so the ENCLOSING substitution's closer
    # became a boundary and `echo $(case x in (case) :;; esac) run "1. fake"
    # true` reported a PHANTOM gate (measured, both spellings).
    #
    # A clause runs pattern → `)` → body → `;;`, so "case-pat" says a bare `(`
    # opens a pattern and "case-body" says it opens a subshell — and that
    # distinction is load-bearing rather than tidy, because a subshell in a
    # body genuinely runs commands: `case a in a) (run "…" true);; esac` and
    # `case a in a) :; (run "…" true);; esac` both invoke the gate (measured).
    # The flip back is `;;`, `;&` or `;;&` and never a single `;`, which is
    # what keeps that second row readable.
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
    # Where we stand in `time`'s option list — "" outside one, "opt" when `-p`
    # and `--` are both still available, "ign" when only `--` is. The words
    # keep the command position open, which is what stops `-p` clearing
    # `at_cmd` and hiding a `case` from the marker rule above.
    time_opt = ""
    # True when the word about to start is a function's NAME — the word after
    # `function`, which bash does NOT recognise as a reserved word however it
    # is spelled (`function case { :; }` is legal, measured, while `case() {
    # :; }` is a syntax error). Without it the name was read as an ordinary
    # command word, which broke the marker rule in BOTH directions: `function
    # case` pushed a marker that was never popped, so the substitution's own
    # closer stopped being one and `echo $(function case { :; }; printf x) run
    # "1. fake" true` reported a PHANTOM for a word bash passes to `echo`; and
    # the name CLEARED `at_cmd`, so the body's `{` did not open a command
    # position, a `case` inside it was not recognised, and its pattern's `)`
    # popped the enclosing substitution — the same phantom by the opposite
    # route (both measured). Round thirty's defect, reached through `function`
    # as round forty-six reached it through `time` and forty-seven through `!`.
    # "" outside a definition, "next" when the word about to start is the
    # function's NAME, and "in" while that word is being read. The third state
    # is what makes the rule WORD-SCOPED, which a brace forced: a brace is
    # legal anywhere in a name (`function {f`, `function f{g`, `function f}`
    # all run, measured) and the brace branch below sits ABOVE the word-start
    # logic, so it answered first — computing `opens` as false (a name
    # character follows, not a word break), CLEARING `at_cmd`, and leaving the
    # flag armed. Two defects from that one root, both measured: the body's `{`
    # then opened no command position, so a `case` inside it went unrecognised
    # and its pattern's `)` popped the enclosing substitution; and the still-
    # armed flag ate the NEXT command word as a name, which does the same one
    # statement later. Round thirty's defect, reached through a brace in a
    # name, as rounds forty-six to forty-eight reached it through `time`, `!`
    # and `function` itself (Codex, PR #94).
    fn_name = ""
    # "next" when the word about to start may be a coprocess NAME — the word
    # after `coproc` — and "in" while that word is being read. It is one
    # exactly when a compound command follows it (`_COPROC_OPENER`, asked at
    # the word's END), and then the command position SURVIVES it, as it does
    # a function's name, so the body's `{` opens one and a `case` inside is
    # recognised; read as an ordinary command word instead, the name cleared
    # `at_cmd`, the brace opened nothing, and a `case` pattern's `)` inside
    # the body popped the enclosing substitution — `echo $(coproc checks {
    # case a in a) :;; esac; }) run "1. fake" true` reported a PHANTOM for a
    # word bash passes to `echo`. Round thirty's defect, reached through
    # `coproc` as it was reached through `time`, `!` and `function` (Codex,
    # PR #94).
    coproc_name = ""
    # The nesting the name word began at: a word-break character ends the
    # word only at the SAME depth and outside any quote, since `$(printf
    # checks)` carries a blank inside its substitution and `"$(…)"` a quote
    # around it — both legal names (measured, bash 5.2; Codex, PR #94).
    coproc_depth = 0
    coproc_bt = False
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
        # The name word ends at the first word-break character, WHEREVER it is
        # handled — a space and a `;` reach the final branch, while `(` and `)`
        # are taken by the parenthesis branch above it, and `function f(){ … }`
        # is legal bash (measured). Clearing here rather than inside one branch
        # is what keeps "in" scoped to the word rather than to whichever branch
        # happens to consume its last character.
        if fn_name == "in" and ch in _WORD_BREAK:
            fn_name = ""
        # A coprocess NAME is read to its END, where the lexer's own
        # tokenisation has already carried it through a substitution, a
        # backtick or a quote — a regex at the word's start read a bare word
        # only, so `coproc $(printf checks) { … }` was no name and its body
        # was lost (measured; Codex, PR #94). The word begins at the first
        # non-blank after `coproc` unless it is a brace, a subshell, a `!` or
        # a reserved word, which are the body itself (or an error) and take
        # their own branches; it ends at the first word break at the same
        # nesting, outside any quote, and THERE the question is asked: an
        # opener after it makes it a name, and the command position survives
        # the name as it does a function's — the body's `{` opens one and a
        # `case` inside it is recognised. Anything else after it means the
        # word was the command (`coproc checks run "…" true` runs `checks`),
        # and a newline ends the question rather than crossing it.
        # A `(` that follows `$` is the word CONTINUING into a substitution,
        # not ending — the entry for it is pushed by the branch below, after
        # this check, so the depth alone cannot tell it from a subshell's `(`
        # (measured: the name question was answered at the `$(` and the real
        # end of `$(printf checks)` never asked it, so a `case` in the body
        # went unrecognised and its pattern's `)` popped the enclosing
        # substitution — the phantom).
        if (
            coproc_name == "in"
            and ch in _WORD_BREAK
            and not (ch == "(" and i > 0 and text[i - 1] == "$")
            and len(parens) == coproc_depth
            and in_backtick == coproc_bt
            and quote is None
            and exp_depth == 0
            and arith_depth == 0
            and hd is None
        ):
            coproc_name = ""
            if _COPROC_OPENER.match(text, i):
                at_cmd = True
        elif coproc_name == "next" and at_word_start and at_cmd and ch not in _WORD_BREAK:
            head = _BARE_WORD.match(text, i)
            if ch in "{(!" or (head and head.group(1) in SHELL_RESERVED):
                coproc_name = ""
            else:
                coproc_name = "in"
                coproc_depth = len(parens)
                coproc_bt = in_backtick
        # An extglob group is INSIDE A WORD, so no character in one starts a
        # word — `@(a|b)` is one word to bash, and the separators within it are
        # pattern text rather than boundaries. Every branch that sets
        # `at_word_start` did so from the character's own shape, so `|`, `;`,
        # `&`, a newline and a SPACE each left the flag true inside a group and
        # the `#` branch then read the next character as a COMMENT: it consumed
        # the group's closing `)` and the rest of the line, every later newline
        # stayed masked as glob text, and both readers lost the gate after it.
        # `shopt -s extglob` + `echo @(a|#foo)` followed by `run "G" true`
        # invokes the gate (measured) while the shipped reader answered neither
        # runnable nor unreadable — a MISS in both directions, which is how a
        # local gate lacks a CI counterpart while lockstep reports success.
        # Codex named the `|`; the other four spellings and the case-pattern
        # form came from measuring the general claim.
        #
        # Cleared HERE rather than in the `#` branch, and rather than beside
        # each separator, because the rule is about the GROUP and not about
        # which character last set the flag — the space reaches the final
        # branch and is not one of the masked separators at all, so a fix that
        # enumerated them would have missed it. A substitution inside a group
        # is real shell and pushes its own entry, so a `#` there is still a
        # comment (measured); only the group itself is word interior.
        if parens and parens[-1] == "glob":
            at_word_start = False
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
        elif (
            ch == "\\"
            and in_backtick
            and text.startswith("\\`", i)
            and _backslash_run(text, i) % 4 == 1
        ):
            # A nested substitution's delimiter — see `nested_backtick` above.
            # Opening carries the boundary a bare backtick spells; closing is
            # inert and the word runs on, exactly as the outer pair behaves.
            #
            # The PARITY guard above is what makes this a delimiter rather than
            # an escaped backtick: `\\\\\\`` — three backslashes — is data, and
            # without the guard this branch fired on the third one (the escape
            # branch having eaten the first two) and opened a substitution bash
            # never opens, so `` result=`echo \\\\\\`run "G" true\\\\\\`` `` invoked no
            # gate while the label reader returned `G`: a PHANTOM local gate,
            # which satisfies a ci.yml mapping and keeps the reverse check
            # happy after the real local gate has been deleted (Codex on PR
            # #94). The same rule governs the CLOSER, which the review did not
            # name and which was equally unchecked.
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
                # An escape pair is DATA, both characters, everywhere. The
                # pair used to be kept RAW outside an expansion, so
                # `_find_commands` read the escaped character as a command
                # boundary: bash runs only `echo` for `echo x\; run "GATE"
                # true` (measured, and the same for an escaped `|`, `&`, `(`
                # and `)`) while the label reader returned `GATE` — a PHANTOM
                # local gate, which satisfies a ci.yml mapping and keeps the
                # reverse check happy after the real gate has been deleted
                # (Codex on PR #94). The SIBLING reader has the mirror failure
                # and the worse direction: `echo x\; run` is an ordinary line
                # invoking no gate and was reported as an unreadable gate
                # INVOCATION, a gate RED ON A HEALTHY TREE.
                #
                # ONE branch, because keeping the backslash was measured to
                # decide NOTHING: 408 constructed inputs — 24 escaped
                # characters across 17 contexts, argument, assignment value,
                # redirection target, substitution, backtick, expansion,
                # heredoc, quoted word, arithmetic and label positions — gave
                # the identical answer from both readers whether the backslash
                # survived or was masked with it. So `word_piece`'s
                # `\\[\s\S]` branch and two bare characters are the same
                # thing here, and a rule that changes no answer is a rule with
                # nothing behind it. Masking both also makes this the same
                # sentence as the expansion, heredoc and arithmetic masks
                # rather than a fourth shape.
                #
                # No `arith_depth` clause: a backslash inside arithmetic is a
                # bash SYNTAX ERROR ("invalid arithmetic operator", measured,
                # and again before a digit), so the state cannot occur in a
                # healthy tree and a guard for it would be a rule with nothing
                # behind it — the same call the `#` branch below records.
                skel.append(_MASK * 2)
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
            if (
                bool(skel)
                and (
                    skel[-1] in "?*+@"
                    or (
                        skel[-1] == "!"
                        and bool(parens)
                        and parens[-1] in ("case-pat", "glob")
                    )
                )
            ):
                # No `not opens_subst`/`not arith_open` guard, unlike every
                # sibling branch here, and that is measured rather than
                # assumed: both are decided by the RAW characters around the
                # `(` — a preceding `$`, `<` or `>`, or a doubled `(` — while
                # this rule reads the SKELETON, where no value is ever one of
                # `?*+@`. The two can therefore never hold together. Checked
                # across 100 constructed inputs (every operator before `$(`,
                # `<(`, `>(` and `((`, at command, argument, assignment and
                # pattern positions, with extglob and without): not one answer
                # moved with either guard removed. A guard no input can pin is
                # a rule with nothing behind it, so the measurement is here
                # instead.
                #
                # An EXTGLOB GROUP — `?(`, `*(`, `+(`, `@(`, `!(` — which is
                # part of a WORD and never a subshell, so its closer ends
                # nothing and opens no command position. Without this the `)`
                # was a boundary, which went wrong in both directions: inside a
                # case PATTERN `shopt -s extglob` + `case xrun in @(x)run) :;;
                # esac` invokes nothing (measured) while
                # `shell_unreadable_calls` refused `run) :` — a gate red on a
                # healthy tree (Codex PR #94) — and in an ORDINARY word `echo
                # @(x) run "1. fake" true` passes every word to `echo` and ran
                # NOTHING while the label reader returned `1. fake`, a PHANTOM
                # gate. The sibling CONSTRUCT is the worse direction, which is
                # why this is scoped to a word rather than to a case pattern:
                # one rule covers both, and a pattern IS a word.
                #
                # `!` is narrowed to a case PATTERN (or a group already
                # inside one) and that is a DECIDABILITY line, not caution.
                # The other four are syntax errors without extglob in every
                # position (measured), so they have exactly one reading. `!(`
                # is the one spelling that is also valid shell without it, and
                # means something else: `!(run "…" true)` at a command
                # position NEGATES A SUBSHELL and really invokes the gate
                # (measured), while with extglob the identical text is one
                # glob word bash cannot execute (measured, exit 127, nothing
                # run). Which one it is depends on a `shopt` this reader
                # cannot know — it can be set conditionally, in a sourced
                # file, or through `BASHOPTS` — so knowing the POSITION does
                # not resolve it, and reading it as a glob would LOSE a real
                # gate. Inside a pattern there is no such conflict: a pattern
                # is never a command position, and `case y in !(x)) …` is a
                # syntax error without extglob (measured). Outside one, `!(`
                # keeps the subshell reading it has always had; the phantom
                # that leaves at an ARGUMENT position is pre-existing and
                # pinned as a row below rather than left to be rediscovered.
                #
                # The operator is read off the SKELETON, so an escaped or
                # quoted one is not one — `\@(x)` and `"@"(x)` are bash syntax
                # errors (measured), and a masked character is not in the set.
                # Without extglob every spelling but `!(` is a syntax error too
                # (measured), so the only files this changes are ones bash will
                # actually run.
                kind = "glob"
                parens.append(kind)
                exp_resume_at.append(
                    (len(parens) - 1, exp_depth, arith_depth, hd)
                )
                out.append(ch)
                skel.append(_MASK)
                at_word_start = False
                at_cmd = False
                i += 1
                continue
            if (
                not opens_subst
                and not arith_open
                and parens
                and parens[-1] == "case-pat"
            ):
                # The pattern's optional leading parenthesis. Inert and pushing
                # NOTHING, so the pattern's own `)` falls to the "case" rule
                # below and balances it; `at_cmd` stays false because what
                # follows is a PATTERN, which is also why `case x in case) …`
                # reads correctly today (`case` takes a word, not a command —
                # `SHELL_WORD_TAKING`).
                out.append(ch)
                skel.append(_MASK)
                at_word_start = True
                at_cmd = False
                i += 1
                continue
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
            inert = kind in ("arith", "glob") or arith_depth > 0
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
            if parens and parens[-1] == "glob":
                # An extglob group's closer: pattern text in the middle of a
                # WORD, so it is inert below — no boundary, no command
                # position, and the word runs on through it.
                closed = parens.pop()
            elif parens and parens[-1].startswith("case"):
                # A case pattern's closer: a real command position (`case a in
                # a) run "…" x;; esac` runs `run`, measured) that closes no
                # `(`, so the construct beneath it stays open. It ends the
                # pattern half of the clause, whether or not the pattern
                # carried a leading `(`.
                if parens[-1] == "case-pat":
                    parens[-1] = "case-body"
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
            inert = closed in ("arith", "glob") or arith_depth > 0
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
            # A backtick OPENS a command position — the skeleton has spelled it
            # `(` since round twenty-nine — and this branch never said so, so
            # the lexer and the skeleton disagreed: `case` inside one was not
            # recognised, no marker was pushed, and a pattern's alternation was
            # therefore still a boundary. `echo `case a in a|run) run "…"
            # true;; esac`` invokes the gate (measured) while
            # `shell_unreadable_calls` reported `run) run "…" true` — the same
            # red-on-a-healthy-tree as the `$( … )` spelling, pre-existing and
            # invisible until the pattern rules above needed the marker. A
            # CLOSER is not a command position: a word runs on through it.
            at_cmd = not in_backtick
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
        elif ch in "{}" and not fn_name:
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
            # `coproc { …` has no name: the brace is the body.
            coproc_name = ""
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
                # `time`'s options keep the command position open, which the
                # `_command` grammar above says in its own language. This is
                # the same rule in the LEXER, and it is load-bearing for a
                # different reason: with `-p` read as an ordinary word the
                # flag was cleared, `case` was then not recognised as reserved,
                # no marker was pushed, and the pattern's `)` popped the
                # enclosing substitution — so `echo $(time -p case a in a)
                # :;; esac) run "1. fake" true` reported a PHANTOM gate for a
                # word bash passes to `echo`, and the same line with a real
                # gate inside the `case` was MISSED (both measured). Round
                # thirty's defect, reached through `time`.
                topt = _TIME_OPTION.match(text, i) if time_opt else None
                opt = topt.group(1) if topt else ""
                if opt == "-p" and time_opt == "opt":
                    time_opt = "ign"
                    at_cmd = True
                elif opt == "--":
                    time_opt = ""
                    at_cmd = True
                elif fn_name == "next":
                    # The function's NAME. It is not a reserved word whatever
                    # it says, and the command position SURVIVES it, because
                    # what follows is the body — whose `{` opens one of its own
                    # only while `at_cmd` still holds (the `{` branch above
                    # requires it). `time_opt` cannot be live here: the word
                    # that set `fn_name` cleared it.
                    fn_name = "in"
                    at_cmd = True
                elif _BANG.match(text, i):
                    # `!` negates a pipeline, so a command position survives it
                    # — and `_BARE_WORD` matches letters only, so this branch
                    # read `name` as "" and CLEARED the flag. `case` was then
                    # not recognised, no marker was pushed, and the pattern's
                    # `)` popped the enclosing substitution: `echo $(! case a
                    # in a) run "G" true;; esac)` runs the gate and was read by
                    # neither reader, while its mirror reported a phantom for a
                    # word bash passes to `echo` (both measured, Codex PR #94).
                    # Round thirty's defect, reached through `!` this time, as
                    # round forty-six reached it through `time`.
                    #
                    # `time_opt` RESETS here rather than carrying: after a `!`
                    # the next `-p` is the command, not an option — measured,
                    # `time -p ! -p run "G" true` answers `-p: command not
                    # found`. `! time -p …` still reads, because `time` re-arms
                    # it one word later.
                    #
                    # NO BEHAVIOURAL ROW PINS THE RESET either, for the same
                    # reason the lookahead above has none: `_command`'s chain
                    # already refuses `time -p ! -p run`, so only the `case`
                    # marker can see the difference, and `time -p ! -- case a
                    # in a)` is a syntax error. Measured over 16 constructed
                    # inputs: the two that answer differently exit 2. It is
                    # here so the lexer and the chain agree about where a
                    # timespec ends.
                    time_opt = ""
                    at_cmd = True
                else:
                    fn_name = "next" if name == "function" else ""
                    time_opt = "opt" if name == "time" else ""
                    if name == "coproc":
                        coproc_name = "next"
                    at_cmd = (
                        name in SHELL_RESERVED
                        and name not in SHELL_WORD_TAKING
                    )
                    if name == "case":
                        parens.append("case-pat")
                    elif name == "esac" and any(
                        p.startswith("case") for p in parens
                    ):
                        # Back to and including the nearest `case`; a
                        # well-formed script leaves nothing above it.
                        last = max(
                            k
                            for k, p in enumerate(parens)
                            if p.startswith("case")
                        )
                        del parens[last:]
            if (
                ch == ";"
                and parens
                and parens[-1] == "case-body"
                and text[i + 1 : i + 2] in (";", "&")
            ):
                # `;;`, `;&` and `;;&` end a case clause, so the next bare `(`
                # opens a PATTERN again. A single `;` deliberately does NOT:
                # `case a in a) :; (run "…" true);; esac` invokes the gate
                # (measured), and flipping here would read that subshell as a
                # pattern and lose it. `;;&` flips on its first `;`; the second
                # then sees "case-pat" and is a no-op.
                parens[-1] = "case-pat"
            out.append(ch)
            # `>|` is the noclobber override, one operator: its `|` is not a
            # pipe and opens no command. Without this, `>| run "1. fake" true`
            # reported a PHANTOM gate off the boundary after the `|`, while
            # bash redirects stdout to a file NAMED `run` and then tries to
            # execute the label — no gate runs (measured). It is the sibling of
            # the empty-target phantom `_command`'s redirection grammar closes,
            # reached by a different mechanism, which is why it is fixed here
            # and not there.
            #
            # A quoted or escaped `>` never reaches the skeleton as `>`, so
            # this cannot fire on one, and `>>|` and `<|` are bash SYNTAX
            # ERRORS (measured) — so the only `|` this reaches in a script bash
            # will parse is a real noclobber override. A `skel[-2] != ">"`
            # guard was written first and then deleted: no row could pin it,
            # and on the one input it changed it gave the WORSE answer, leaving
            # the `|` after `>>` a boundary so that `echo x >>| run "1. fake"
            # true` reported a PHANTOM gate for a line bash refuses outright.
            noclobber = ch == "|" and bool(skel) and skel[-1] == ">"
            # A `|` in a case PATTERN is alternation, not a pipe, and opens no
            # command: `case x in a|run) :;; esac` invokes nothing (measured,
            # with and without the optional leading parenthesis) while an
            # unconditional boundary made `shell_unreadable_calls` refuse
            # `run) :` — a gate red on a healthy tree, pre-existing rather than
            # introduced by the leading-paren fix (measured on both heads), and
            # the same construct one character over. A pipe in the BODY is
            # untouched, because the pattern's `)` has flipped the clause to
            # "case-body" by then: `case a in a) printf x | run "…" true;;
            # esac` still reads (measured).
            pattern_alt = (
                ch == "|" and bool(parens) and parens[-1] == "case-pat"
            )
            # Inside an extglob group `|`, `;`, `&` and a newline are all
            # PATTERN TEXT, not boundaries: `echo @(a;b)`, `@(a&b)` and
            # `@(a\nb)` each print themselves and invoke nothing (measured),
            # while `echo @(a|run) "1. fake" true` passes every word to `echo`
            # — so an unmasked `|` there is the same phantom the group rule
            # above closes, one character in. The body stays LIVE rather than
            # wholly masked, because a substitution inside a group really does
            # run: `echo @($(run "…" true; printf x))` invokes the gate
            # (measured, and the backtick spelling too), so masking the body
            # would be a MISS — the worse direction.
            glob_text = (
                ch in ";&|\n" and bool(parens) and parens[-1] == "glob"
            )
            skel.append(
                _NOCLOBBER
                if noclobber
                else (_MASK if pattern_alt or glob_text else ch)
            )
            at_word_start = ch in _WORD_BREAK
            if (
                ch in ";&|\n"
                and not noclobber
                and not pattern_alt
                and not glob_text
            ):
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
    # `!` negates a pipeline and a command position survives it, so a `case`
    # behind one still opens a pattern. The lexer read `!` as no word at all
    # and cleared the flag, so the marker was never pushed and the pattern's
    # `)` popped the enclosing substitution — a MISS for the real gate and a
    # PHANTOM for its mirror, both measured against bash.
    ('echo $(! case a in a) run "1. bang-case-in-subst" true;; esac)',
     ["1. bang-case-in-subst"]),
    ('echo $(! case a in a) :;; esac) run "1. fake" true', []),
    ('echo `! case a in a) run "1. bang-case-in-backtick" true;; esac`',
     ["1. bang-case-in-backtick"]),
    # …and the same through `time`'s options, in both orders, since `!` may sit
    # on either side of a timespec (measured).
    ('echo $(! time -p case a in a) run "1. bang-time-case" true;; esac)',
     ["1. bang-time-case"]),
    ('echo $(time -p ! case a in a) run "1. time-bang-case" true;; esac)',
     ["1. time-bang-case"]),
    ('echo $(! ! case a in a) run "1. bang-bang-case" true;; esac)',
     ["1. bang-bang-case"]),
    # A `!` is the reserved word only when DELIMITED, exactly like the others:
    # `!run "…"` makes bash look for a command called `!run` and find none
    # (measured), so no gate runs — this read the label, a PHANTOM. Glued to a
    # reserved word it is not one either: `!case a in a) …` is a syntax error.
    ('!run "1. fake" true', []),
    # …while the delimited spellings still read, on one line and across a
    # newline, which needs no rule of its own because a newline opens a
    # command position on its own.
    ('! run "1. bang-then-gate" true', ["1. bang-then-gate"]),
    ('!\nrun "1. bang-newline-gate" true', ["1. bang-newline-gate"]),
    ('echo $(!\ncase a in a) run "1. bang-newline-case" true;; esac)',
     ["1. bang-newline-case"]),
    # `time` is the one reserved word with OPTIONS, and every cell below was
    # measured against bash. The positives were invisible in BOTH directions
    # before this rule — neither runnable nor unreadable — so a timed local
    # gate could have no CI counterpart while lockstep reported success.
    ('time -p run "1. time-p" true', ["1. time-p"]),
    ('time -- run "1. time-ign" true', ["1. time-ign"]),
    ('time -p -- run "1. time-p-ign" true', ["1. time-p-ign"]),
    ('time\t-p run "1. time-tab" true', ["1. time-tab"]),
    ('true; time -p run "1. time-after-separator" true',
     ["1. time-after-separator"]),
    ('if time -p run "1. time-in-if" true; then :; fi', ["1. time-in-if"]),
    ('time -p ! run "1. time-then-bang" true', ["1. time-then-bang"]),
    ('! time -p run "1. bang-then-time" true', ["1. bang-then-time"]),
    ('time -p MODE=ci run "1. time-then-assignment" true',
     ["1. time-then-assignment"]),
    ('time -p >/dev/null run "1. time-then-redirect" true',
     ["1. time-then-redirect"]),
    ('echo $(time -p run "1. time-in-subst" true)', ["1. time-in-subst"]),
    ('{ time -p run "1. time-in-group" true; }', ["1. time-in-group"]),
    # …and the words that are NOT options, each of which bash makes the
    # COMMAND instead, so no gate runs and none may be reported.
    ('time -- -p run "1. fake" true', []),
    ('time -p -p run "1. fake" true', []),
    ('time -p -- -- run "1. fake" true', []),
    ('time -pv run "1. fake" true', []),
    ('time -x run "1. fake" true', []),
    ('time - run "1. fake" true', []),
    ('time --p run "1. fake" true', []),
    ('time "-p" run "1. fake" true', []),
    ('time \\-p run "1. fake" true', []),
    # The option is anchored to `time`: loose in the chain it would have
    # invented a PHANTOM out of every ordinary `-p` argument.
    ('foo -p run "1. fake" true', []),
    ('echo -p run "1. fake" true', []),
    ('timeout -p run "1. fake" true', []),
    # `time` in an ARGUMENT is an ordinary word and opens no command position.
    ('echo time -p run "1. fake" true', []),
    # The lexer half of the same rule. With `-p` read as an ordinary word the
    # command-position flag was cleared, `case` was not recognised, no marker
    # was pushed, and the pattern's `)` popped the substitution — a PHANTOM
    # for a word bash passes to `echo`, and a MISS for the real gate beside
    # it. Round thirty's defect, reached through `time`.
    ('echo $(time -p case a in a) run "1. time-case-in-subst" true;; esac)',
     ["1. time-case-in-subst"]),
    ('echo $(time -p case a in a) :;; esac) run "1. fake" true', []),
    # `function` is the other reserved word that is not followed by a command:
    # its NAME comes first, and the body's `{` was then reachable from no
    # boundary at all. Every cell measured against bash. The positives were
    # invisible in BOTH directions before this rule — neither runnable nor
    # unreadable — so a local gate written in this supported spelling could
    # have no CI counterpart while lockstep reported success.
    ('function checks { run "1. function-brace" true; }; checks',
     ["1. function-brace"]),
    ('function checks  {  run "1. function-blanks" true; }; checks',
     ["1. function-blanks"]),
    ('function checks\t{ run "1. function-tab" true; }; checks',
     ["1. function-tab"]),
    ('echo $(function checks { run "1. function-in-subst" true; }; checks)',
     ["1. function-in-subst"]),
    ('true; function checks { run "1. function-after-separator" true; }; checks',
     ["1. function-after-separator"]),
    ('if function checks { run "1. function-in-if" true; }; then checks; fi',
     ["1. function-in-if"]),
    # …and the three spellings that read ALREADY, because each puts a real
    # boundary — a `(` or a newline — between the name and the body. They are
    # here so the new rule cannot be narrowed to them by accident.
    ('function checks() { run "1. function-parens" true; }; checks',
     ["1. function-parens"]),
    ('function checks\n{\nrun "1. function-newline-brace" true\n}\nchecks',
     ["1. function-newline-brace"]),
    ('function checks ( run "1. function-subshell-body" true ); checks',
     ["1. function-subshell-body"]),
    # A blank after the NAME and after the `{` is bash's own rule, not a
    # convenience: both of these are SYNTAX ERRORS, as is a newline between
    # `function` and the name (measured).
    ('function f {run "1. fake" true; }; f', []),
    # …while a `{` INSIDE the name is legal and its gate must still read, which
    # is what stops the rule being narrowed to names without one.
    ('function f{g { run "1. brace-in-name" true; }; f{g', ["1. brace-in-name"]),
    ('function\nchecks { run "1. fake" true; }; checks', []),
    # A word merely STARTING with `function` is not the reserved word, and one
    # in an ARGUMENT opens no command position.
    ('functional checks { run "1. fake" true; }', []),
    ('echo function checks { run "1. fake" true; }', []),
    # A name bash refuses as an identifier defines NOTHING, so its body never
    # runs and no gate may be reported: a `$`, a quoted name and an escaped
    # one are each "not a valid identifier" (measured).
    ('x=1; function f$x { run "1. fake" true; }; f', []),
    ('function "f g" { run "1. fake" true; }; "f g"', []),
    ('function f\\ g { run "1. fake" true; }', []),
    # The lexer half of the same rule, which fails in BOTH directions. A name
    # is not a reserved word however it is spelled, so `function case` must
    # push no marker — it pushed one that was never popped, the substitution's
    # own closer stopped being one, and the label after it read as a gate for
    # a word bash passes to `echo`. And the command position SURVIVES the
    # name, so the body's `{` opens one: without that a `case` inside the body
    # went unrecognised and its pattern's `)` popped the substitution — the
    # same phantom by the opposite route. Round thirty's defect, reached
    # through `function`.
    ('echo $(function case { :; }; printf x) run "1. fake" true', []),
    ('echo $(function f { case a in a) :;; esac; }) run "1. fake" true', []),
    ('echo $(function f { case a in a) run "1. function-case-in-body" true;; esac; }; f)',
     ["1. function-case-in-body"]),
    # A brace is legal ANYWHERE in a function's name, and the brace branch in
    # the lexer sits above the word-start logic, so it answered first: the
    # command position was cleared, the body's `case` went unrecognised, and
    # its pattern's `)` popped the enclosing substitution. Four positives, each
    # measured against bash — Codex's own spelling, a brace in the MIDDLE of
    # the name, one at its end, and the LATENT flag, which stayed armed and ate
    # the next command word as a name one statement later.
    ('echo $(function {f { case a in a) run "1. function-brace-name" true;; esac; }; {f)',
     ["1. function-brace-name"]),
    ('echo $(function f{g { case a in a) run "1. function-brace-midname" true;; esac; }; f{g)',
     ["1. function-brace-midname"]),
    ('echo $(function f} { case a in a) run "1. function-brace-endname" true;; esac; }; f})',
     ["1. function-brace-endname"]),
    ('echo $(function {f { :; }; case a in a) run "1. function-brace-latent" true;; esac)',
     ["1. function-brace-latent"]),
    ('function {f { run "1. function-brace-name-body" true; }; {f',
     ["1. function-brace-name-body"]),
    # …and their mirrors, each a word bash passes to `echo`.
    ('echo $(function {f { case a in a) :;; esac; }) run "1. fake" true', []),
    ('echo $(function f{g { case a in a) :;; esac; }) run "1. fake" true', []),
    ('echo $(function {f { :; }; case a in a) :;; esac) run "1. fake" true', []),
    # The two paren spellings read ALREADY — the `(` ends the name word for
    # them — and are here because the word-scoped rule must not break them:
    # the name ends at the first word-break character wherever it is handled,
    # and these two are taken by the parenthesis branch rather than the last.
    ('echo $(function f(){ case a in a) run "1. function-paren-tight" true;; esac; }; f)',
     ["1. function-paren-tight"]),
    ('echo $(function f() { case a in a) run "1. function-paren-spaced" true;; esac; }; f)',
     ["1. function-paren-spaced"]),
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
    # A REDIRECTION prefix, read off bash's operator set. The first five were
    # invisible in BOTH directions before, the next five are the ordinary
    # spelling with a SPACE before the target, and the last four are forms
    # that already read and must keep reading. Every expectation measured
    # against bash, with `run` appending to a file so a redirection under test
    # cannot steal the evidence — the first probe printed to stderr and `2>|`
    # redirected it away, which reads exactly like a gate that did not run.
    ('2>|g.err run "1. noclobber" true', ["1. noclobber"]),
    ('>|g.out run "1. noclobber-bare" true', ["1. noclobber-bare"]),
    ('{fd}>g.fd run "1. fd-variable" true', ["1. fd-variable"]),
    ('{fd}>|g.a run "1. fd-variable-noclobber" true', ["1. fd-variable-noclobber"]),
    ('{fd}<<<hello run "1. fd-variable-herestring" true', ["1. fd-variable-herestring"]),
    ('> g.a run "1. redirect-space" true', ["1. redirect-space"]),
    ('2> g.a run "1. fd-redirect-space" true', ["1. fd-redirect-space"]),
    ('>> g.a run "1. append-space" true', ["1. append-space"]),
    ('< g.in run "1. stdin-space" true', ["1. stdin-space"]),
    ('>& 2 run "1. dup-space" true', ["1. dup-space"]),
    ('&>g.both run "1. amp-redirect" true', ["1. amp-redirect"]),
    ('<<<hello run "1. herestring" true', ["1. herestring"]),
    ('<>g.rw run "1. read-write" true', ["1. read-write"]),
    ('>&- run "1. close-fd" true', ["1. close-fd"]),
    ('2>g.e >g.o run "1. two-redirects" true', ["1. two-redirects"]),
    ('MODE=x 2>|g.err run "1. assign-then-noclobber" true',
     ["1. assign-then-noclobber"]),
    ('2>|g.err MODE=x run "1. noclobber-then-assign" true',
     ["1. noclobber-then-assign"]),
    ('<<EOF run "1. heredoc-prefix" true\nbody\nEOF\n', ["1. heredoc-prefix"]),
    # …and the four that are NOT a gate. A redirection's target word is
    # required, so in the first three `run` IS the file and bash then tries to
    # execute the label; the fourth attaches nothing, and bash runs a command
    # called `2` (all measured, no gate in any of them).
    ('> run "1. phantom" true', []),
    ('2> run "1. phantom" true', []),
    ('>| run "1. phantom" true', []),
    ('2 >|g.a run "1. phantom" true', []),
    # Two more that bash runs no gate for, both PHANTOMS on the previous head
    # and reached by their own mechanisms rather than by the empty target.
    # `>>|` is a bash syntax error outright, and `$(>|case)` is a substitution
    # whose redirection target word ENDS at the closer — a word outside one
    # continues through it (round 29) and a word that began inside it cannot.
    ('echo x >>| run "1. phantom" true', []),
    ('echo $(>|case) run "1. phantom" true', []),
    # An ESCAPED metacharacter is DATA, so it is not a command boundary.
    # Bash runs only `echo` for every one of these (measured) while the
    # reader returned the label — a PHANTOM local gate, which satisfies a
    # ci.yml mapping and keeps the reverse check happy after the real gate
    # has been deleted (Codex on PR #94, who named the `;`; the general
    # claim is every character in `_BOUNDARY_CHARS`).
    ('echo x\\; run "1. phantom" true', []),
    ('echo x\\| run "1. phantom" true', []),
    ('echo x\\& run "1. phantom" true', []),
    ('echo x\\( run "1. phantom" true', []),
    ('echo x\\) run "1. phantom" true', []),
    # A leading one is the command NAME: bash reports `;: command not found`
    # and runs no gate (measured).
    ('\\; run "1. phantom" true', []),
    # The same inside a substitution, inside a backtick, and as a redirection
    # TARGET word — the constructs the review did not name, each reached by
    # the same escape branch and each a phantom on the previous head. The
    # redirection row runs a command called `f;` and no gate (measured).
    ('echo $(printf a\\; run "1. phantom" true)', []),
    ('echo `printf a\\; run "1. phantom" true`', []),
    ('> /dev/null f\\; run "1. phantom" true', []),
    # The MIRROR, which is what stops the fix being "an escape hides
    # everything": an escaped BACKSLASH is a complete pair and the separator
    # after it is real, a backslash inside SINGLE quotes is literal with no
    # escape at all, one inside double quotes is masked with the rest of the
    # word, and an escaped separator in the middle of a word leaves a later
    # real one alone. Bash runs the gate in all four (measured).
    ('echo x\\\\; run "1. escaped-backslash-then-real" true',
     ["1. escaped-backslash-then-real"]),
    ("echo 'x\\'; run \"1. single-quoted-backslash\" true",
     ["1. single-quoted-backslash"]),
    ('echo "x\\;" ; run "1. double-quoted-escape" true',
     ["1. double-quoted-escape"]),
    ('echo x\\;y; run "1. escape-then-real" true', ["1. escape-then-real"]),
    # A nested backtick's delimiter is recognised by PARITY. Bash reads a
    # backtick body ONCE — turning an escape pair into one backslash and
    # `` \` `` into a bare backtick — and then parses the RESULT as shell, so a
    # run of N backslashes before an inner backtick opens a nested
    # substitution only when N % 4 == 1. Measured across N = 0..8: the inner
    # command runs at 1 and 5 and at no other length, because 3 and 7 leave
    # an ODD number of backslashes in front of the backtick after the first
    # pass and the second pass then reads them as escaping it. Three
    # backslashes was a PHANTOM local gate on the previous head (Codex on
    # PR #94); seven is the next period, and the two positives are what stop
    # the rule becoming "a long run never opens".
    ('result=`echo \\\\\\`run "1. phantom" true\\\\\\``', []),
    ('result=`echo \\\\\\\\\\\\\\`run "1. phantom" true\\\\\\\\\\\\\\``', []),
    ('result=`echo \\\\\\\\\\`run "1. four-period" true\\\\\\\\\\``', ['1. four-period']),
    ('result=`echo \\`run "1. mixed-period" true\\\\\\\\\\``', ['1. mixed-period']),
    ('run() {\n  :\n}', []),
    # `for` and `select` take a NAME, `case` takes a SUBJECT word and `in`
    # takes PATTERNS — none of them is a command, so none opens a command
    # position. Reading them as one was a PHANTOM on files bash parses and
    # runs: the name `case` was looked up, found reserved and pushed a case
    # marker, which then consumed the substitution's own closer as a pattern
    # `)` and made it a command boundary, inventing a gate out of a word bash
    # passes to `echo` (measured, Codex on PR #94, who named `for`/`select`).
    # A phantom label satisfies a ci.yml mapping and keeps the reverse check
    # happy after the real local gate has been deleted.
    ('echo $(for case in x; do :; done) run "1. fake" true', []),
    ('echo $(select case in x; do :; done) run "1. fake" true', []),
    ('echo $(case case in *) :;; esac) run "1. fake" true', []),
    # The subject spelled `esac` POPS the marker its own `case` pushed, which
    # is the same phantom reached from the other side.
    ('echo $(case esac in *) :;; esac) run "1. fake" true', []),
    # THE WORD LIST, which is what refutes the remedy Codex proposed — to track
    # a name position after `for` the way the lexer tracks one after
    # `function`, where the command position SURVIVES the name because the
    # body's `{` needs it. Measured, that closes the row above and opens this
    # one: with the position surviving, `in` is then recognised as reserved,
    # the position carries into the word list, and `case` there pushes the
    # spurious marker instead. A `for` name is not a `function` name.
    ('echo $(for x in case; do :; done) run "1. fake" true', []),
    ('echo $(for\tcase in x; do :; done) run "1. fake" true', []),
    ('echo $(echo $(for case in x; do :; done) ) run "1. fake" true', []),
    # The other direction: none of the four may stop a real gate reading. The
    # `((` head is here because `for` no longer opens a command position and
    # the arithmetic branch must not have been depending on one, and the
    # `coproc` row because `coproc` DOES precede a command (`coproc run "…"
    # true` invokes the gate, measured) and must stay in the chain.
    ('for x in a; do run "1. for-body" true; done', ["1. for-body"]),
    ('for case in x; do run "1. for-case-body" true; done', ["1. for-case-body"]),
    ('for ((i=0;i<1;i++)); do run "1. for-arith-head" true; done',
     ["1. for-arith-head"]),
    ('case a in a) run "1. case-body" true;; esac', ["1. case-body"]),
    ('for case; do :; done; run "1. for-noin" true', ["1. for-noin"]),
    ('coproc run "1. coproc-command" true\nwait', ["1. coproc-command"]),
    # `coproc [NAME] command`: the word after `coproc` is a NAME when a
    # compound command follows it, and the body runs. The chain read the name
    # as the command and stopped, so the body's `{` was reachable from no
    # boundary: `coproc checks { run "…" true; }` — which bash runs — was read
    # by NEITHER reader (Codex, PR #94), and so were the tab, the redirection
    # after the group, an identifier with `_` and a digit, a quoted name, a
    # `$NAME`, the glued `(`, and a gate at the HEAD of a named `until` or
    # `if` (all measured against bash 5.2, and all missed by the shipped
    # reader). A gate INSIDE a substitution is real, so the coproc there
    # reads too.
    ('coproc checks { run "1. coproc-name-group" true; }; wait',
     ["1. coproc-name-group"]),
    ('coproc checks\t{ run "1. coproc-name-tab" true; }; wait',
     ["1. coproc-name-tab"]),
    ('coproc checks { run "1. coproc-name-redirect" true; } </dev/null; wait',
     ["1. coproc-name-redirect"]),
    ('coproc my_checks2 { run "1. coproc-name-ident" true; }; wait',
     ["1. coproc-name-ident"]),
    ('coproc "checks" { run "1. coproc-name-quoted" true; }; wait',
     ["1. coproc-name-quoted"]),
    ('N=checks; coproc $N { run "1. coproc-name-expanded" true; }; wait',
     ["1. coproc-name-expanded"]),
    ('coproc checks( run "1. coproc-name-glued-paren" true ); wait',
     ["1. coproc-name-glued-paren"]),
    ('coproc checks until run "1. coproc-name-until-head" true; do break; done; wait',
     ["1. coproc-name-until-head"]),
    ('coproc checks if run "1. coproc-name-if-head" true; then :; fi; wait',
     ["1. coproc-name-if-head"]),
    ('echo $(coproc checks { run "1. coproc-name-in-subst" true; }); wait',
     ["1. coproc-name-in-subst"]),
    # The name may itself be `run`: the coprocess is called `run` and the body
    # invokes the gate once. Read as a command, the name was an unlabelled
    # invocation and `shell_unreadable_calls` refused a healthy file by name —
    # that direction is pinned in the unreadable matrix below.
    ('coproc run { run "1. coproc-name-is-run" true; }; wait',
     ["1. coproc-name-is-run"]),
    # The LEXER's half: the command position survives the name, so the body's
    # `{` opens one and a `case` inside it is recognised. Without that the
    # pattern's `)` popped the enclosing substitution and the tail became
    # top-level — a PHANTOM for a word bash passes to `echo` (measured; round
    # thirty's defect, reached through `coproc`). The chain alone cannot see
    # this row, and the lexer alone cannot see the rows above.
    ('echo $(coproc checks { case a in a) :;; esac; }) run "1. fake" true', []),
    ('coproc checks { case a in a) run "1. coproc-name-case-body" true;; esac; }; wait',
     ["1. coproc-name-case-body"]),
    # The other direction, which is what stops the fix becoming "every word
    # after `coproc` is a name": a word followed by anything but a compound
    # command is the COMMAND, and `run` after it is that command's argument —
    # `coproc checks run "1. fake" true` runs a command called `checks`
    # (measured), and so do the `time` and assignment-prefix spellings. A
    # newline after the name ends the question: `coproc checks`⏎`{ … }` is a
    # coproc of `checks` and a group in the main shell, whose gate is real.
    ('coproc checks run "1. fake" true; wait', []),
    ('coproc checks time run "1. fake" true; wait', []),
    ('coproc checks X=1 run "1. fake" true; wait', []),
    ('echo $(coproc checks { :; }) run "1. fake" true; wait', []),
    ('echo coproc checks { run "1. fake" true', []),
    ('coproc checks\n{ run "1. coproc-name-newline-group" true; }; wait',
     ["1. coproc-name-newline-group"]),
    ('coproc checks\nrun "1. coproc-name-newline-run" true; wait',
     ["1. coproc-name-newline-run"]),
    # The name is a WORD, and a word may span a substitution: each of these
    # expands to the identifier `checks` and runs its body (measured, bash
    # 5.2), and a character class that stopped at the substitution's `(` read
    # none of them (Codex, PR #94). The chain reads the name as a skeleton
    # word and the lexer reads it to its END, through the substitution, the
    # backtick and the quote — the `(` of a `$(` is the word continuing, not
    # ending, and the blank inside `printf checks` is at a deeper nesting.
    ('coproc $(printf checks) { run "1. coproc-subst-name" true; }; wait',
     ["1. coproc-subst-name"]),
    ('coproc `printf checks` { run "1. coproc-backtick-name" true; }; wait',
     ["1. coproc-backtick-name"]),
    ('coproc "$(printf checks)" { run "1. coproc-quoted-subst-name" true; }; wait',
     ["1. coproc-quoted-subst-name"]),
    ('coproc checks$(printf 2) { run "1. coproc-glued-subst-name" true; }; wait',
     ["1. coproc-glued-subst-name"]),
    ('coproc $(echo $(printf checks)) { run "1. coproc-nested-subst-name" true; }; wait',
     ["1. coproc-nested-subst-name"]),
    ('coproc $(printf a; printf b) { run "1. coproc-subst-name-semicolon" true; }; wait',
     ["1. coproc-subst-name-semicolon"]),
    ('coproc $(printf checks) until run "1. coproc-subst-name-until-head" true; do break; done; wait',
     ["1. coproc-subst-name-until-head"]),
    ('coproc $(printf run) { run "1. coproc-subst-name-run" true; }; wait',
     ["1. coproc-subst-name-run"]),
    # A gate INSIDE the name's substitution is real and reads from its own
    # boundary, whatever the name turns out to be.
    ('coproc $(run "1. coproc-gate-in-name" true >&2; printf checks) { :; }; wait',
     ["1. coproc-gate-in-name"]),
    # The LEXER's half again, for each way a name can carry a blank or a
    # quote inside it: without the depth, backtick and quote guards the word
    # ended early, no name was read, the body's `case` went unrecognised and
    # its pattern's `)` popped the enclosing substitution — the phantom.
    ('echo $(coproc $(printf c) { case a in a) :;; esac; }) run "1. fake" true', []),
    ('echo $(coproc `printf c` { case a in a) :;; esac; }) run "1. fake" true', []),
    ('echo $(coproc "$(printf c)" { case a in a) :;; esac; }) run "1. fake" true', []),
    ('echo $(coproc checks$(printf 2) { case a in a) :;; esac; }) run "1. fake" true', []),
    ('coproc $(printf c) { case a in a) run "1. coproc-subst-name-case-body" true;; esac; }; wait',
     ["1. coproc-subst-name-case-body"]),
    # …and the other direction holds for a substitution name too: followed by
    # a simple word it is the COMMAND, a coproc inside a substitution that
    # runs nothing is still nothing, and a newline still ends the question.
    ('coproc $(printf checks) run "1. fake" true; wait', []),
    ('echo $(coproc $(printf c) { :; }) run "1. fake" true; wait', []),
    ('coproc $(printf checks)\n{ run "1. coproc-subst-name-newline-group" true; }; wait',
     ["1. coproc-subst-name-newline-group"]),
    # A case pattern may carry an OPTIONAL leading parenthesis, which is not a
    # subshell. Reading it as one left a command position open, so a pattern
    # spelled `case` or `esac` was taken for the reserved word: the marker it
    # pushed swallowed the pattern's own closer, the leading paren went
    # unpopped, and the ENCLOSING substitution's closer became a boundary —
    # a PHANTOM gate for a word bash passes to `echo` (measured, both).
    ('echo $(case case in (case) :;; esac) run "1. fake" true', []),
    ('echo $(case x in (esac) :;; esac) run "1. fake" true', []),
    # The other direction: a clause BODY is ordinary shell, so neither the
    # leading paren nor the alternation rule may cost it a gate. A subshell in
    # a body runs commands, and so does one after a single `;` — which is why
    # only `;;`, `;&` and `;;&` flip the clause back to its pattern half.
    ('case a in (a) run "1. case-lparen-body" true;; esac',
     ["1. case-lparen-body"]),
    ('case a in a) (run "1. case-body-subshell" true);; esac',
     ["1. case-body-subshell"]),
    ('case a in a) :; (run "1. case-body-semi-subshell" true);; esac',
     ["1. case-body-semi-subshell"]),
    ('case a in (a) (run "1. case-lparen-subshell" true);; esac',
     ["1. case-lparen-subshell"]),
    ('case a in (a) case b in (b) run "1. case-lparen-nested" true;; esac;; esac',
     ["1. case-lparen-nested"]),
    ('case a in (a) :;& (a) run "1. case-semi-amp" true;; esac',
     ["1. case-semi-amp"]),
    ('case a in (a) :;;& (a) run "1. case-semisemi-amp" true;; esac',
     ["1. case-semisemi-amp"]),
    ('case a in b) :;; a) (run "1. case-second-clause-subshell" true);; esac',
     ["1. case-second-clause-subshell"]),
    ('case a in a) printf x | run "1. case-body-pipe" true;; esac',
     ["1. case-body-pipe"]),
    ('case a in (a) printf x | run "1. case-lparen-pipe" true;; esac',
     ["1. case-lparen-pipe"]),
    ('case a in a|b) run "1. case-alt-body" true;; esac', ["1. case-alt-body"]),
    ('case a in b) :;; a) printf x | run "1. case-second-pipe" true;; esac',
     ["1. case-second-pipe"]),
    # A STATED RESIDUAL, pinned so a future change to it is deliberate. `esac`
    # is the one pattern word bash's own `$( … )` scanner mis-reads: measured
    # across all nineteen reserved words and two ordinary ones, `$(case X in
    # (W) run '…' true;; esac)` invokes the gate for every W except `esac`,
    # where the substitution ends early and bash ECHOES the rest instead. The
    # same line OUTSIDE a substitution runs it (measured), so the two contexts
    # disagree and modelling that would mean modelling a parser quirk rather
    # than a grammar. This reader answers what the source says, which is a
    # PHANTOM in that one shape — and it is the shape the leading-paren fix
    # moved, from silent-by-accident to reported.
    ('echo $(case a in (esac) run "1. esac-pattern-residual" true;; esac)',
     ["1. esac-pattern-residual"]),
    # The BACKTICK spelling of a substitution, where the same rules must hold:
    # the lexer never opened a command position there, so `case` inside one was
    # not recognised and neither pattern rule could fire.
    ('echo `case a in a|run) run "1. bt-alt-body" true;; esac`',
     ["1. bt-alt-body"]),
    ('echo `case a in (a) run "1. bt-lparen-body" true;; esac`',
     ["1. bt-lparen-body"]),
    ('echo `printf x | run "1. bt-pipe" true`', ["1. bt-pipe"]),
    # An EXTGLOB GROUP — `?(`, `*(`, `+(`, `@(`, `!(` — is part of a WORD, so
    # its closer is not a boundary. Codex named the case PATTERN, where the
    # early `)` made `shell_unreadable_calls` refuse a healthy clause; the
    # sibling CONSTRUCT is the worse direction and is what these rows are
    # about: in an ORDINARY word the closer opened a command position, so
    # `echo @(x) run "1. fake" true` passed every word to `echo` and ran
    # NOTHING (measured) while this reader returned the label — a PHANTOM
    # gate, which satisfies a ci.yml mapping and keeps the reverse check happy
    # after the real local gate has been deleted.
    ('shopt -s extglob\necho @(x) run "1. fake" true', []),
    ('shopt -s extglob\necho ?(x) run "1. fake" true', []),
    ('shopt -s extglob\necho *(x) run "1. fake" true', []),
    ('shopt -s extglob\necho +(x) run "1. fake" true', []),
    ('shopt -s extglob\ncase a in a) echo @(x) run "1. fake" true;; esac', []),
    # `|`, `;`, `&` and a newline INSIDE a group are pattern text: each of
    # these prints itself and invokes nothing (measured).
    ('shopt -s extglob\necho @(a|run "1. fake" true)', []),
    ('shopt -s extglob\necho @(a;run "1. fake" true)', []),
    ('shopt -s extglob\necho @(a&run "1. fake" true)', []),
    ('shopt -s extglob\necho @(a\nrun "1. fake" true)', []),
    # The other direction — a real gate in the clause BODY must still read,
    # for every operator, with an alternation, nested, behind the optional
    # leading parenthesis, in a second clause, and inside both spellings of a
    # substitution.
    ('shopt -s extglob\ncase xrun in @(x)run) run "1. eg-at" true;; esac',
     ["1. eg-at"]),
    ('shopt -s extglob\ncase xrun in ?(x)run) run "1. eg-q" true;; esac',
     ["1. eg-q"]),
    ('shopt -s extglob\ncase xrun in *(x)run) run "1. eg-star" true;; esac',
     ["1. eg-star"]),
    ('shopt -s extglob\ncase xrun in +(x)run) run "1. eg-plus" true;; esac',
     ["1. eg-plus"]),
    ('shopt -s extglob\ncase yrun in !(x)run) run "1. eg-bang" true;; esac',
     ["1. eg-bang"]),
    ('shopt -s extglob\ncase xrun in @(x|y)run) run "1. eg-alt" true;; esac',
     ["1. eg-alt"]),
    ('shopt -s extglob\ncase xrun in @(@(x))run) run "1. eg-nested" true;; esac',
     ["1. eg-nested"]),
    ('shopt -s extglob\ncase xrun in (@(x)run) run "1. eg-lparen" true;; esac',
     ["1. eg-lparen"]),
    ('shopt -s extglob\ncase zrun in @(x)run) :;; @(z)run) run "1. eg-second" true;; esac',
     ["1. eg-second"]),
    ('shopt -s extglob\necho $(case xrun in @(x)run) run "1. eg-subst" true;; esac)',
     ["1. eg-subst"]),
    ('shopt -s extglob\necho `case xrun in @(x)run) run "1. eg-bt" true;; esac`',
     ["1. eg-bt"]),
    # The body of a group stays LIVE rather than wholly masked, because a
    # substitution inside one really does run (measured, both spellings).
    # Masking it would be a MISS — the worse direction.
    ('shopt -s extglob\necho @($(run "1. eg-inner" true; printf x))',
     ["1. eg-inner"]),
    ('shopt -s extglob\necho @(`run "1. eg-inner-bt" true; printf x`)',
     ["1. eg-inner-bt"]),
    # `!` counts as an extglob operator only inside a case PATTERN, because
    # that is where its reading is decidable. Elsewhere it keeps the SUBSHELL
    # reading it has always had, and these three are what that protects:
    # `!(run "…" true)` at a command position negates a subshell and really
    # invokes the gate (measured, exit 1 from the negation), so reading it as
    # a glob would LOSE a real gate. The sabotage that adds `!` to the
    # unconditional set turns exactly these red.
    ('!(run "1. bang-subshell" true)', ["1. bang-subshell"]),
    ('true; !(run "1. bang-semi-subshell" true)', ["1. bang-semi-subshell"]),
    ('if !(run "1. bang-if-subshell" true); then :; fi',
     ["1. bang-if-subshell"]),
    ('!(true)\nrun "1. bang-cmd" true', ["1. bang-cmd"]),
    ('shopt -s extglob\n!(true)\nrun "1. bang-cmd-eg" true', ["1. bang-cmd-eg"]),
    ('shopt -s extglob\ntrue && !(false)\nrun "1. bang-and" true', ["1. bang-and"]),
    ('shopt -s extglob\necho !(zzz) ; run "1. bang-arg" true', ["1. bang-arg"]),
    # THE RESIDUAL, pinned rather than left to be rediscovered: with extglob
    # ON, `!(zzz)` in an ARGUMENT is one glob word and bash passes every word
    # here to `echo`, running nothing — so this label is a PHANTOM. That
    # position is decidable (a subshell is not a legal argument: `echo (x)` is
    # a syntax error, measured), but reading it would need lexer state the
    # command-position half above cannot use, and the phantom is pre-existing
    # rather than introduced by this round. Changing this row is a decision,
    # not a bug fix.
    ('shopt -s extglob\necho !(zzz) run "1. fake" true', ["1. fake"]),
    # Inside a PATTERN `!` is decidable and does count — and the `"glob"` half
    # of that tuple is what this row pins: with only `"case-pat"` there, the
    # `(` of a group nested inside another falls through to a real subshell
    # and its closer becomes a boundary again, so `echo @(!(x)run "1. fake"
    # true)` — one literal word bash passes to `echo`, running nothing
    # (measured) — reported the label.
    ('shopt -s extglob\necho @(!(x)run "1. fake" true)', []),
    ('shopt -s extglob\ncase yrun in @(!(x))run) run "1. nested-bang" true;; esac',
     ["1. nested-bang"]),
    ('shopt -s extglob\n@(zzz) ; run "1. cmd-at" true', ["1. cmd-at"]),
    # A `#` inside an extglob group is PATTERN TEXT, never a comment, because
    # the group is inside a word. Every branch set `at_word_start` from the
    # character's own shape, so `|`, `;`, `&`, a newline and a SPACE each left
    # it true inside a group and the comment branch then ate the group's
    # closing `)` and the rest of the line — both readers lost the gate after
    # it, a MISS in both directions. Codex named the `|`; the other four
    # spellings, the nested group and the case-pattern forms came from
    # measuring the general claim.
    ('shopt -s extglob\necho @(a|#foo)\nrun "1. eg-hash-pipe" true',
     ["1. eg-hash-pipe"]),
    ('shopt -s extglob\necho @(a;#foo)\nrun "1. eg-hash-semi" true',
     ["1. eg-hash-semi"]),
    ('shopt -s extglob\necho @(a&#foo)\nrun "1. eg-hash-amp" true',
     ["1. eg-hash-amp"]),
    ('shopt -s extglob\necho @(a\n#foo)\nrun "1. eg-hash-nl" true',
     ["1. eg-hash-nl"]),
    # The SPACE is why the rule is cleared for the GROUP rather than beside
    # each masked separator: a space is a word break that reaches the final
    # branch and is not one of them, so an enumeration would have missed it.
    ('shopt -s extglob\necho @(a #foo)\nrun "1. eg-hash-space" true',
     ["1. eg-hash-space"]),
    ('shopt -s extglob\necho @(@(a)|#foo)\nrun "1. eg-hash-nested" true',
     ["1. eg-hash-nested"]),
    ('shopt -s extglob\ncase "a" in @(a|#foo)) :;; esac\nrun "1. eg-hash-pat" true',
     ["1. eg-hash-pat"]),
    ('shopt -s extglob\ncase "a" in (@(a|#foo)) :;; esac\nrun "1. eg-hash-pat-lparen" true',
     ["1. eg-hash-pat-lparen"]),
    ('shopt -s extglob\necho @(a|#foo); run "1. eg-hash-inline" true',
     ["1. eg-hash-inline"]),
    # The other direction, which is what stops the fix becoming "mask the whole
    # group": a substitution inside a group is real shell, pushes its own
    # entry, and a `#` there IS a comment (measured, both spellings). A comment
    # AFTER a closed group still works too.
    ('shopt -s extglob\necho @($(printf a  # run "1. fake" true\n))\nrun "1. eg-subst-comment" true',
     ["1. eg-subst-comment"]),
    ('shopt -s extglob\necho @(`printf a  # run "1. fake" true\n`)\nrun "1. eg-bt-comment" true',
     ["1. eg-bt-comment"]),
    # This one carries a BOUNDARY inside the comment, which is what makes the
    # scope of the rule load-bearing rather than merely stated: applied to any
    # open region instead of the innermost one, the `#` stops being a comment
    # inside the nested substitution, the `;` in its text becomes real, and the
    # reader invents `1. fake` — a PHANTOM out of commented-out prose.
    ('shopt -s extglob\necho @($(printf a; # x; run "1. fake" true\nprintf b))\nrun "1. eg-subst-comment2" true',
     ["1. eg-subst-comment2"]),
    ('shopt -s extglob\necho @(a|b) # run "1. fake" true\nrun "1. eg-after-group" true',
     ["1. eg-after-group"]),
    # And no phantom: a word after a group is an argument, not a command.
    ('shopt -s extglob\necho @(a|#foo) run "1. fake" true', []),
    ('shopt -s extglob\necho @(a #foo) run "1. fake" true', []),
    # THE RESIDUAL, the same one round fifty-two pinned in its other shape:
    # `!(` outside a case pattern keeps the SUBSHELL reading, so the `#` inside
    # it is at a command position and opens a comment that eats the closer.
    # bash runs this gate and the reader misses it. Deciding it needs to tell a
    # command position from an argument at the `(`, and `at_cmd` is false in
    # BOTH (a preceding word clears it, and `_BANG` requires a blank so `!`
    # never sets it) — which is exactly why round fifty-two's `at_cmd`
    # exception never fired. Changing this row is a decision, not a bug fix.
    ('shopt -s extglob\necho !(a|#foo); run "1. fake" true', []),
)


# The UNREADABLE reader's own two rows. It answers a different question from
# the label reader, so the spelling matrix above cannot speak for it — and its
# failure direction is the worse one: off the raw text `echo 'note; run'` was
# reported as an unreadable gate (measured), a gate red on a healthy tree.
_UNREADABLE_SPELLINGS: tuple[tuple[str, list[str]], ...] = (
    # A coprocess NAME is not an invocation: `coproc run { run "…" true; }`
    # names the coprocess `run` and the shipped chain refused it by name — a
    # gate red on a healthy tree (measured; Codex, PR #94, the finding's
    # other direction). An unreadable call INSIDE a named body is refused,
    # where before it was invisible; and the name question ends at a newline,
    # so `coproc run`⏎ is a coproc of an UNLABELLED `run`, refused as such.
    # `coproc checks run` is a command called `checks`, and its argument is
    # not a call.
    ('coproc run { run "1. x" true; }; wait', []),
    ('coproc checks { run $LABEL true; }; wait', ["run $LABEL true"]),
    ('coproc checks { skip_gate $LABEL; }; wait', ["skip_gate $LABEL"]),
    ('coproc run\n{ run "1. x" true; }; wait', ["run"]),
    ('coproc checks run; wait', []),
    # A substitution-spelled name: an unreadable call in its body is refused
    # (it was invisible), a `run` after it on the same line is the command's
    # argument, and one on the NEXT line is the main shell's unlabelled call.
    ('coproc $(printf checks) { run $LABEL true; }; wait', ["run $LABEL true"]),
    ('coproc $(printf checks) run; wait', []),
    ('coproc $(printf checks)\nrun', ["run"]),
    # A case PATTERN is not a command, so neither its optional leading
    # parenthesis nor its alternation `|` is a boundary. Both were, so an
    # ordinary pattern spelled like the gate helper was refused BY NAME —
    # `case x in (run) :;; esac` invokes nothing (measured) and this reader
    # reported `run) :`: a gate RED ON A HEALTHY TREE, the worst shape this
    # gate can take. Codex named the leading paren; the alternation `|` is the
    # same construct one character over and was red with and without it, on
    # the previous head as well (measured on both).
    ('case x in (run) :;; esac', []),
    ('case x in (skip_gate) :;; esac', []),
    ('case x in ( run ) :;; esac', []),
    ('case x in a) :;; (run) :;; esac', []),
    ('case x in\n(run) :;;\nesac', []),
    ('echo $(case x in (run) :;; esac) run "1. fake" true', []),
    ('case x in a|run) :;; esac', []),
    ('case x in (a|run) :;; esac', []),
    # An extglob group's closer is not the clause's, so it ends no pattern:
    # `shopt -s extglob` + `case xrun in @(x)run) :;; esac` invokes nothing
    # (measured) and this reader refused `run) :` — Codex's own example, and a
    # gate RED ON A HEALTHY TREE. The `skip_gate` spelling and both
    # substitution spellings are the same rule; the last three are the sibling
    # CONSTRUCT, where a group in an ORDINARY word did it too.
    ('shopt -s extglob\ncase xrun in @(x)run) :;; esac', []),
    ('shopt -s extglob\ncase xrun in (@(x)run) :;; esac', []),
    ('shopt -s extglob\ncase xrun in @(x|y)run) :;; esac', []),
    ('shopt -s extglob\ncase xskip_gate in @(x)skip_gate) :;; esac', []),
    ('shopt -s extglob\necho $(case xrun in @(x)run) :;; esac)', []),
    ('shopt -s extglob\necho `case xrun in @(x)run) :;; esac`', []),
    ('shopt -s extglob\necho @(x) run', []),
    ('shopt -s extglob\necho @(x) skip_gate', []),
    ('shopt -s extglob\necho @(a|run)', []),
    # `!` inside a pattern, which is where its reading is decidable: without
    # it in the set the `(` falls to the leading-parenthesis branch, the
    # clause flips to its body one `)` early, and this reader refuses a
    # healthy clause exactly as it did for the other four operators.
    ('shopt -s extglob\ncase yrun in !(x)run) :;; esac', []),
    ('shopt -s extglob\ncase yskip_gate in !(x)skip_gate) :;; esac', []),
    ('shopt -s extglob\ncase yrun in (!(x)run) :;; esac', []),
    # The sibling reader, where the same miss shows as a gate call this file
    # never sees at all: with the comment eating the group's closer, `run` on
    # the next line was reported by NEITHER reader.
    ('shopt -s extglob\necho @(a|#foo)\nrun', ["run"]),
    ('shopt -s extglob\necho @(a #foo)\nskip_gate', ["skip_gate"]),
    ('case x in a|skip_gate) :;; esac', []),
    ('echo `case x in (run) :;; esac`', []),
    ('echo `case x in a|run) :;; esac`', []),
    # A `for`/`select` loop's NAME, and a `case`'s SUBJECT, are words and not
    # invocations — and `run` is an ordinary name for one. `for run in a; do
    # :; done` is legal bash that invokes nothing, and the chain read the name
    # as a gate call whose label it could not parse, so this reader refused it
    # by name (`run in a`): a gate RED ON A HEALTHY TREE, the worst shape this
    # gate can take, and the same for `select`, for a `case` subject and for
    # the `skip_gate` spelling of each. Codex named the phantom in the lexer;
    # this is the same rule read by the other reader, in the other direction.
    ('for run in a; do :; done', []),
    ('select run in a; do :; done', []),
    ('case run in *) :;; esac', []),
    ('for skip_gate in a; do :; done', []),
    ('case skip_gate in *) :;; esac', []),
    ('for run in "a b"; do :; done', []),
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
    # A delimited `!` opens a command position, so an unreadable call behind
    # one is refused by name; glued, it is part of another command word and
    # there is no invocation to refuse.
    ('! run $label true', ['run $label true']),
    ('!run $label true', []),
    # `time`'s options open a command position, so an unreadable call behind
    # one is refused BY NAME rather than passed over — the other half of the
    # invisible-in-both-directions hole (Codex, PR #94).
    ('time -p run $label true', ['run $label true']),
    ('time -- run $label true', ['run $label true']),
    # …and a word that is NOT an option makes itself the command, so there is
    # no invocation to refuse.
    ('time -pv run $label true', []),
    # A gate inside a `function NAME { … }` body, for both words: the chain
    # reads them the same way, so one row each pins it.
    ('function checks { run $label true; }; checks', ['run $label true']),
    ('function checks { skip_gate $label; }; checks', ['skip_gate $label']),
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
    # The SIBLING reader, on the same escape rule and in the worse direction:
    # `echo x\; run` is an ordinary line bash invokes no gate in (measured)
    # and was reported as an unreadable gate INVOCATION — a gate RED ON A
    # HEALTHY TREE, the worst shape this log records. Codex named only the
    # label reader; this one shares `_find_commands` and therefore the defect.
    ('echo x\\; run', []),
    ('echo x\\; run $label true', []),
    # …while a real invocation after a real separator is still refused BY
    # NAME, so the rule is not "an escape hides everything".
    ('echo x\\;y; run $label true', ['run $label true']),
    # The redirection grammar belongs to both readers too.
    ('2>|g.err run bare', ['run bare']),
    ('> g.a run bare', ['run bare']),
    ('{fd}>g.fd run bare', ['run bare']),
    ('> run bare', []),    # The SIBLING reader on the parity rule: with the delimiters left
    # literal bash invokes nothing, so neither reader may report anything.
    ('result=`echo \\\\\\`run $label true\\\\\\``', []),
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
    # The escape branch's own inside-a-body path: BOTH characters masked, which
    # is what keeps the rule one sentence rather than two.
    ('cat <<EOF\nx\\; run "1. hd-esc" true\nEOF\n', '\\; run "1. hd-esc" true', True),
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


# The ESCAPE rule as an INVARIANT, for the reason the three body masks are
# invariants: the behavioural rows above pin the five characters in
# `_BOUNDARY_CHARS` and nothing else, so a `>`, a `"`, a `$` or a `#` reaching
# the skeleton raw is a rule no row can speak for — and enumerating the
# characters that must be masked is how the next one is missed (the
# `verify-photo-integrity.sh` lesson, which this file has now paid for twice).
# One rule instead: an escape pair is masked, wherever it is written.
#
# Read by the SAME checker as the three body masks, in the same
# `(source, fragment, want_masked)` shape, so there is no sibling reader to
# forget. The `False` rows are what stop it becoming "an escape hides
# everything": the pair is two characters and the separator AFTER it is real.
_ESCAPE_MASK: tuple[tuple[str, str, bool], ...] = (
    ('echo x\\; run "1. x" true', '\\;', True),
    ('echo x\\| run "1. x" true', '\\|', True),
    ('echo x\\( run "1. x" true', '\\(', True),
    ('echo x\\> run "1. x" true', '\\>', True),
    ('echo x\\" run "1. x" true', '\\"', True),
    ("echo x\\' run '1. x' true", "\\'", True),
    ('echo x\\$ run "1. x" true', '\\$', True),
    ('echo x\\# run "1. x" true', '\\#', True),
    ('echo x\\a run "1. x" true', '\\a', True),
    ('echo $(printf a\\; run "1. x" true)', '\\;', True),
    ('MODE=ci\\ mode run "1. x" true', '\\ ', True),
    # An escaped BACKSLASH is a complete pair, so the separator after it is a
    # real boundary and must reach the skeleton: bash runs the gate (measured).
    ('echo x\\\\; run "1. x" true', ';', False),
    # A backslash inside SINGLE quotes is not an escape at all, so the `;`
    # after the closing quote is real too.
    ("echo 'x\\'; run \"1. x\" true", ';', False),
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
    # Named PER MATRIX as well as counted in aggregate, because the aggregate
    # floor below is satisfied by any one of them: delete a whole matrix and
    # its rule goes quiet while this file still prints PASS. That is the
    # vacuous-floor shape `session-notes.md` records — an assertion with a
    # floor needs a precondition, and here the precondition is that each
    # matrix drove something.
    # The third element names what the `False` rows assert stays VISIBLE, so a
    # red says what it means: "a substitution inside a heredoc body is masked"
    # is the right sentence for three of these and nonsense for the fourth,
    # and a red that misdescribes itself is its own defect (`ops(deploy-gating)`).
    matrices = (
        ("an expansion body", _EXPANSION_MASK, "a substitution inside"),
        ("a heredoc body", _HEREDOC_MASK, "a substitution inside"),
        ("an arithmetic expression", _ARITH_MASK, "a substitution inside"),
        ("an escape pair", _ESCAPE_MASK, "the separator after"),
    )
    bodies = []
    for kind, rows, live in matrices:
        if not rows:
            bad.append(
                f"the body-mask matrix for {kind} is empty — that rule is "
                "written down and connected to nothing"
            )
        bodies += [(kind, live, r) for r in rows]
    for kind, live, (src, fragment, want_masked) in bodies:
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
                    f"{kind} reaches the skeleton unmasked: {fragment!r} "
                    f"in {src!r}"
                )
        else:
            mask_none += 1
            if any(c == _MASK for c in span):
                bad.append(
                    f"{live} {kind} is masked: {fragment!r} in {src!r}"
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
