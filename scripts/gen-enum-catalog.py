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
ADD_VALUE = re.compile(
    r"^add\s+value\s+(?:if\s+not\s+exists\s+)?" + LIT + r"(?:\s+(before|after)\s+" + LIT + r")?$",
    re.I | re.S,
)
RENAME_VALUE = re.compile(r"^rename\s+value\s+" + LIT + r"\s+to\s+" + LIT + r"$", re.I | re.S)
# Every `drop type` statement, loosely, so an unparsed one can be REFUSED —
# and the strict shape Postgres allows: a comma list of names, optional
# CASCADE/RESTRICT. Codex on PR #88 round two: the first regex demanded the
# semicolon straight after the name, so `drop type payment_status cascade;`
# matched nothing and the dropped enum stayed in the catalogue while CI
# reported agreement — a parser that sees nothing reports agreement.
DROP_ANY = re.compile(r"drop\s+type\b[^;]*;", re.I | re.S)
# The same loose-versus-strict pairing for the other two statement kinds
# (Codex round three): `create type public."delivery_status" as enum (…)` is
# valid SQL the strict regex does not read, and with fifteen enums already
# in `order` the parser-saw-nothing guard cannot notice one skipped type.
CREATE_ANY = re.compile(r"create\s+type\b[^;]*?\bas\s+enum\b[^;]*;", re.I | re.S)
ALTER_ANY = re.compile(r"alter\s+type\b[^;]*;", re.I | re.S)
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
ENUM_BODY = re.compile(r"^\s*" + LIT + r"(?:\s*,\s*" + LIT + r")*\s*,?\s*$", re.S)


def unquote(lit: str) -> str:
    return lit.replace("''", "'")


DOLLAR_TAG = re.compile(r"[$](?:[A-Za-z_][A-Za-z0-9_]*)?[$]")
DDL_INSIDE = re.compile(r"\b(?:create|alter|drop)\s+type\b", re.I)


class DollarQuotedDDL(Exception):
    """A dollar-quoted body carries enum DDL this generator does not read."""


def strip_sql(sql: str, *, inside_dollar: bool = False) -> tuple[str, str]:
    """-> (clean, skeleton). Both have `--` and /* */ comments removed —
    OUTSIDE string literals and quoted identifiers, with nesting, and with a
    space left where a block comment stood, since PostgreSQL reads it as
    whitespace. `clean` keeps every literal intact; `skeleton` is the same
    text, same length, with each literal's CONTENTS replaced by `x`, so the
    statement scans can run on the skeleton (a `;` or `drop type` inside a
    value is not a terminator or a statement — Codex round six) and read the
    real labels out of `clean` at the same spans.

    A dollar-quoted region (`$$…$$`, `$tag$…$tag$`) is a value, not a
    statement, so it is blanked in both outputs after its own comments are
    stripped; if its skeleton still carries `create/alter/drop type` the run
    is refused by name rather than guessed at — top-level statements are all
    this generator reads, and DDL inside a DO body is the author's to lift
    out. Inside such a region a `$word$` is text, never a nested quote."""
    out: list[str] = []
    skel: list[str] = []
    i, n = 0, len(sql)
    state = "code"
    depth = 0
    escapes = False  # inside an E'...' literal a backslash escapes the next char

    def both(ch: str) -> None:
        out.append(ch)
        skel.append(ch)

    while i < n:
        c = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if state == "code":
            tag = DOLLAR_TAG.match(sql, i) if (c == "$" and not inside_dollar) else None
            if tag:
                close = sql.find(tag.group(0), tag.end())
                if close < 0:
                    raise DollarQuotedDDL(f"unterminated dollar quote {tag.group(0)}")
                _, inner_skel = strip_sql(sql[tag.end() : close], inside_dollar=True)
                if DDL_INSIDE.search(inner_skel):
                    raise DollarQuotedDDL(" ".join(sql[i : close + len(tag.group(0))].split())[:120])
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
            elif c == '"':
                state = "dq"
            both(c)
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
                both(c)
                state = "code"
            else:
                out.append(c); skel.append("x")
        elif state == "dq":
            both(c)
            if c == '"':
                state = "code"
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


def strip_sql_comments(sql: str) -> str:
    return strip_sql(sql)[0]


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
    for path in sorted(MIGRATIONS.glob("*.sql")):
        version = path.name.split("_", 1)[0]
        try:
            sql, skel = strip_sql(path.read_text())
        except DollarQuotedDDL as e:
            print(
                f"FAIL: {path.name}: enum DDL inside a dollar-quoted value or body, which this "
                f"generator does not read — `{e}`; lift it to a top-level statement or teach "
                "gen-enum-catalog.py the form",
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
        stream = sorted(
            [(m.start(), "create", m) for m in creates]
            + [(m.start(), "alter", m) for m in alters]
            + [(m.start(), "drop", m) for m in drops],
            key=lambda item: item[0],
        )
        for _, kind, m in stream:
            if kind == "drop":
                for raw in m.group(1).split(","):
                    name = raw.strip().lower().removeprefix("public.")
                    values.pop(name, None)
                    touched.pop(name, None)
                    if name in order:
                        order.remove(name)
                continue
            name = m.group(1).lower()
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
                action = " ".join(sql[m.start(2) : m.end(2)].split())
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
                        f"FAIL: {path.name}: `alter type {name} {action}` is neither "
                        "`add value` nor `rename value`; teach gen-enum-catalog.py what it "
                        "means rather than letting the catalogue describe a type that "
                        "no longer matches the migrations",
                        file=sys.stderr,
                    )
                    sys.exit(1)
                touched.setdefault(name, []).append(version)
    return values, touched, order


def render(values: dict[str, list[str]], touched: dict[str, list[str]], order: list[str]) -> str:
    lines = [
        BEGIN,
        "",
        f"{len(order)} enum types, in migration order. Generated by",
        "`scripts/gen-enum-catalog.py`; CI fails if this list and the migrations",
        "disagree, so adding a value without regenerating breaks the build. Values",
        "are in `enumsortorder`. The parenthesis names the migration that created",
        "the type, then every migration that added or renamed a value.",
        "",
    ]
    for name in order:
        versions = touched[name]
        created = versions[0]
        later = sorted(set(versions[1:]) - {created})  # altered in its own migration is not a later change
        where = created + "".join(f", +{v}" for v in later)
        lines.append(f"- `{name}` ({where}): " + " · ".join(values[name]))
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
