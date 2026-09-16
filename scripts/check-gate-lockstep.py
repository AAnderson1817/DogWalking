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
    sep = r'(?:^|(?<=\n)|(?<=[;&|()]))'
    chain = r'(?:[ \t]*(?:(?:%s)[ \t]+|![ \t]*))*' % words
    boundary = sep + chain
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
    word = r"""(?:\\[\s\S]|[^\s;&|'"\\]|'[^']*'|"(?:[^"\\]|\\.)*")*"""
    prefixes = r'(?:[ \t]*(?:[A-Za-z_][A-Za-z0-9_]*=%s|[0-9]*[<>]{1,2}&?%s)[ \t]+)*' % (word, word)
    return r'%s[ \t]*%s(?P<cmd>%s)' % (boundary, prefixes, body)


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


def _lex_shell(text: str) -> tuple[str, str]:
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
    i = 0
    while i < len(text):
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
                skel.append(ch)
            else:
                skel.append(masked(ch))
        elif ch == "\\" and in_backtick and text.startswith("\\`", i):
            # A nested substitution's delimiter — see `nested_backtick` above.
            # Opening carries the boundary a bare backtick spells; closing is
            # inert and the word runs on, exactly as the outer pair behaves.
            out.append(text[i : i + 2])
            skel.append(("\\" + _SUBST_CLOSE) if nested_backtick else "\\(")
            at_word_start = not nested_backtick
            nested_backtick = not nested_backtick
            i += 2
            continue
        elif ch == "\\":
            # An unquoted backslash escapes the next character, whatever it is,
            # and the word continues through both.
            out.append(ch)
            if i + 1 < len(text):
                out.append(text[i + 1])
                skel.append(text[i : i + 2])
                i += 2
                at_word_start = False
                continue
            skel.append(ch)
            at_word_start = False
        elif ch in "'\"":
            quote = ch
            out.append(ch)
            skel.append(ch)
            at_word_start = False
        elif ch == "#" and at_word_start:
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
            parens.append("subst" if i > 0 and text[i - 1] in "$<>" else "paren")
            if dq_pending:
                # The `$` one character back suspended a double quote; this is
                # the entry whose closer resumes it.
                dq_resume_at.append(len(parens) - 1)
                dq_pending = False
            out.append(ch)
            skel.append(ch)
            at_word_start = True
            at_cmd = True
        elif ch == ")":
            if parens and parens[-1] == "case":
                # A case pattern's closer: a real command position (`case a in
                # a) run "…" x;; esac` runs `run`, measured) that closes no
                # `(`, so the construct beneath it stays open.
                substitution = False
            else:
                substitution = parens.pop() == "subst" if parens else False
            out.append(ch)
            skel.append(_SUBST_CLOSE if substitution else ch)
            at_word_start = not substitution
            at_cmd = not substitution
        elif ch == "`":
            out.append(ch)
            # Opening: a command starts after it, so the skeleton carries the
            # boundary `(` already spells. Closing: inert, and the word runs on.
            skel.append(_SUBST_CLOSE if in_backtick else "(")
            at_word_start = not in_backtick
            in_backtick = not in_backtick
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
        # The substitution that suspended a double-quoted word has closed, so
        # the quote resumes for the rest of it. Checked after every branch
        # rather than inside the `)` one, because `esac` can shrink the stack
        # too; `<=` for the same reason.
        while dq_resume_at and len(parens) <= dq_resume_at[-1]:
            dq_resume_at.pop()
            quote = '"'
        if dq_resume_backtick and not in_backtick:
            dq_resume_backtick = False
            quote = '"'
        i += 1
    clean, skeleton = "".join(out), "".join(skel)
    assert len(clean) == len(text) and len(skeleton) == len(text)
    return clean, skeleton


_QUOTED_LABEL = r'%s +(?P<q>["\'])(?P<label>.+?)(?P=q)'


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
    code, skel = _lex_shell(re.sub(r"\\\n[ \t]*", " ", source))
    return [
        code[m.start("label") : m.end("label")]
        for m in re.finditer(_command(_QUOTED_LABEL % word), skel)
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
    code, skel = _lex_shell(re.sub(r"\\\n[ \t]*", " ", source))
    out = []
    for m in re.finditer(_command(r'(?:run|skip_gate)(?![(\w])[^\n;&|]*'), skel):
        call = code[m.start("cmd") : m.end("cmd")].strip()
        if not re.match(r'^(?:run|skip_gate) +(["\']).+?\1', call):
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
    ('run() {\n  :\n}', []),
)


# The UNREADABLE reader's own two rows. It answers a different question from
# the label reader, so the spelling matrix above cannot speak for it — and its
# failure direction is the worse one: off the raw text `echo 'note; run'` was
# reported as an unreadable gate (measured), a gate red on a healthy tree.
_UNREADABLE_SPELLINGS: tuple[tuple[str, list[str]], ...] = (
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
    ('result="`echo \\`run $label true\\``"', ['run $label true\\``"']),
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
