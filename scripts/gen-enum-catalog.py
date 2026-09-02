#!/usr/bin/env python3
"""Regenerate spec 01's enum catalogue from the migrations.

Spec 01 carried its enum block by hand under a heading that said "migration
0001", and four migrations later added values it never learned about:
`payment_status` was missing `disputed` — one of the three statuses in every
partial-unique-index predicate spec 04 says "the code and the partial indexes
must agree" about — and `notification_type` was missing `card_saved`. Four
whole enums (0029, 0030, 0039, 0049) were absent. CLAUDE.md designates the
specs authoritative, so a reader computing a status set from that list
computed the wrong set with written authority.

Same shape and same fix as `gen-definer-catalog.py`: the block is generated
from the append-only migrations and CI diffs the committed file. A hand list
would rot again by the next `add value`.

Reads the migrations rather than a live database on purpose, so it runs in
the frontend CI job with no Postgres, and so it describes what a `db push`
will apply rather than what one cluster happens to hold. Values are kept in
the order `enumsortorder` would give them: `create type` order, then each
`add value` appended (or placed by its BEFORE/AFTER clause).

Any `alter type` on an enum this file tracks that is NOT an `add value` or a
`rename value` fails the run by name. Silently modelling an unknown statement
is how a generator reports agreement while describing a type that no longer
exists — the parser-that-sees-nothing defect this repository has fixed in
`column-grants.test.ts` and `db-push-check.sh`. So does finding zero enums.

What this gate is FOR: catching mistakes in migrations written in good
faith — a value added and never catalogued, a type dropped and left in the
spec. It refuses what it cannot read rather than modelling it (a body that
EXECUTEs anything but a plain literal or a `format()` of one is refused
outright), and it does not defend against SQL assembled to evade it: a
`format('%s type …', 'create')` template supplies the verb through a
placeholder and is not detected. That boundary is stated here so nobody
mistakes a stricter parser for a proof.

The gate reads every unqualified `create/alter/drop type` as landing in
`public`, and that rests on four session states a migration could change:
`search_path` (must stay public-first), `standard_conforming_strings` (must
stay on, or literals lex differently), and the current ROLE and SESSION
AUTHORIZATION (the default path is `"$user", public`, so a switched role
puts an unqualified type into a schema named after that role when one
exists). A statement that moves any of them off its default is refused by
name — `set`, `set_config`, `alter database|role|user|system … set`, and any
mention inside a procedural body — while the reset forms pass. A fifth
precondition is that `"$user"` never resolves: `create schema authorization
current_user` (or any schema that happens to carry the deploy role's name)
makes the default path land an unqualified type there with no session
change to see, and the deploy role is not knowable from a file. So once a
migration creates or renames a schema, other than `public` itself, every
later enum statement must be qualified with `public.` or is refused.

Writes between the markers in docs/spec/01-data-model.md. Idempotent.
"""
from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
MIGRATIONS = ROOT / "supabase" / "migrations"
SPEC = ROOT / "docs" / "spec" / "01-data-model.md"

BEGIN = "<!-- BEGIN GENERATED ENUM CATALOG -->"
END = "<!-- END GENERATED ENUM CATALOG -->"

CREATE = re.compile(
    r"create\s+type\s+(?:public\.)?([a-z0-9_]+)\s+as\s+enum\s*\((.*?)\)\s*;",
    re.I | re.S,
)
ALTER = re.compile(r"alter\s+type\s+(?:public\.)?([a-z0-9_]+)\s+(.*?);", re.I | re.S)
# A label is a SQL string literal, so a quote inside it is doubled: `'it''s'`.
# The first version of these patterns stopped at the first quote and refused
# such a label as "neither add value nor rename value" — honest, but the
# status-log entry claimed the label survived, and my own proof refuted it.
# `unquote()` turns the literal back into the label Postgres stores.
LIT = r"'((?:[^']|'')*)'"
# Matched against the INTACT action span, never a whitespace-collapsed copy:
# `add value 'needs  review'` stores two spaces, and collapsing the text before
# parsing it recorded one — and mis-placed a BEFORE/AFTER anchor carrying the
# same label (Codex round seven). Tokens are separated by `\s+` already.
ADD_VALUE = re.compile(
    r"^\s*add\s+value\s+(?:if\s+not\s+exists\s+)?" + LIT + r"(?:\s+(before|after)\s+" + LIT + r")?\s*$",
    re.I | re.S,
)
RENAME_VALUE = re.compile(r"^\s*rename\s+value\s+" + LIT + r"\s+to\s+" + LIT + r"\s*$", re.I | re.S)
# Where an identifier begins and ends — by PostgreSQL's lexer, not Python's
# `\b`. The lexer continues an identifier through `$` and through EVERY
# non-ASCII character; `\b` stops at `$` and at any non-ASCII character that
# is not a letter, so `custom$set_config(` — a call of a different function,
# measured — read as the built-in and the gate refused a healthy migration
# (Codex round thirty-one), the third time this boundary has bitten a scan
# here (rounds twenty-six and twenty-seven fixed it at one site each; this
# time `alter role my$set set search_path = …` also read its target as `set`
# and PASSED). Every keyword and name match in this file uses these two, so
# there is one definition of a boundary rather than one per pattern.
IDENT_CHARS = r"A-Za-z0-9_$\u0080-\U0010ffff"
IDENT_CHAR = re.compile("[" + IDENT_CHARS + "]")
IDENT_START = r"(?<![" + IDENT_CHARS + r"])"
IDENT_END = r"(?![" + IDENT_CHARS + r"])"
# A setting's name may be dotted — `search_path.custom` is a CUSTOM setting
# sharing nothing but a prefix with `search_path` (measured: stored as its
# own entry, the real path untouched) — so a guarded name is only the WHOLE
# name: nothing that continues an identifier, and no dot, may follow it
# (Codex round thirty-two).
GUC_END = IDENT_END + r"(?!\s*\.)"
# The readers below spell a quoted name as ONE alternative, never as an
# optional quote pair: with `"?name"?` the closing quote is optional, so the
# engine backtracks to the unclosed `"name` when GUC_END refuses the dot
# after it (the proof set caught `set "search_path".custom` still refused).
# Every `drop type` statement, loosely, so an unparsed one can be REFUSED —
# and the strict shape Postgres allows: a comma list of names, optional
# CASCADE/RESTRICT. Codex on PR #88 round two: the first regex demanded the
# semicolon straight after the name, so `drop type payment_status cascade;`
# matched nothing and the dropped enum stayed in the catalogue while CI
# reported agreement — a parser that sees nothing reports agreement.
DROP_ANY = re.compile(r"drop\s+type" + IDENT_END + r"[^;]*;", re.I | re.S)
# The same loose-versus-strict pairing for the other two statement kinds
# (Codex round three): `create type public."delivery_status" as enum (…)` is
# valid SQL the strict regex does not read, and with fifteen enums already
# in `order` the parser-saw-nothing guard cannot notice one skipped type.
CREATE_ANY = re.compile(
    r"create\s+type" + IDENT_END + r"[^;]*?" + IDENT_START + r"as\s+enum" + IDENT_END + r"[^;]*;",
    re.I | re.S,
)
ALTER_ANY = re.compile(r"alter\s+type" + IDENT_END + r"[^;]*;", re.I | re.S)
DROP = re.compile(
    r"drop\s+type\s+(?:if\s+exists\s+)?((?:(?:public\.)?[a-z0-9_]+\s*,\s*)*(?:public\.)?[a-z0-9_]+)"
    r"\s*(?:cascade|restrict)?\s*;",
    re.I | re.S,
)
LABEL = re.compile(LIT)
# The whole parenthesis must be standard literals separated by commas. An
# escape string (the E prefix, backslash escapes inside), a dollar-quoted
# label or anything else is refused rather than half-read: on an escape
# string LABEL.findall stops at the escaped quote, and both create scans
# still match, so nothing else would notice (Codex round four). Decoding
# every literal form PostgreSQL has is more parser than a catalogue of
# fifteen enums earns; refusing keeps the gate honest.
# An EMPTY body is legal SQL: `create type phase as enum ()` is the
# create-then-`add value` workflow, and PostgreSQL accepts it (measured:
# zero labels after the create, `add value` populates it). The first
# version of this pattern demanded at least one literal, so a valid
# migration could not pass the gate — a gate red on a healthy tree, the
# worst shape available (Codex round sixteen). The whole label list is
# optional; a bare comma or an empty literal is still refused.
ENUM_BODY = re.compile(r"^\s*(?:" + LIT + r"(?:\s*,\s*" + LIT + r")*\s*,?)?\s*$", re.S)


