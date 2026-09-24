#!/usr/bin/env python3
"""Regenerate spec 03's SECURITY DEFINER catalogue from the migrations.

Review H21: the catalogue was hand-maintained, presented as "the complete
grant-audit checklist", and listed 11 functions out of 52. An engineer adding a
definer function and checking their grants against it had no idea 41 peers
existed — which is the opposite of what a checklist is for.

A hand-maintained list of 52 entries would rot again by the next migration, so
it is generated instead, and CI asserts the committed file matches (the same
shape as the `gen-types.py` drift check). Adding a definer function without
regenerating fails the build, and the failure names the function.

The grants are read from the migrations rather than from a live database on
purpose: this runs in CI with no Postgres service in the frontend job, and the
migrations are the append-only source of truth that a `db push` will apply.

The migrations are read by `gen-enum-catalog.py`'s SQL reader, not a copy of
it. This file used to strip comments with a regex pair — `/\*.*?\*/` then
`--[^\n]*` — which is the pair the enum generator had to replace: it cut a
statement at a `--` inside a string literal (dropping a GRANT that shared the
line), let a nested block comment end early (exposing a commented-out CREATE),
and read a `/*` inside a literal as the start of a comment that swallowed the
statements after it (spec-drift audit). The shared reader's review rounds
already paid for all three; a second copy would have to pay again. Statements
are found on its SKELETON, where the contents of every literal and quoted name
are masked, so a `COMMENT ON` string that says "security definer" or "create
function" is not read as code; names and roles are read from the clean text at
the same spans. `scripts/gen-definer-catalog-proofs.py` holds the probes.

The reader blanks every DO and function body, which hid a function created and
granted by dynamic SQL inside one: a publicly executable definer function this
catalogue never saw (Codex, on #97). So the reader refuses a body that creates,
alters or drops a routine, or grants or revokes on one, by name, and the
statement belongs at top level, where this file reads it. At top level it reads
`create [or replace] function` and `grant execute on function <name>(…) to …`,
and nothing else: revokes are not applied, which over-reports rather than
hides, while ALTER FUNCTION, a grant in any other shape, ALTER DEFAULT
PRIVILEGES and procedures are not modelled at all.

Writes between the markers in docs/spec/03-security-model.md. Idempotent.
"""
from __future__ import annotations

import importlib.util
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
MIGRATIONS = ROOT / "supabase" / "migrations"
SPEC = ROOT / "docs" / "spec" / "03-security-model.md"

BEGIN = "<!-- BEGIN GENERATED DEFINER CATALOG -->"
END = "<!-- END GENERATED DEFINER CATALOG -->"

# `create [or replace] function name(args) ... returns` — args may span lines
# and contain nested parens (e.g. numeric(10,2)), so the header is taken up to
# the last `)` before `returns`.
CREATE = re.compile(
    r"create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\(",
    re.I,
)
GRANT = re.compile(
    r"grant\s+execute\s+on\s+function\s+(?:public\.)?([a-z0-9_]+)\s*\([^;]*?\)\s*to\s+([^;]+);",
    re.I | re.S,
)
# A grantee as PostgreSQL resolves it (Codex, on #97): a quoted name is
# exact, doubled quotes read as one, and an unquoted one folds to lower case,
# so `TO PUBLIC` and `TO Anon` are `public` and `anon` (measured). Stored as
# written, `PUBLIC` was a role no check below recognised. Anything else, such
# as `GROUP anon` or `anon WITH GRANT OPTION`, is refused by name rather than
# read as a role; the ACL reader that replaces this one does the same.
ROLE = re.compile(r'\s*(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_$]*))\s*')


