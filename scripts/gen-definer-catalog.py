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

Reading them means lexing SQL, and that lexer is `gen-enum-catalog.py`'s
`strip_sql` — ONE implementation with two callers, imported rather than
copied. This file used to carry its own comment stripper: a block-comment
regex and then `--` to end of line, which is exactly the pair the enum
catalogue's generator had to replace, because it disagrees with PostgreSQL in
BOTH directions. Block comments NEST, so a non-greedy regex closes at the
inner marker and reads the rest of a comment as live SQL; and a `--`, a `/*`
or a `*/` inside a string literal is DATA, so the regex deletes SQL that
runs. Both were measured against this repository's own Postgres and both made
this catalogue wrong — a definer function missing from it, a grant that does
not exist listed on it, a real grant dropped from it, a function that does not
exist added to it, and a healthy migration failing the anon check. The probes
live in
`scripts/gen-enum-catalog-proofs.py`, which is where the lexer's proofs live.

The lexer stays in the enum generator rather than moving to a third module
because that file's proof set walks its SOURCE — every `re` use, every
pattern factory, every `text_re` exemption recorded by name — and splitting
it would leave those guards blind to half the lexer, which is the
parser-that-sees-nothing defect they exist to prevent.

Statement scans run on the SKELETON the lexer returns — the same text with
the CONTENTS of every string literal and quoted identifier masked — so a
sentence in a `comment on` that quotes a grant is prose rather than a grant,
and names are read out of the clean text at the same spans. A dollar-quoted
body is blanked by the lexer, so a `raise exception` quoting a
`create … function` no longer puts a function that does not exist into the
catalogue.

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
LEXER = ROOT / "scripts" / "gen-enum-catalog.py"

BEGIN = "<!-- BEGIN GENERATED DEFINER CATALOG -->"
END = "<!-- END GENERATED DEFINER CATALOG -->"


# What this file needs from the lexer, declared rather than discovered: a name
# renamed there would otherwise reach a reader here as an AttributeError
# traceback, which is a broken helper reading as a broken rule — the shape the
# enum generator's own proof set had to fix when a private scanner name was
# renamed and the suite died instead of failing. `gen-enum-catalog-proofs.py`
# asserts this list against the lexer, so the seam is a rule with a gate
# behind it rather than an import that happens to work.
LEXER_SEAM = ("strip_sql", "sql_re", "HiddenDDL", "UnreadableIdentifier")