def unquote(lit: str) -> str:
    return lit.replace("''", "'")


# A tag follows identifier rules, so `$é$` opens a region: an ASCII-only
# pattern made such a body invisible AS a body — its text was scanned as
# top-level statements and the EXECUTE it could not read was never asked
# about, so the gate passed while recording nothing (Codex round
# twenty-nine; measured, the block runs and creates the type). Everywhere
# else an unreadable name fails safe by being refused; here it failed open
# by not being a region at all. Tags accept every identifier character.
DOLLAR_TAG = re.compile(r"[$](?:[A-Za-z_\u0080-\U0010ffff][A-Za-z0-9_\u0080-\U0010ffff]*)?[$]")
DDL_INSIDE = re.compile(IDENT_START + r"(?:create|alter|drop)\s+type" + IDENT_END, re.I)
# A procedural BODY — a DO block, or a function/procedure definition — may
# not mention enum DDL or `search_path` anywhere in its CLEAN text: an
# `execute 'create type …'` is enum DDL inside a string, and a
# `set_config('search_path', …)` changes where every later unqualified
# statement lands. A DO body runs at migration time (Codex round eight); a
# function body runs whenever it is called, which can be the very next
# statement of the same migration, a trigger it fires, or a later migration
# (Codex round twelve) — so the skeleton check round eight kept for function
# bodies let `execute 'create type public.mood …'` through, and a `select
# mk()` after it created the enum unseen. One rule for every body now. It
# also refuses prose such as `raise notice 'create type is not allowed
# here'` — a decision reversed from round six — because a body is not a
# value and the fix is one reworded sentence.
# `standard_conforming_strings` joins `search_path` here (Codex round
# seventeen): a body that turns it off changes how every later literal in
# the same session is lexed, and this generator reads literals the standard
# way only.
BODY_UNREADABLE = re.compile(
    "|".join(
        IDENT_START + word + IDENT_END
        for word in (
            r"(?:create|alter|drop)\s+type",
            r"search_path",
            r"standard_conforming_strings",
            r"set\s+(?:local\s+|session\s+)?\"?role",
            r"session\s+authorization",
            r"session_authorization",
            r"(?:create|alter|drop)\s+schema",
        )
    ),
    re.I,
)
# In a body, `set_config` reaches every guarded setting through a literal the
# word rules above cannot see — `perform set_config('role', 'authenticated',
# false)` carries no `set role` phrase, and the switch persists past the
# block (measured; Codex round twenty-three) — and an EXECUTE'd command or a
# `format()` template carries the same call with doubled quotes or a `%L`.
# So a body may not call `set_config` on a guarded name at all, whatever the
# value (a body is not a value), and a `set_config` whose name is not a
# plain literal is refused as unreadable. Matched on the CLEAN text, where
# literal contents are still visible; a doubled quote inside an EXECUTE'd
# literal is why the quote runs are `'+`.
# The name must be the ENTIRE first argument — one plain literal followed by
# the comma. `set_config('ro' || 'le', …)` begins with a literal that is not
# a guarded name and continues into an expression PostgreSQL evaluates to
# `role` (measured; Codex round twenty-four), so a pattern that read the
# first literal and stopped let it through. `"set_config"(` is the same call
# with a quoted name (the proof set caught the first pattern requiring the
# name and the paren to be adjacent). The quote runs are `'+` because an
# EXECUTE'd literal doubles them.
# This scan reads the CLEAN text on purpose — an EXECUTE'd literal carries
# its `set_config(''role'', …)` inside a string — so it cannot see where a
# quoted identifier begins, and the price is that a quoted function name
# ending in ` set_config` is refused; a name ending in `$set_config` is not.
BODY_SET_CONFIG_CALL = re.compile(IDENT_START + r'"?set_config"?\s*\(\s*', re.I)
BODY_SET_CONFIG_NAME = re.compile(r"'+\s*([a-z_][a-z0-9_.]*)\s*'+\s*,", re.I)


def body_set_config_unreadable(clean: str) -> bool:
    """True if any set_config call in a body names a guarded setting, or names
    its setting with anything but one plain literal."""
    for call in BODY_SET_CONFIG_CALL.finditer(clean):
        if qualifier_before(clean, call.start()) not in BUILTIN_SCHEMAS:
            continue  # a schema-qualified function that is not the built-in
        name = BODY_SET_CONFIG_NAME.match(clean, call.end())
        if not name or name.group(1).lower() in GUARDED:
            return True
    return False
FUNCTION_HEAD = re.compile(r"^\s*create\s+(?:or\s+replace\s+)?(?:function|procedure)" + IDENT_END, re.I)
# Where a routine's BODY literal begins: a DO block's code follows `do` and an
# optional LANGUAGE clause; a function or procedure body follows AS. Both are
# matched against the statement's skeleton so far, so a masked literal
# before the body (a quoted language name) reads as one token.
DO_BODY_NEXT = re.compile(r"^\s*do(?:\s+language\s+\S+)?$", re.I)
AS_LAST = re.compile(IDENT_START + r"as$", re.I)
# A PL/pgSQL EXECUTE runs whatever its expression evaluates to, and
# `execute 'create ' || 'type …'` carries no contiguous keyword for
# BODY_UNREADABLE to see (Codex round thirteen). So the command text of every
# EXECUTE in a body must be a plain literal or a `format()` whose template is
# one — the only two forms this repository's migrations use — and anything
# else (a variable, `||`, `concat()`, a function) is refused as unreadable.
# Matched on the body's SKELETON, so `grant execute on`, a trigger's
# `execute function`, and the word inside a string are not EXECUTE statements.
EXECUTE_STMT = re.compile(
    IDENT_START + r"execute\s+(?!(?:on|function|procedure)" + IDENT_END + r")(.*?)"
    r"(?=;|" + IDENT_START + r"(?:into|using)" + IDENT_END + r"|$)",
    re.I | re.S,
)
READABLE_COMMAND = re.compile(r"^\s*(?:'x*'|format\s*\(\s*'x*'\s*(?:,.*)?\))\s*$", re.I | re.S)


class HiddenDDL(Exception):
    """Enum DDL, or a search_path change, inside a body or value this
    generator does not read."""


SKEL_LITERAL = re.compile(r"'x*'")