def load_reader():
    """`gen-enum-catalog.py`, loaded by path because its name has dashes."""
    path = ROOT / "scripts" / "gen-enum-catalog.py"
    spec = importlib.util.spec_from_file_location("gen_enum_catalog", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


READER = load_reader()


def read_migration(path: pathlib.Path) -> tuple[str, str]:
    """-> (clean, skeleton): comments gone, dollar-quoted bodies blanked, and in
    the skeleton every literal's and quoted name's contents masked. A migration
    the reader refuses is refused here too, by name — the enum gate (10e)
    refuses it on the same reading, so this adds no new way to fail."""
    try:
        return READER.strip_sql(path.read_text())
    except READER.HiddenDDL as e:
        print(
            f"FAIL: {path.name}: the SQL reader shared with gen-enum-catalog.py refused it — {e}. "
            "It blanks every DO and function body, so a routine created, altered, dropped, granted "
            "or revoked inside one is refused rather than left unseen; lift the statement to top level",
            file=sys.stderr,
        )
        raise SystemExit(1)


def function_body_after(sql: str, start: int) -> str:
    """Everything from a create-function header to the end of its body, bounded
    by the next `create ... function` so one function's SET cannot be read as
    another's."""
    nxt = CREATE.search(sql, start + 1)
    return sql[start : nxt.start() if nxt else len(sql)]


def collect() -> tuple[dict[str, bool], dict[str, set[str]], list[str]]:
    """-> (name -> is_definer for its LAST definition, name -> granted roles,
    migration order)."""
    definer: dict[str, bool] = {}
    grants: dict[str, set[str]] = {}
    order: list[str] = []
    for path in sorted(MIGRATIONS.glob("*.sql")):
        clean, skel = read_migration(path)
        for m in CREATE.finditer(skel):
            name = m.group(1)
            chunk = function_body_after(skel, m.start())
            # Last definition wins: `create or replace` in a later migration is
            # what Postgres actually has. Reading the first would describe a
            # function that no longer exists — the same trap the payment-status
            # index parser had to avoid.
            definer[name] = bool(re.search(r"security\s+definer", chunk, re.I))
            if name not in order:
                order.append(name)
        for m in GRANT.finditer(skel):
            grants.setdefault(m.group(1), set()).update(grantees(clean, skel, m.start(2), m.end(2), path))
    return definer, grants, order


def grantees(clean: str, skel: str, a: int, b: int, path: pathlib.Path) -> set[str]:
    """The roles one GRANT names. Split where the skeleton has a comma, which a
    quoted name cannot supply, and read from the clean text at the same spans,
    since a quoted name is masked in the skeleton."""
    out: set[str] = set()
    start = a
    for i in range(a, b + 1):
        if i < b and skel[i] != ",":
            continue
        m = ROLE.fullmatch(clean[start:i])
        if not m:
            print(
                f"FAIL: {path.name}: a grantee it cannot read: {' '.join(clean[start:i].split())!r}",
                file=sys.stderr,
            )
            raise SystemExit(1)
        out.add(m.group(1).replace('""', '"') if m.group(1) is not None else m.group(2).lower())
        start = i + 1
    return out


def exposed(definer: dict[str, bool], grants: dict[str, set[str]], order: list[str]) -> list[str]:
    """The definer functions PUBLIC or anon can execute: invariant 5's refusal."""
    return [n for n in order if definer.get(n) and grants.get(n, set()) & {"anon", "public"}]


def render(definer: dict[str, bool], grants: dict[str, set[str]], order: list[str]) -> str:
    names = [n for n in order if definer.get(n)]
    lines = [
        BEGIN,
        "",
        f"{len(names)} `SECURITY DEFINER` functions, in migration order. Generated by",
        "`scripts/gen-definer-catalog.py`; CI fails if this table and the migrations",
        "disagree, so adding a definer function without regenerating breaks the build.",
        "",
        "*Granted to* is the union of every `GRANT EXECUTE` across all migrations for",
        "that name. **none** means no API role can call it — service-role and other",
        "definer functions only, which is the correct default.",
        "",
        "| Function | EXECUTE granted to |",
        "|---|---|",
    ]
    for name in names:
        roles = sorted(grants.get(name, set()))
        # service_role holds BYPASSRLS and is granted table-wide, so listing it
        # per function says nothing; what matters is which API role can reach in.
        api = [r for r in roles if r in ("authenticated", "anon", "public")]
        shown = ", ".join(f"`{r}`" for r in api) if api else "**none**"
        lines.append(f"| `{name}` | {shown} |")
    lines += ["", END]
    return "\n".join(lines)


def main() -> int:
    definer, grants, order = collect()
    block = render(definer, grants, order)
    spec = SPEC.read_text()
    if BEGIN in spec and END in spec:
        updated = re.sub(
            re.escape(BEGIN) + r".*?" + re.escape(END), lambda _: block, spec, flags=re.S
        )
    else:
        print(f"FAIL: {SPEC} has no generated-catalog markers", file=sys.stderr)
        return 1
    if updated != spec:
        SPEC.write_text(updated)
    count = sum(1 for n in order if definer.get(n))
    print(f"{count} SECURITY DEFINER functions catalogued in {SPEC.relative_to(ROOT)}")
    if exposed(definer, grants, order):
        print("FAIL: a definer function grants EXECUTE to anon or PUBLIC: " + ", ".join(exposed(definer, grants, order)),
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