def load_lexer():
    """The shared SQL lexer, loaded by path: the file name carries hyphens, so
    it cannot be imported by name and is loaded the way
    `gen-enum-catalog-proofs.py` loads it. Both failures — the file not
    loading, and the seam not being there — are named FAILs rather than
    tracebacks (the `repo-functions.sh` lesson)."""
    try:
        spec = importlib.util.spec_from_file_location("gen_enum_catalog", LEXER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    except Exception as e:  # noqa: BLE001 — the subject failing to load is the first thing to say plainly
        print(
            f"FAIL: the shared SQL lexer in {LEXER.name} could not be loaded "
            f"({type(e).__name__}: {e}); this file reads migrations through it and cannot "
            "run without it",
            file=sys.stderr,
        )
        sys.exit(1)
    missing = [name for name in LEXER_SEAM if not hasattr(module, name)]
    if missing:
        print(
            f"FAIL: {LEXER.name} no longer exports {', '.join(missing)} — this file reads "
            "migrations through that lexer, so a rename there is a change here; move the "
            "names in the same commit",
            file=sys.stderr,
        )
        sys.exit(1)
    return module


LEX = load_lexer()

# Built by the lexer's own SQL factory, so the rule it enforces at
# construction — no Python word boundary in a regex that reads SQL, because
# `\b` stops where PostgreSQL's lexer continues an identifier — reaches these
# patterns too rather than stopping at the file that owns the factory.
#
# `create [or replace] function name(args) ... returns` — args may span lines
# and contain nested parens (e.g. numeric(10,2)), so the header is taken up to
# the last `)` before `returns`.
CREATE = LEX.sql_re(
    r"create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\(",
    re.I,
)
GRANT = LEX.sql_re(
    r"grant\s+execute\s+on\s+function\s+(?:public\.)?([a-z0-9_]+)\s*\([^;]*?\)\s*to\s+([^;]+);",
    re.I | re.S,
)
# Matched on the SKELETON, so `comment on function fn_x() is 'SECURITY DEFINER
# because …'` is a sentence ABOUT the function rather than a clause of it.
SECURITY_DEFINER = LEX.sql_re(r"security\s+definer", re.I)


def read_sql(path: pathlib.Path) -> tuple[str, str]:
    """-> (clean, skeleton) for one migration, through the shared lexer.

    The lexer refuses what it cannot read rather than modelling it, and those
    refusals are inherited here on purpose: a body it cannot read can hide a
    `grant execute` behind an EXECUTE as easily as it can hide enum DDL, and
    an identifier spelled by code point can name any function. Every file
    refused here is refused by gate 10e as well — both gates read the same
    migrations through the same lexer — so this adds no independent red, only
    a second sentence about the same file."""
    try:
        return LEX.strip_sql(path.read_text())
    except LEX.UnreadableIdentifier as e:
        print(
            f'FAIL: {path.name}: `{e}` carries a U&"…" Unicode-escaped identifier, which the '
            "shared SQL lexer does not read — spelled by code point it can name anything, a "
            "function or a role included; write the name plainly (gate 10e says the same)",
            file=sys.stderr,
        )
        sys.exit(1)
    except LEX.HiddenDDL as e:
        print(
            f"FAIL: {path.name}: the shared SQL lexer cannot read this file — `{e}`; lift it to "
            "a top-level statement or teach gen-enum-catalog.py the form (gate 10e says the same)",
            file=sys.stderr,
        )
        sys.exit(1)


def function_body_after(skel: str, start: int) -> str:
    """Everything from a create-function header to the end of its body, bounded
    by the next `create ... function` so one function's SET cannot be read as
    another's."""
    nxt = CREATE.search(skel, start + 1)
    return skel[start : nxt.start() if nxt else len(skel)]


def collect() -> tuple[dict[str, bool], dict[str, set[str]], list[str]]:
    """-> (name -> is_definer for its LAST definition, name -> granted roles,
    migration order)."""
    definer: dict[str, bool] = {}
    grants: dict[str, set[str]] = {}
    order: list[str] = []
    for path in sorted(MIGRATIONS.glob("*.sql")):
        clean, skel = read_sql(path)
        for m in CREATE.finditer(skel):
            # Matched where values are masked and read where they are
            # intact — the lexer's own technique. The MATCH on the skeleton is
            # what these probes pin; the read from `clean` changes no row this
            # schema can produce (a name is an identifier, so its span never
            # overlaps a mask), and it is here so the two halves of the lexer
            # are never read against each other rather than because a defect
            # was found.
            name = clean[m.start(1) : m.end(1)]
            chunk = function_body_after(skel, m.start())
            # Last definition wins: `create or replace` in a later migration is
            # what Postgres actually has. Reading the first would describe a
            # function that no longer exists — the same trap the payment-status
            # index parser had to avoid.
            definer[name] = bool(SECURITY_DEFINER.search(chunk))
            if name not in order:
                order.append(name)
        for m in GRANT.finditer(skel):
            name = clean[m.start(1) : m.end(1)]
            roles = {r.strip() for r in clean[m.start(2) : m.end(2)].split(",") if r.strip()}
            grants.setdefault(name, set()).update(roles)
    return definer, grants, order


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
    if any(r in grants.get(n, set()) for n in order if definer.get(n) for r in ("anon", "public")):
        print("FAIL: a definer function grants EXECUTE to anon or PUBLIC", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