def check_command(command: str, where: str) -> None:
    """An EXECUTE'd command is CODE: PostgreSQL parses the dynamic command as
    SQL, comments and all, so `execute 'create /*gap*/ type …'` creates the
    enum while the enclosing body's clean text — which keeps comments INSIDE
    literals, a literal being data — shows no contiguous `create type`
    (Codex round thirty-three; measured). So the command is read as a
    migration fragment of its own: the top-level scanner runs over it (a DO
    or function body inside it is checked as a body, a dollar-quoted value
    inside it is scanned — both recursively), and its own clean text is
    held to the body rules."""
    clean, _ = strip_sql(command)
    if BODY_UNREADABLE.search(clean) or body_set_config_unreadable(clean):
        raise HiddenDDL("an EXECUTE'd command carrying enum DDL or a guarded session change: "
                        + " ".join(where.split())[:100])


def strip_sql(sql: str, *, inside_dollar: bool = False, in_body: bool = False) -> tuple[str, str]:
    """-> (clean, skeleton). Both have `--` and /* */ comments removed —
    OUTSIDE string literals and quoted identifiers, with nesting, and with a
    space left where a block comment stood, since PostgreSQL reads it as
    whitespace. `clean` keeps every literal intact; `skeleton` is the same
    text, same length, with the CONTENTS of each literal and each quoted
    identifier replaced by `x`, so the statement scans can run on the
    skeleton (a `;` or `drop type` inside a value or a name is not a
    terminator or a statement — Codex rounds six and seven) and read the
    real labels out of `clean` at the same spans.

    A dollar-quoted region (`$$…$$`, `$tag$…$tag$`) is a value, not a
    statement, so it is blanked in both outputs after its own comments are
    stripped. What is refused inside one depends on the statement it belongs
    to: the body of a DO block or a function/procedure definition may not
    mention enum DDL or `search_path` anywhere in its CLEAN text
    (`BODY_UNREADABLE` — a body can execute at migration time, and an
    EXECUTE carries its DDL inside a string); any other region — a COMMENT ON
    value, say — is refused only if its skeleton carries `create/alter/drop
    type` outside a literal. A single-quoted literal in the same two
    statement kinds is the same body in a different quoting and gets the same
    check (Codex round eight: `DO 'BEGIN EXECUTE ''CREATE TYPE …''; END'`
    masked the whole body and both scans saw nothing). Inside a
    dollar-quoted VALUE a `$word$` is text, never a nested quote; inside a
    BODY (`in_body`) a nested `$tag$…$tag$` is a string literal and is masked
    like one, so `perform length($msg$please execute this later$msg$)` is
    not an EXECUTE statement (Codex round fourteen) while `execute
    $q$create type …$q$` still carries its DDL into the clean text."""
    out: list[str] = []
    skel: list[str] = []
    i, n = 0, len(sql)
    state = "code"
    depth = 0
    escapes = False  # inside an E'...' literal a backslash escapes the next char
    lit_start = 0  # index in `out` where the current literal's contents begin
    lit_body = False  # whether the literal being read is a routine body
    last_semi = -1  # index in `skel` of the last top-level `;`

    def both(ch: str) -> None:
        out.append(ch)
        skel.append(ch)

    def statement() -> str:
        """The current statement's skeleton so far (from the last `;`)."""
        return "".join(skel[last_semi + 1 :])

    def head() -> str:
        parts = statement().split()
        return parts[0].lower() if parts else ""

    def body_position(prefix: int = 0) -> bool:
        """True when a literal opening HERE is the routine's body: a DO block's
        code (after an optional LANGUAGE clause), or the literal after AS in a
        CREATE FUNCTION/PROCEDURE. Every other literal in such a statement — a
        parameter DEFAULT, a SET clause value, a C function's link symbol — is
        a value, masked as any value is; every one of them was checked as
        procedural code until Codex round thirty-two, so `default 'create
        type'` refused a healthy migration (measured: the default comes back
        as data). `prefix` is the escape-string `E` already in the skeleton
        ahead of the quote, which is part of the literal, not a token before
        it (the proof set caught `do E'…'` losing its body)."""
        before = statement()
        before = before[: len(before) - prefix].rstrip()
        if head() == "do":
            return DO_BODY_NEXT.match(before) is not None
        return bool(FUNCTION_HEAD.match(before)) and AS_LAST.search(before) is not None

    def check_body(body: str, where: str) -> None:
        """`body` is the raw text of a DO or function body, either quoting."""
        clean, body_skel = strip_sql(body, in_body=True)
        if BODY_UNREADABLE.search(clean):
            raise HiddenDDL(" ".join(where.split())[:120])
        if body_set_config_unreadable(clean):
            raise HiddenDDL("set_config of a guarded (or unreadable) setting in a body: "
                            + " ".join(where.split())[:100])
        for ex in EXECUTE_STMT.finditer(body_skel):
            if not READABLE_COMMAND.match(ex.group(1)):
                raise HiddenDDL("EXECUTE of a command this generator cannot read: "
                                + " ".join(clean[ex.start() : ex.end()].split())[:100])
            # Every literal in the command expression — the command, a format()
            # template, its arguments (%s and %L are not told apart) — is a
            # fragment of its own (check_command). A nested dollar string's
            # tags are blanked in `clean` with its content verbatim; a
            # single-quoted literal doubles its quotes.
            for lit in SKEL_LITERAL.finditer(ex.group(1)):
                a, b = ex.start(1) + lit.start(), ex.start(1) + lit.end()
                raw = clean[a + 1 : b - 1]
                check_command(unquote(raw) if clean[a] == "'" else raw, clean[a:b])

    while i < n:
        c = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if state == "code":
            # `$` may sit INSIDE an unquoted identifier (`first$tag$` is an
            # alias), and PostgreSQL opens a dollar quote only at a token
            # boundary — pairing two such aliases as one region refused the
            # enum statement between them (Codex round fifteen). A closing
            # tag needs no boundary: the lexer ends the string at the first
            # occurrence of it.
            # The lexer treats EVERY non-ASCII character as an identifier
            # character; `isalnum()` does not (`€`), so `first€$tag$` opened a
            # region where an alias stood (Codex round thirty). IDENT_CHAR is
            # the lexer's definition, shared with every boundary in the file.
            after_ident = i > 0 and IDENT_CHAR.match(sql[i - 1]) is not None
            tag = DOLLAR_TAG.match(sql, i) if (c == "$" and not inside_dollar and not after_ident) else None
            if tag:
                close = sql.find(tag.group(0), tag.end())
                if close < 0:
                    raise HiddenDDL(f"unterminated dollar quote {tag.group(0)}")
                region = sql[i : close + len(tag.group(0))]
                if in_body:
                    # A nested dollar string inside a body is a literal: its
                    # CONTENT is kept intact in `clean` at the same offsets
                    # and the two tags are blanked to spaces, so the mention
                    # scans see `$q$create type$q$` at a token boundary — `$`
                    # continues an identifier for IDENT_START, and a tag's
                    # closing `$` is a delimiter, not one (the proof set
                    # caught this in Codex round thirty-one's fix). Masked in
                    # the skeleton.
                    k = len(tag.group(0))
                    out.extend(" " * k + region[k:-k] + " " * k)
                    skel.extend("'" + "x" * (len(region) - 2) + "'")
                    i = close + len(tag.group(0))
                    continue
                if body_position():
                    check_body(sql[tag.end() : close], region)
                else:
                    _, inner_skel = strip_sql(sql[tag.end() : close], inside_dollar=True)
                    if DDL_INSIDE.search(inner_skel):
                        raise HiddenDDL(" ".join(region.split())[:120])
                both(" ")
                i = close + len(tag.group(0))
                continue
            if c == "-" and nxt == "-":
                state = "line"
                i += 2
                continue
            if c == "/" and nxt == "*":
                state = "block"
                depth = 1
                i += 2
                continue
            if c == "'":
                state = "sq"
                prev = sql[i - 1] if i > 0 else ""
                before = sql[i - 2] if i > 1 else ""
                escapes = prev in "eE" and not (before.isalnum() or before == "_")
                # `U&'…'` is the Unicode-escape string; `U&` is not an identifier
                # tail, so it is the prefix only at a token boundary.
                unicode = prev == "&" and before in ("u", "U") and not (
                    i > 2 and IDENT_CHAR.match(sql[i - 3]) is not None
                )
                lit_body = body_position(prefix=2 if unicode else 1 if escapes else 0)
                if lit_body and (escapes or unicode):
                    # A routine body written as an escape string is refused by
                    # name, not read: PostgreSQL decodes the escapes BEFORE running
                    # it, so `\x63reate type` in an E'…' body and `\0063reate type`
                    # in a U&'…' body are `create type` to the server (measured, the
                    # enum appears) and nothing to the mention rule — which is how
                    # an E body had been "read" since round eight, and how a U& body
                    # was masked as data (Codex round thirty-eight). No migration in
                    # the tree writes a body either way; a body this generator
                    # cannot read is refused whether or not the server would run
                    # it (the round twenty-eight rule).
                    raise HiddenDDL(
                        "a routine body written as an escape string (E'…' or U&'…'), whose "
                        "escapes PostgreSQL decodes before running it and this generator does "
                        "not: " + " ".join(statement().split())[:80]
                    )
                both(c)
                lit_start = len(out)
                i += 1
                continue
            if c == '"':
                state = "dq"
            both(c)
            if c == ";":
                last_semi = len(skel) - 1
        elif state == "sq":
            if escapes and c == "\\":
                out.append(c); skel.append("x")
                out.append(nxt); skel.append("x")
                i += 2
                continue
            if c == "'":
                if nxt == "'":  # a doubled quote is content, not the end
                    out.append(c); skel.append("x")
                    out.append(nxt); skel.append("x")
                    i += 2
                    continue
                content = "".join(out[lit_start:])
                both(c)
                state = "code"
                if lit_body:
                    check_body(unquote(content), sql[max(0, i - len(content) - 1) : i + 1])
            else:
                out.append(c); skel.append("x")
        elif state == "dq":
            # A quoted identifier's contents are a NAME, never a statement:
            # `select 1 as "drop type payment_status;"` is an alias, and with
            # the contents copied into the skeleton both DROP scans matched it
            # and removed a live enum (Codex round seven). Masked like a
            # literal; a doubled quote inside is content, not the end.
            if c == '"':
                if nxt == '"':
                    out.append(c); skel.append("x")
                    out.append(nxt); skel.append("x")
                    i += 2
                    continue
                both(c)
                state = "code"
            else:
                out.append(c); skel.append("x")
        elif state == "line":
            if c == "\n":
                both(c)
                state = "code"
        elif state == "block":
            if c == "/" and nxt == "*":
                depth += 1
                i += 1
            elif c == "*" and nxt == "/":
                depth -= 1
                i += 1
                if depth == 0:
                    state = "code"
                    both(" ")  # `CREATE/*gap*/TYPE` is two tokens to PostgreSQL
        i += 1
    return "".join(out), "".join(skel)


