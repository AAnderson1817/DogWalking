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
ADD_VALUE = re.compile(
    r"^add\s+value\s+(?:if\s+not\s+exists\s+)?'([^']+)'(?:\s+(before|after)\s+'([^']+)')?$",
    re.I | re.S,
)
RENAME_VALUE = re.compile(r"^rename\s+value\s+'([^']+)'\s+to\s+'([^']+)'$", re.I | re.S)
# Every `drop type` statement, loosely, so an unparsed one can be REFUSED —
# and the strict shape Postgres allows: a comma list of names, optional
# CASCADE/RESTRICT. Codex on PR #88 round two: the first regex demanded the
# semicolon straight after the name, so `drop type payment_status cascade;`
# matched nothing and the dropped enum stayed in the catalogue while CI
# reported agreement — a parser that sees nothing reports agreement.
DROP_ANY = re.compile(r"drop\s+type\b[^;]*;", re.I | re.S)
DROP = re.compile(
    r"drop\s+type\s+(?:if\s+exists\s+)?((?:(?:public\.)?[a-z0-9_]+\s*,\s*)*(?:public\.)?[a-z0-9_]+)"
    r"\s*(?:cascade|restrict)?\s*;",
    re.I | re.S,
)
LABEL = re.compile(r"'([^']*)'")


def strip_sql_comments(sql: str) -> str:
    """`--` to end of line, and /* */ blocks. A commented-out `add value` is
    not a value (0051 discusses one in prose)."""
    sql = re.sub(r"/\*.*?\*/", "", sql, flags=re.S)
    return re.sub(r"--[^\n]*", "", sql)


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
        sql = strip_sql_comments(path.read_text())
        drops = list(DROP.finditer(sql))
        strict_starts = {m.start() for m in drops}
        for loose in DROP_ANY.finditer(sql):
            if loose.start() not in strict_starts:
                print(
                    f"FAIL: {path.name}: `{' '.join(loose.group(0).split())}` is a `drop type` "
                    "this generator cannot read; teach gen-enum-catalog.py the shape rather "
                    "than letting the catalogue keep a type the migrations dropped",
                    file=sys.stderr,
                )
                sys.exit(1)
        stream = sorted(
            [(m.start(), "create", m) for m in CREATE.finditer(sql)]
            + [(m.start(), "alter", m) for m in ALTER.finditer(sql)]
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
                values[name] = LABEL.findall(m.group(2))
                touched[name] = [version]
                if name not in order:
                    order.append(name)
            elif kind == "alter":
                if name not in values:
                    continue  # not an enum this file tracks (a composite, say)
                action = " ".join(m.group(2).split())
                add = ADD_VALUE.match(action)
                ren = RENAME_VALUE.match(action)
                if add:
                    label, where, anchor = add.group(1), add.group(2), add.group(3)
                    if label in values[name]:
                        continue  # `if not exists` on a redelivery: no change
                    if where and anchor in values[name]:
                        at = values[name].index(anchor) + (1 if where.lower() == "after" else 0)
                        values[name].insert(at, label)
                    else:
                        values[name].append(label)
                elif ren:
                    old, new = ren.group(1), ren.group(2)
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