# The strict regexes read unqualified names as `public.` — true under the
# default search_path a `db push` session runs with, and false the moment a
# migration changes it: `set search_path = private, public; create type
# mood …` creates `private.mood`, which this file would record over a public
# enum of the same name (Codex round eight). Tracking the path is more parser
# than fifteen enums earn, so a top-level change is REFUSED unless `public`
# is its first schema (`set schema 'x'` is the same statement); `reset search_path`
# is the default again and passes.
# `set schema 'x'` is PostgreSQL's alias for `set search_path to x` (Codex
# round nine) — one word the first regex did not know, and the whole gate
# passed a migration that moved every unqualified statement into `x`.
SET_SEARCH_PATH = re.compile(
    r"^\s*set\s+(?:local\s+|session\s+)?(?:\"search_path\"|search_path|schema)" + GUC_END + r"\s*(?:=|to)?\s*(.*?)\s*$",
    re.I | re.S,
)
# `set_config` takes expressions, so `set_config('search_path', concat(…),
# false)` moves the path with a value no regex can read (Codex round ten,
# against a pattern that recognised a literal second argument and matched
# NOTHING otherwise — the enumerate-what-I-know shape). The rule is inverted:
# a call whose name or value is not a plain literal is refused outright, and
# only a literal `'search_path'` with a literal public-first value passes.
# Calls are located on the SKELETON and their arguments decoded from the
# intact text at the same spans (Codex round eleven, both directions): scanning
# the intact statement read `select 'set_config(foo)'` — inert data — as a
# computed call and refused a valid migration, and a quoted
# `pg_catalog."set_config"(…)` was invisible because the skeleton masks
# identifiers. So a call is either the bare word or a quoted identifier whose
# intact text is `set_config`; quoted names are case-sensitive in PostgreSQL,
# so `"SET_CONFIG"` is a different (nonexistent) function, but refusing it
# costs nothing and is one less thing to argue about.
# `standard_conforming_strings = off` makes PostgreSQL read a backslash in an
# ordinary literal as an escape, so `create type mood as enum ('line\nfeed')`
# stores a real newline where this generator records a backslash and an `n`
# — a catalogue blessed with a value the live enum does not hold, and the
# control-character rule bypassed on the way (Codex round seventeen).
# Measured: sent as separate statements, the way `psql -f` and `db push`
# apply a file, the label is nine characters with a newline inside (a
# `psql -c` string is one message, lexed whole, so a `set` in it does not
# reach the literal beside it — the first probe refuted the finding falsely).
# Refused rather than modelled, on the search_path rule: only an explicit
# `on` passes (any boolean spelling PostgreSQL accepts), plus `default` and
# `reset`, which return to the cluster default — `on` since PostgreSQL 9.1.
# `backslash_quote` needs no guard: it applies only while this is off.
SET_STANDARD_STRINGS = re.compile(
    r"^\s*set\s+(?:local\s+|session\s+)?(?:\"standard_conforming_strings\"|standard_conforming_strings)" + GUC_END + r"\s*(?:=|to)?\s*(.*?)\s*$",
    re.I | re.S,
)
ON_SPELLINGS = {"on", "true", "yes", "1"}
# The default search_path is `"$user", public` and `$user` follows the
# CURRENT role, so `set role authenticated` before an unqualified `create
# type` lands the type in a schema named `authenticated` when one exists —
# measured, `pg_type` shows it there — while this generator records it as
# public (Codex round twenty-one). `set session authorization` moves both
# session_user and current_user, and both are GUCs `set_config` reaches.
# Refused on the same allow-list shape as the two settings above: `reset
# role`, `set role none`, `reset session authorization` and `set session
# authorization default` pass; any other switch is refused.
# Both are GUCs as well as special syntax: `set "role" = authenticated` and
# `set session_authorization = authenticated` switch through the generic
# form (measured), and the first patterns here matched only the bare `set
# role` / `set session authorization` spellings while the two settings above
# had carried the quoted and `=`/`to` forms since round eleven (Codex round
# twenty-two). One shape for all four now.
SET_ROLE = re.compile(
    r"^\s*set\s+(?:local\s+|session\s+)?(?:\"role\"|role)" + GUC_END + r"\s*(?:=|" + IDENT_START + r"to" + IDENT_END + r")?\s*(.*?)\s*$",
    re.I | re.S,
)
SET_SESSION_AUTH = re.compile(
    r"^\s*set\s+(?:local\s+|session\s+)?(?:session\s+authorization|\"session_authorization\"|session_authorization)" + GUC_END +
    r"\s*(?:=|" + IDENT_START + r"to" + IDENT_END + r")?\s*(.*?)\s*$",
    re.I | re.S,
)
# `none` resets the role in either syntax, bare or as a literal; DEFAULT is
# the keyword reset for any setting (IS_DEFAULT).
IS_NONE = re.compile(r"^\s*(?:none|'none')\s*$", re.I)
GUARDED = ("search_path", "standard_conforming_strings", "role", "session_authorization")
# The bare keyword DEFAULT is a reset for any setting — measured, `set
# search_path to default` reads `"$user", public` afterwards, exactly as
# `reset` does — so it passes both guards below. Quoted, it is a VALUE: a
# schema named default for search_path, and for a boolean an error
# PostgreSQL raises (`requires a Boolean value`). The first version read the
# keyword as a schema and refused a healthy migration (Codex round nineteen).
IS_DEFAULT = re.compile(r"^\s*default\s*$", re.I)
SET_CONFIG_OPEN = re.compile("(?:" + IDENT_START + r'set_config|"x+")\s*\(\s*', re.I)
QUOTED_IDENT = re.compile(r'"x+"')
LITERAL_AT = re.compile(LIT)
ALTER_SESSION_DEFAULTS = re.compile(r"^\s*alter\s+(?:database|role|user|system)" + IDENT_END, re.I)
# `alter role … set search_path to default` and `alter role … reset
# search_path` REMOVE a stored setting rather than set one — measured,
# `rolconfig` goes back to null — the same keyword one clause over (Codex
# round twenty). The reset forms pass for both guarded settings; any other
# mention in such a statement, including `from current` (which copies a
# session state this generator cannot see), is refused by the mention rule.
ALTER_RESET = re.compile(
    IDENT_START + r"(?:set\s+(?:\"[^\"]+\"|[a-z_]+)\s*(?:=|to)\s*default|reset\s+(?:all|\"[^\"]+\"|[a-z_]+))\s*$",
    re.I | re.S,
)
# The parameter an ALTER … SET names, read from the skeleton so a quoted
# name is resolved and a value cannot pose as one. A word-grep cannot do
# this for `role`: `alter role x set role = y` and `alter role x set
# work_mem = …` both contain the word (Codex round twenty-one).
# The WHOLE name, dots included: `search_path.custom` is a custom setting and
# a reader that stopped at the dot returned `search_path` for it (Codex round
# thirty-two). Each component is a bare identifier or a masked quoted one.
GUC_COMPONENT = r'(?:"x+"|[A-Za-z_\u0080-\U0010ffff][' + IDENT_CHARS + r"]*)"
ALTER_SET_NAME = re.compile(
    IDENT_START + r"set\s+(" + GUC_COMPONENT + r"(?:\s*\.\s*" + GUC_COMPONENT + r")*)" + IDENT_END, re.I
)
GUC_PART = re.compile(r'"x+"|[^\s".]+')
# A setting's name may also be spelled `U&"…"` (round thirty-five's alphabet
# applied to the session guards): `set U&"standard_conforming_strings" =
# off` turns the lexer's escape handling on under the gate — measured, a
# later `'line\nfeed'` label stores a real newline, the round seventeen
# defect exactly — and `alter role … set U&"search_path" = private` stores
# the path (measured), while every SET reader knew the bare and quoted
# spellings only and passed both (Codex round thirty-nine). Refused by
# name for EVERY setting, since the reader cannot tell which one it is; a
# RESET spelled that way still passes, being a return to the default in
# either direction. Read off the intact statement at top level (the
# quotes are intact there) and off the skeleton inside an ALTER, where
# the `U&` prefix survives the masking.
UNICODE_SET_NAME = re.compile(r'^\s*set\s+(?:local\s+|session\s+)?u&"', re.I)
ALTER_UNICODE_SET = re.compile(IDENT_START + r'set\s+u&"', re.I)


def alter_set_target(stmt: str, stmt_skel: str) -> str | None:
    """The setting an ALTER … SET names, read whole from the skeleton with each
    quoted component resolved from the intact text and every component
    lower-cased, since PostgreSQL folds a setting's name (measured: `set
    "SEARCH_PATH"` moves the path). A dotted name is a custom setting and is
    never a guarded one, whatever its first component."""
    m = ALTER_SET_NAME.search(stmt_skel)
    if not m:
        return None
    parts = []
    for part in GUC_PART.finditer(m.group(1)):
        at = m.start(1) + part.start()
        if part.group(0).startswith('"'):
            parts.append(quoted_name(stmt, QUOTED_IDENT.match(stmt_skel, at)))
        else:
            parts.append(part.group(0).lower())
    return ".".join(parts)


def qualifier_before(text: str, pos: int) -> str | None:
    """The schema a `name(` beginning at `pos` is qualified with, read from the
    intact text, or None when the call is unqualified. `app.set_config(…)` is a
    different function from the built-in (Codex round thirty); only an
    unqualified, `pg_catalog.` or `public.` call is treated as the built-in —
    `public` because that is where a public-first path resolves a wrapper."""
    j = pos
    while j > 0 and text[j - 1].isspace():
        j -= 1
    if j == 0 or text[j - 1] != ".":
        return None
    j -= 1
    while j > 0 and text[j - 1].isspace():
        j -= 1
    if j > 0 and text[j - 1] == '"':
        k = text.rfind('"', 0, j - 1)
        return text[k + 1 : j - 1].replace('""', '"') if k >= 0 else ""
    k = j
    while k > 0 and IDENT_CHAR.match(text[k - 1]):
        k -= 1
    return text[k:j].lower()


BUILTIN_SCHEMAS = (None, "pg_catalog", "public")


def keeps_standard_strings(value: str) -> bool:
    """True only for a SET or set_config value that leaves
    standard_conforming_strings on; anything else, computed or off, is refused.
    The bare keyword DEFAULT is handled by the caller (IS_DEFAULT); quoted, it
    is not a value PostgreSQL accepts for a boolean, and is refused here."""
    value = value.strip()
    if len(value) >= 2 and value[0] == "'" and value[-1] == "'":
        value = unquote(value[1:-1])
    return value.strip().lower() in ON_SPELLINGS


def first_schema(value: str) -> str:
    """The first schema a search_path value names, as PostgreSQL resolves it:
    the value may be a single-quoted string holding the list, an unquoted
    name case-folds, and a double-quoted name keeps its case — `"PUBLIC"` is
    a different schema from `public` (Codex round fifteen), so it must not
    be folded into the one this generator assumes."""
    value = value.strip()
    if len(value) >= 2 and value[0] == "'" and value[-1] == "'":
        value = unquote(value[1:-1])
    item = value.split(",", 1)[0].strip()
    if len(item) >= 2 and item[0] == '"' and item[-1] == '"':
        return item[1:-1].replace('""', '"')
    return item.lower()


def quoted_name(stmt: str, skel_match: "re.Match[str]") -> str:
    """The identifier a `"x…x"` skeleton span names, read from the intact text."""
    raw = stmt[skel_match.start() : skel_match.end()]
    return raw[1:-1].replace('""', '"').lower()


def set_config_changes(stmt: str, stmt_skel: str) -> str | None:
    """Which setting a `set_config(...)` in this statement might move off the
    value this generator assumes: `search_path` (a computed name, a computed
    value, or a literal value that is not public-first) or
    `standard_conforming_strings` (a computed value, or a literal value that
    is not an `on` spelling). A literal name for any other setting is not
    ours; a computed name could be either and is reported as search_path."""
    for call in SET_CONFIG_OPEN.finditer(stmt_skel):
        if call.group(0).startswith('"'):
            q = QUOTED_IDENT.match(stmt_skel, call.start())
            if quoted_name(stmt, q) != "set_config":
                continue  # some other quoted function
        if qualifier_before(stmt, call.start()) not in BUILTIN_SCHEMAS:
            continue  # `app.set_config(...)` is somebody else's function
        name = LITERAL_AT.match(stmt, call.end())
        sep = re.compile(r"\s*,\s*").match(stmt, name.end()) if name else None
        if not name or not sep:
            # No literal, or a literal that is only the START of the name
            # (`'ro' || 'le'`, Codex round twenty-four): a computed GUC name
            # could be any guarded setting.
            return "search_path"
        guc = unquote(name.group(1)).strip().lower()
        if guc not in GUARDED:
            continue
        value = LITERAL_AT.match(stmt, sep.end()) if sep else None
        if not value or not re.compile(r"\s*[,)]").match(stmt, value.end()):
            return guc  # not a bare literal: concat(), ||, a function, …
        literal = unquote(value.group(1))
        if guc == "search_path" and first_schema(literal) != "public":
            return guc
        if guc == "standard_conforming_strings" and not keeps_standard_strings(literal):
            return guc
        if guc == "role" and not IS_NONE.match(literal):
            return guc
        if guc == "session_authorization":
            return guc  # no literal restores the original session user
    return None


def refuse_session_changes(path: pathlib.Path, sql: str, skel: str) -> None:
    """Refuse a top-level statement that moves search_path off public-first or
    standard_conforming_strings off `on`; each is a session setting under
    which this generator would read later statements differently from
    PostgreSQL. `reset` returns to the cluster default and passes."""
    start = 0
    for end in [m.start() for m in re.finditer(";", skel)] + [len(skel)]:
        stmt_skel, stmt = skel[start:end], sql[start:end]
        start = end + 1
        if UNICODE_SET_NAME.match(stmt) or (
            ALTER_SESSION_DEFAULTS.match(stmt_skel) and ALTER_UNICODE_SET.search(stmt_skel)
        ):
            print(
                f"FAIL: {path.name}: `{' '.join(stmt.split())[:120]}` spells its setting's name as a "
                "U&\"…\" Unicode-escaped identifier, which this generator does not read, so it "
                "cannot tell whether one of the settings it depends on (search_path, "
                "standard_conforming_strings, role, session_authorization) is the one being "
                "moved; write the name plainly, or teach gen-enum-catalog.py the form",
                file=sys.stderr,
            )
            sys.exit(1)
        which = None
        m = SET_SEARCH_PATH.match(stmt)
        if m and not IS_DEFAULT.match(m.group(1)) and first_schema(m.group(1)) != "public":
            which = "search_path"
        m = SET_STANDARD_STRINGS.match(stmt)
        if m and not IS_DEFAULT.match(m.group(1)) and not keeps_standard_strings(m.group(1)):
            which = "standard_conforming_strings"
        m = SET_ROLE.match(stmt)
        if m and not IS_NONE.match(m.group(1)) and not IS_DEFAULT.match(m.group(1)):
            which = "role"
        m = SET_SESSION_AUTH.match(stmt)
        if m and not IS_DEFAULT.match(m.group(1)):
            which = "session_authorization"
        which = set_config_changes(stmt, stmt_skel) or which
        if ALTER_SESSION_DEFAULTS.match(stmt_skel) and not ALTER_RESET.search(stmt):
            target = alter_set_target(stmt, stmt_skel)
            if target in GUARDED:
                which = target
        if which in ("role", "session_authorization"):
            print(
                f"FAIL: {path.name}: `{' '.join(stmt.split())[:120]}` switches the current role, and "
                "the default search_path `\"$user\", public` resolves an unqualified "
                "`create/alter/drop type` into a schema named after the CURRENT role when one "
                "exists, so this generator can no longer tell where the type lands; keep the "
                "migration's own role, or qualify the statement with `public.`",
                file=sys.stderr,
            )
            sys.exit(1)
        if which == "standard_conforming_strings":
            print(
                f"FAIL: {path.name}: `{' '.join(stmt.split())[:120]}` turns "
                "standard_conforming_strings off (or to a value this generator cannot read), so "
                "PostgreSQL would read a backslash in every later literal as an escape and the "
                "catalogue would record labels the live enum does not hold; leave it on",
                file=sys.stderr,
            )
            sys.exit(1)
        if which is not None:
            bad = stmt
            print(
                f"FAIL: {path.name}: `{' '.join(bad.split())[:120]}` moves search_path off "
                "`public`, so this generator can no longer tell which schema an unqualified "
                "`create/alter/drop type` lands in; keep `public` first, or teach "
                "gen-enum-catalog.py to track it",
                file=sys.stderr,
            )
            sys.exit(1)


def strip_sql_comments(sql: str) -> str:
    return strip_sql(sql)[0]


# `create schema authorization current_user` brings into existence the schema
# the default path names FIRST, so the next unqualified `create type` lands
# in it — measured — with no role switch for any guard to see; a rename to
# the role's name does the same (Codex round twenty-five). The deploy role is
# not knowable from a file, so the rule is structural: after any schema is
# created or renamed (other than `public` itself), every later enum
# statement, in that file and every file after it, must name `public.`.
SCHEMA_DDL = re.compile(
    r"create\s+schema" + IDENT_END + r"[^;]*;"
    r"|alter\s+schema" + IDENT_END + r"[^;]*" + IDENT_START + r"rename" + IDENT_END + r"[^;]*;"
    r"|drop\s+schema" + IDENT_END + r"[^;]*;",
    re.I | re.S,
)
# `public` is the only schema this catalogue describes, so a migration may
# neither rename it (`alter schema public rename to old_public; create
# schema public;` moves every catalogued enum into `old_public` — measured,
# none left in `public` — while the shipped generator only armed the
# qualification guard and, with no later enum statement, blessed the
# catalogue; Codex round thirty-four) nor drop it (`drop schema public
# cascade` takes every enum with it — measured). Any other schema may be
# created, renamed or dropped; a drop creates no shadow.
# Read off the SKELETON, where a quoted identifier is ONE masked token that
# can hold no comma, no space and no keyword: `drop schema "tenant,archive"`
# was split at the comma inside the name and `alter schema "tenant rename
# archive" rename …` was cut at the word inside it — both legal (measured),
# both refused as unreadable while the names were read off the intact text
# (Codex round thirty-six). Each name is resolved from the intact text at the
# same span, the alter_set_target technique: a quoted name is exact
# (`"Public"` is another schema), a bare one folds.
# A spelling that is neither is refused rather than decoded: PostgreSQL also
# writes an identifier as `U&"…"` with code-point escapes, so `U&"public"`
# and `U&"\0070ublic"` are `public` (measured: the rename moves the enums
# and the drop takes them), and a reader that knew only bare and quoted
# names passed the drop and merely shadowed the rename (Codex round
# thirty-five). Refused for every schema, since the reader cannot tell which
# one it is — code-point escapes plus a UESCAPE clause are more parser than
# fifteen enums earn. A `create schema` it cannot read already falls to the
# conservative branch (a shadow) without decoding.
SCHEMA_BARE = re.compile(r"[A-Za-z_\u0080-\U0010ffff][" + IDENT_CHARS + r"]*")
SCHEMA_RENAME = re.compile(r"^\s*alter\s+schema\s+(.+?)\s+rename" + IDENT_END, re.I | re.S)
# The drop behaviour is a separate KEYWORD: whitespace before it and an
# identifier boundary after it, or `drop schema publiccascade` — a legal
# name (measured) — loses its tail to the keyword and reads as `public`
# (Codex round thirty-seven; the boundary rule round thirty-one settled for
# every keyword in this file, skipped by this regex).
SCHEMA_DROP = re.compile(
    r"^\s*drop\s+schema\s+(?:if\s+exists\s+)?(.*?)(?:\s+(?:cascade|restrict)" + IDENT_END + r")?\s*;?\s*$",
    re.I | re.S,
)
SCHEMA_PART = re.compile(r'"x+"|[^\s,]+')


def schema_name_at(stmt: str, stmt_skel: str, start: int, end: int) -> str | None:
    """The name the skeleton token at [start, end) carries — a quoted one
    exact, a bare one folded — or None for a spelling this reader does not
    know (`U&"…"`, or anything that is not one token)."""
    token = stmt_skel[start:end]
    if QUOTED_IDENT.fullmatch(token):
        return stmt[start + 1 : end - 1].replace('""', '"')
    if SCHEMA_BARE.fullmatch(token):
        return token.lower()
    return None


def schema_targets(stmt: str, stmt_skel: str) -> list[str] | None | bool:
    """The schema names an `alter schema … rename` or `drop schema` names, or
    None when one of them is a spelling this generator does not read; False
    when the statement is neither (a `create schema`)."""
    m = SCHEMA_RENAME.match(stmt_skel)
    if m:
        spans = [(m.start(1), m.end(1))]
    else:
        m = SCHEMA_DROP.match(stmt_skel)
        if not m:
            return False
        spans = [(m.start(1) + p.start(), m.start(1) + p.end()) for p in SCHEMA_PART.finditer(m.group(1))]
    names: list[str] = []
    for lo, hi in spans:
        name = schema_name_at(stmt, stmt_skel, lo, hi)
        if name is None:
            return None
        names.append(name)
    return names
# A SQL-standard routine body (`create procedure … language sql begin atomic
# … end`, PostgreSQL 14+) has no quotes around it, so its statements sit at
# top level for every scan here and its own semicolons split it, so an enum
# created inside one was catalogued as created by the migration (Codex
# round twenty-eight). PostgreSQL 16 refuses create/alter/drop type inside
# such a body at definition time (measured; 17, the target, could not be
# run here), but a body this generator cannot read is refused whether or
# not the server would run it. Write the body as a dollar-quoted string,
# which the body rules read.
ATOMIC_BODY = re.compile(IDENT_START + r"begin\s+atomic" + IDENT_END, re.I)
# The exemption reads the WHOLE identifier: `$` is legal inside an unquoted
# name and `\b` treats it as a boundary, so `create schema public$deploy`
# matched a `public\b` pattern (Codex round twenty-six — round fifteen's
# lesson, one round after it was used; since round thirty-one that boundary
# is IDENT_END, defined once above). `"public"` is the same schema;
# `"Public"` is not.
# Matched on the INTACT text, not the skeleton, which masks a quoted name to
# `"xxxxxx"` (the proof set caught the first version reading the skeleton).
# The unquoted form folds case; the quoted form is exact, so `"PUBLIC"` counts.
# PostgreSQL's lexer treats EVERY non-ASCII byte as an identifier letter, so
# `create schema publicé` is legal (measured) and an ASCII-only lookahead
# exempted it (Codex round twenty-seven); the lookahead refuses any
# identifier character now.
SCHEMA_PUBLIC = re.compile(
    r'^(?i:create\s+schema\s+(?:if\s+not\s+exists\s+)?)(?:(?i:public)' + IDENT_END + r'|"public")'
)
QUALIFIED = re.compile(r"^(?:create|alter)\s+type\s+public\.", re.I)


def collect() -> tuple[dict[str, list[str]], dict[str, list[str]], list[str]]:
    """-> (name -> values in sort order, name -> migration versions that
    created or changed it, creation order).

    Every matched statement is applied in STATEMENT ORDER within a migration,
    not grouped by kind. Codex on PR #88: processing every `create`, then
    every `alter`, then every `drop` turns `drop type if exists mood; create
    type mood as enum (...)` into create-then-drop in memory, so the catalogue
    would omit a live enum while CI reported agreement."""
    values: dict[str, list[str]] = {}
    touched: dict[str, list[str]] = {}
    order: list[str] = []
    shadow: str | None = None  # the migration that created or renamed a schema, if any

    def require_public(path: pathlib.Path, stmt: str, qualified: bool) -> None:
        if shadow is not None and not qualified:
            print(
                f"FAIL: {path.name}: `{' '.join(stmt.split())[:120]}` is unqualified, and a schema "
                f"created or renamed in {shadow} may be the current user's — the default "
                "search_path names `\"$user\"` before `public` — so this generator can no longer "
                "tell where the type lands; qualify it with `public.`",
                file=sys.stderr,
            )
            sys.exit(1)

    for path in sorted(MIGRATIONS.glob("*.sql")):
        version = path.name.split("_", 1)[0]
        try:
            sql, skel = strip_sql(path.read_text())
        except HiddenDDL as e:
            print(
                f"FAIL: {path.name}: enum DDL (or a change of search_path, standard_conforming_strings, "
                f"role or session authorization, or schema DDL) inside a DO body, a "
                f"function body or a dollar-quoted value, which this generator does not read — "
                f"`{e}`; lift it to a top-level statement or teach gen-enum-catalog.py the form",
                file=sys.stderr,
            )
            sys.exit(1)
        if skel.strip() and not skel.rstrip().endswith(";"):
            # PostgreSQL runs a final statement with no `;`; every scan here
            # keys on one (Codex round thirteen), so EOF is made a terminator.
            sql, skel = sql + ";", skel + ";"
        refuse_session_changes(path, sql, skel)
        atomic = ATOMIC_BODY.search(skel)
        if atomic:
            start = skel.rfind(";", 0, atomic.start()) + 1
            print(
                f"FAIL: {path.name}: `{' '.join(sql[start:atomic.end()].split())[:120]} …` is a SQL-standard "
                "routine body (BEGIN ATOMIC), which this generator does not read: its statements "
                "run when the routine is called, not when the migration applies; write the body "
                "as a dollar-quoted string instead",
                file=sys.stderr,
            )
            sys.exit(1)
        # Scan the SKELETON: a literal's contents cannot open, close or name a
        # statement. Spans line up with `sql`, which is where labels are read.
        creates = list(CREATE.finditer(skel))
        alters = list(ALTER.finditer(skel))
        drops = list(DROP.finditer(skel))
        for kind, loose_re, strict in (
            ("create type … as enum", CREATE_ANY, creates),
            ("alter type", ALTER_ANY, alters),
            ("drop type", DROP_ANY, drops),
        ):
            strict_starts = {m.start() for m in strict}
            for loose in loose_re.finditer(skel):
                if loose.start() not in strict_starts:
                    print(
                        f"FAIL: {path.name}: `{' '.join(sql[loose.start():loose.end()].split())}` is a `{kind}` "
                        "this generator cannot read; teach gen-enum-catalog.py the shape rather "
                        "than letting the catalogue silently disagree with the migrations",
                        file=sys.stderr,
                    )
                    sys.exit(1)
        schemas = [m for m in SCHEMA_DDL.finditer(skel) if not SCHEMA_PUBLIC.match(sql[m.start() : m.end()])]
        stream = sorted(
            [(m.start(), "create", m) for m in creates]
            + [(m.start(), "alter", m) for m in alters]
            + [(m.start(), "drop", m) for m in drops]
            + [(m.start(), "schema", m) for m in schemas],
            key=lambda item: item[0],
        )
        for _, kind, m in stream:
            if kind == "schema":
                stmt, stmt_skel = sql[m.start() : m.end()], skel[m.start() : m.end()]
                targets = schema_targets(stmt, stmt_skel)
                if targets is None:
                    print(
                        f"FAIL: {path.name}: `{' '.join(stmt.split())[:120]}` carries a schema name "
                        "this generator cannot read (a U&\"…\" Unicode-escaped identifier, or another "
                        "spelling), so it cannot tell whether `public` — the only schema this "
                        "catalogue describes — is the one renamed or dropped; write the name plainly, "
                        "or teach gen-enum-catalog.py the form",
                        file=sys.stderr,
                    )
                    sys.exit(1)
                if targets and "public" in targets:
                    print(
                        f"FAIL: {path.name}: `{' '.join(stmt.split())[:120]}` renames or drops "
                        "`public`, the only schema this catalogue describes, so every enum it "
                        "records would no longer be where the catalogue says; keep `public` in "
                        "place, or teach gen-enum-catalog.py to follow it",
                        file=sys.stderr,
                    )
                    sys.exit(1)
                if SCHEMA_DROP.match(stmt_skel):
                    continue  # dropping another schema creates no shadow
                shadow = version
                continue
            if kind == "drop":
                for raw in m.group(1).split(","):
                    require_public(path, sql[m.start() : m.end()], raw.strip().lower().startswith("public."))
                    name = raw.strip().lower().removeprefix("public.")
                    values.pop(name, None)
                    touched.pop(name, None)
                    if name in order:
                        order.remove(name)
                continue
            name = m.group(1).lower()
            require_public(path, sql[m.start() : m.end()], bool(QUALIFIED.match(skel[m.start() : m.end()])))
            if kind == "create":
                body = sql[m.start(2) : m.end(2)]
                if not ENUM_BODY.match(body):
                    print(
                        f"FAIL: {path.name}: `create type {name} as enum ({' '.join(body.split())})` "
                        "carries a label this generator cannot read (an E'' escape string, a "
                        "dollar-quoted label, or a stray token); use a plain '...' literal or "
                        "teach gen-enum-catalog.py the form",
                        file=sys.stderr,
                    )
                    sys.exit(1)
                values[name] = [unquote(v) for v in LABEL.findall(body)]
                touched[name] = [version]
                if name not in order:
                    order.append(name)
            elif kind == "alter":
                if name not in values:
                    continue  # not an enum this file tracks (a composite, say)
                action = sql[m.start(2) : m.end(2)]  # intact: labels keep their whitespace
                add = ADD_VALUE.match(action)
                ren = RENAME_VALUE.match(action)
                if add:
                    label, where = unquote(add.group(1)), add.group(2)
                    anchor = unquote(add.group(3)) if add.group(3) else None
                    if label in values[name]:
                        continue  # `if not exists` on a redelivery: no change
                    if where and anchor in values[name]:
                        at = values[name].index(anchor) + (1 if where.lower() == "after" else 0)
                        values[name].insert(at, label)
                    else:
                        values[name].append(label)
                elif ren:
                    old, new = unquote(ren.group(1)), unquote(ren.group(2))
                    values[name] = [new if v == old else v for v in values[name]]
                else:
                    print(
                        f"FAIL: {path.name}: `alter type {name} {' '.join(action.split())}` is neither "
                        "`add value` nor `rename value`; teach gen-enum-catalog.py what it "
                        "means rather than letting the catalogue describe a type that "
                        "no longer matches the migrations",
                        file=sys.stderr,
                    )
                    sys.exit(1)
                touched.setdefault(name, []).append(version)
    for name in order:
        for label in values[name]:
            if any(ord(ch) < 32 or ord(ch) == 127 for ch in label) or not label.strip():
                # A label with a newline cannot be shown on one catalogue line
                # without inventing an escape scheme (Codex round fourteen),
                # and one made only of spaces cannot be shown at its true
                # length — CommonMark keeps every space of an all-space code
                # span, padding included (round fifteen).
                print(
                    f"FAIL: enum `{name}` carries a label the catalogue cannot render "
                    f"faithfully, {label!r} (a control character, or only whitespace)",
                    file=sys.stderr,
                )
                sys.exit(1)
    return values, touched, order


def code_span(label: str) -> str:
    """A Markdown code span that shows `label` exactly: the fence is one
    backtick longer than any run inside it, and a label that starts or ends
    with a space or a backtick is padded by one space on each side, which
    CommonMark strips. A label rendered bare could not be told from two —
    `'two · labels'` is one legal PostgreSQL label (Codex round fourteen)."""
    fence = "`" * (max((len(r) for r in re.findall(r"`+", label)), default=0) + 1)
    pad = " " if (label[:1] in (" ", "`") or label[-1:] in (" ", "`")) else ""
    return f"{fence}{pad}{label}{pad}{fence}"


def render(values: dict[str, list[str]], touched: dict[str, list[str]], order: list[str]) -> str:
    lines = [
        BEGIN,
        "",
        f"{len(order)} enum types, in migration order. Generated by",
        "`scripts/gen-enum-catalog.py`; CI fails if this list and the migrations",
        "disagree, so adding a value without regenerating breaks the build. Values",
        "are in `enumsortorder`, each shown as a code span so a label containing",
        "the separator, a backtick or Markdown syntax reads as one value. The",
        "parenthesis names the migration that created the type, then every",
        "migration that added or renamed a value.",
        "",
    ]
    for name in order:
        versions = touched[name]
        created = versions[0]
        later = sorted(set(versions[1:]) - {created})  # altered in its own migration is not a later change
        where = created + "".join(f", +{v}" for v in later)
        # An enum created empty and never populated has nothing to list; say so
        # in a form no value can take (every value is a code span).
        shown = " · ".join(code_span(v) for v in values[name]) or "(no values)"
        lines.append(f"- `{name}` ({where}): {shown}")
    lines += ["", END]
    return "\n".join(lines)


def main() -> int:
    values, touched, order = collect()
    if not order:
        # A parser that sees nothing reports agreement. Refuse instead.
        print("FAIL: no `create type ... as enum` found under supabase/migrations", file=sys.stderr)
        return 1
    block = render(values, touched, order)
    spec = SPEC.read_text()
    if BEGIN not in spec or END not in spec:
        print(f"FAIL: {SPEC} has no generated-enum-catalog markers", file=sys.stderr)
        return 1
    updated = re.sub(re.escape(BEGIN) + r".*?" + re.escape(END), lambda _: block, spec, flags=re.S)
    if updated != spec:
        SPEC.write_text(updated)
    print(f"{len(order)} enum types catalogued in {SPEC.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
