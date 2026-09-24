#!/usr/bin/env python3
"""Regenerate spec 03's SECURITY DEFINER catalogue from the migrations.

Review H21: the catalogue was hand-maintained, presented as "the complete
grant-audit checklist", and listed 11 functions out of 48. An engineer adding a
definer function and checking their grants against it had no idea 37 peers
existed — which is the opposite of what a checklist is for.

A hand-maintained list would rot again by the next migration, so it is
generated instead, and CI asserts the committed file matches (the same
shape as the `gen-types.py` drift check). Adding a definer function without
regenerating fails the build, and the failure names the function.

The grants are read from the migrations rather than from a live database on
purpose: they are the append-only source of truth that a `db push` will apply.
Gate 8e (`scripts/check-definer-catalog-live.py`) then compares what this
model says with what a reset database actually holds, so the model cannot
drift from Postgres unnoticed.

The migrations are read by `gen-enum-catalog.py`'s SQL reader, not a copy of
it. This file used to strip comments with a regex pair — `/\\*.*?\\*/` then
`--[^\\n]*` — which is the pair the enum generator had to replace: it cut a
statement at a `--` inside a string literal (dropping a GRANT that shared the
line), let a nested block comment end early (exposing a commented-out CREATE),
and read a `/*` inside a literal as the start of a comment that swallowed the
statements after it (spec-drift audit). The shared reader's review rounds
already paid for all three; a second copy would have to pay again. Statements
are found on its SKELETON, where the contents of every literal and quoted name
are masked, so a `COMMENT ON` string that says "security definer" or "create
function" is not read as code; names, types and roles are read from the clean
text at the same spans. `scripts/gen-definer-catalog-proofs.py` holds the
probes.

**It models each function's ACL; it used to collect GRANTs** (spec-drift
audit, PR B). A function nobody grants is not a function nobody can call:
PostgreSQL gives EXECUTE on every new function to PUBLIC, and the platform's
default privileges add `anon`, `authenticated` and `service_role`
(`scripts/local-stack/shim.sql` models them, and a proof pins this file's
default to that one). Reading grants alone, four trigger functions that PUBLIC
and anon could execute were catalogued as **none**. So each function starts at
that default, and every statement that changes an ACL is applied in the order
PostgreSQL applies it:

  - CREATE of a new signature starts at the default;
  - CREATE OR REPLACE of an existing signature keeps its ACL, as Postgres does;
  - DROP removes the signature;
  - GRANT and REVOKE add and remove roles.

A function is its name AND its argument types, and so is this model: 0026
created a new overload of `fn_apply_invoice_paid` and then dropped the old
one, which a name-keyed model reads as the function disappearing — and the new
overload starts at the default ACL, not at the old one's revokes.

It refuses two things invariant 5 forbids: a definer function PUBLIC or anon
can execute, and one `authenticated` can execute only because the platform's
default privileges gave it — `revoke … from public, anon` leaves exactly that
behind, and it is how a service-role-only function becomes callable by every
signed-in user (PR B review).

What it cannot read it REFUSES by name rather than modelling (the enum
generator's rule): a routine grant in any other shape, ALTER FUNCTION (all
but one shape: a single `SET search_path` to a list of plain names, on a
signature it knows, which changes nothing it models — 0055 moved every
pinned path to `public, pg_temp` that way), ALTER DEFAULT PRIVILEGES,
procedures, a quoted or non-public name, a parameter
mode, a `%type` or quoted argument, `with grant option`, `granted by`, a role
only known at run time — and the statements that change functions without
naming them: a DROP … CASCADE on a type, table, schema or anything else a
function can depend on, a range type (whose constructors no statement names),
and a `drop function if exists` of a signature it does not know while the name
exists with another. A body is the one place it does not read, since the
shared reader blanks every DO and function body; so the reader REFUSES a body
that creates, alters or drops a routine, or grants or revokes on one, by name
(Codex, on #97: a DO block that created a definer function and granted it to
PUBLIC was otherwise invisible here), and the statement belongs at top level,
where this model reads it. What stays unseen is SQL assembled to evade that
refusal, such as a verb supplied through a `format()` placeholder. Gate 8e is
the backstop for both kinds of blindness: it compares this model with a reset
database, so a grant assembled in a body, or a statement this model misread,
fails the build there by name.

Writes between the markers in docs/spec/03-security-model.md. Idempotent.
"""
from __future__ import annotations

import collections
import importlib.util
import os
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
MIGRATIONS = ROOT / "supabase" / "migrations"
SPEC = ROOT / "docs" / "spec" / "03-security-model.md"

BEGIN = "<!-- BEGIN GENERATED DEFINER CATALOG -->"
END = "<!-- END GENERATED DEFINER CATALOG -->"


def load_reader():
    """`gen-enum-catalog.py`, loaded by path because its name has dashes."""
    path = ROOT / "scripts" / "gen-enum-catalog.py"
    spec = importlib.util.spec_from_file_location("gen_enum_catalog", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


READER = load_reader()
# The reader's pattern factory: it refuses Python's `\b`, which stops at `$`
# and at non-ASCII letters where PostgreSQL continues an identifier.
sql_re = READER.sql_re
IS, IE = READER.IDENT_START, READER.IDENT_END

# What a new function in `public` starts with on the platform: PostgreSQL's
# own default (EXECUTE to PUBLIC) plus Supabase's default privileges. The
# owner holds it too, and is not an API role, so it is left out.
DEFAULT_ACL = frozenset({"public", "anon", "authenticated", "service_role"})
# The roles the catalogue shows, in the order it shows them. service_role
# holds BYPASSRLS and is granted table-wide, so listing it says nothing; what
# matters is which API role can reach in.
API_ROLES = ("public", "anon", "authenticated")
SHOWN = {"public": "PUBLIC"}

CREATE_FN = sql_re(r"\s*create\s+(or\s+replace\s+)?function" + IE, re.I)
CREATE_PROC = sql_re(r"\s*create\s+(?:or\s+replace\s+)?procedure" + IE, re.I)
DROP_FN = sql_re(r"\s*drop\s+function(\s+if\s+exists)?" + IE, re.I)
DROP_ROUTINE = sql_re(r"\s*drop\s+(?:routine|procedure)" + IE, re.I)
ALTER_ROUTINE = sql_re(r"\s*alter\s+(?:function|routine|procedure)" + IE, re.I)
ALTER_FN = sql_re(r"\s*alter\s+function" + IE, re.I)
# The one ALTER FUNCTION this model reads: a single `SET search_path` whose
# value is a list of plain schema names (0055 moved every function that pins a
# path to `public, pg_temp`). It changes a function's configuration and nothing
# this model holds — the name, the definer flag, the ACL — so it is checked
# against the model and passed. Any other action, or a second action after the
# value, is still refused: OWNER TO, RENAME, SECURITY, SET SCHEMA all change
# what the catalogue shows.
SET_SEARCH_PATH = sql_re(
    r"\s*set\s+search_path\s*(?:=|to" + IE + r")\s*"
    r"[A-Za-z_][A-Za-z0-9_$]*" + IE + r"(?:\s*,\s*[A-Za-z_][A-Za-z0-9_$]*" + IE + r")*\s*",
    re.I,
)
DEFAULT_PRIVILEGES = sql_re(r"\s*alter\s+default\s+privileges" + IE, re.I)
GRANT_OR_REVOKE = sql_re(r"\s*(?:grant|revoke)" + IE, re.I)
ON_ROUTINES = sql_re(
    IS + r"on\s+(?:all\s+)?(?:function|functions|routine|routines|procedure|procedures)" + IE, re.I
)
ACL = sql_re(
    r"\s*(grant|revoke)\s+(?:execute|all(?:\s+privileges)?)\s+on\s+function\s+(.*?)\s+(to|from)"
    + IE + r"\s*(.*?)\s*$",
    re.I | re.S,
)
REVOKE_TAIL = sql_re(r"\s+(?:cascade|restrict)$", re.I)
GRANT_EXTRAS = sql_re(IS + r"(?:with\s+grant\s+option|granted\s+by)" + IE, re.I)
SECURITY_DEFINER = sql_re(IS + r"security\s+definer" + IE, re.I)
DROP_TAIL = sql_re(r"\s+(?:cascade|restrict)\s*$", re.I)
# A CASCADE on an object functions can depend on drops those functions too —
# a function taking a dropped type, a table's row type, anything in a dropped
# schema — and nothing in the statement says which. Postgres knows; this model
# would keep them (PR B review: the catalogue then said **none** for a
# function the database held open).
DROP_CASCADE = sql_re(
    r"\s*drop\s+(?:type|domain|schema|extension|table|foreign\s+table|view|materialized\s+view|owned)"
    + IE + r".*" + IS + r"cascade" + IE + r"\s*$",
    re.I | re.S,
)
# A range type creates constructor functions in its schema that no statement
# names.
CREATE_RANGE = sql_re(r"\s*create\s+type\s+.*" + IS + r"as\s+range" + IE, re.I | re.S)
# float(p) is `real` up to 24 bits of precision and `double precision` above;
# read before the typmod is dropped, because the typmod is what decides it.
FLOAT_P = sql_re(IS + r"float\s*\(\s*(\d+)\s*\)", re.I)
ARRAY_BOUNDS = sql_re(r"(?:\[\d*\])+$")
NAME = sql_re(
    r"\s*(?:([A-Za-z_][A-Za-z0-9_$]*)" + IE + r"\s*\.\s*)?([A-Za-z_][A-Za-z0-9_$]*)" + IE + r"\s*", re.I
)
DEFAULT_KW = sql_re(IS + r"default" + IE + "|=", re.I)
TYPMOD = sql_re(r"\([^()]*\)")
TYPE = sql_re(r"(?:(?:public|pg_catalog)\.)?([a-z_][a-z0-9_$]*)((?:\[\])*)", re.I)
ROLE = sql_re(r'\s*(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_$]*))\s*$')
MODES = {"in", "out", "inout", "variadic"}
UNKNOWABLE_ROLES = {"current_user", "current_role", "session_user", "group"}

# Spellings PostgreSQL treats as one type, read as the name `format_type`
# prints — what gate 8e compares with. A type outside this map is kept as
# written (an enum, `uuid`, `text`, `bytea`, `inet`, `interval`, `date`).
TYPE_ALIASES = {
    "int": "integer", "int4": "integer",
    "int8": "bigint", "int2": "smallint",
    "bool": "boolean",
    "float4": "real", "float8": "double precision", "float": "double precision",
    "decimal": "numeric", "dec": "numeric",
    "varchar": "character varying",
    "timestamptz": "timestamp with time zone",
    "timestamp": "timestamp without time zone",
    "timetz": "time with time zone",
    "time": "time without time zone",
    "char": "character", "bpchar": "character", "nchar": "character",
}
# The standard's multi-word type names, as `format_type` prints them. A type
# is matched as the longest of these at the END of an argument, so what is
# left in front is the argument's name (or nothing).
MULTI_WORD_TYPES = {
    ("double", "precision"): "double precision",
    ("character", "varying"): "character varying",
    ("char", "varying"): "character varying",
    ("bit", "varying"): "bit varying",
    ("timestamp", "with", "time", "zone"): "timestamp with time zone",
    ("timestamp", "without", "time", "zone"): "timestamp without time zone",
    ("time", "with", "time", "zone"): "time with time zone",
    ("time", "without", "time", "zone"): "time without time zone",
    ("national", "character", "varying"): "character varying",
    ("national", "char", "varying"): "character varying",
    ("nchar", "varying"): "character varying",
    ("national", "character"): "character",
    ("national", "char"): "character",
}
# PostgreSQL's type keywords that are col_name_keywords: its grammar will not
# take one as a parameter NAME, so an argument that begins with one is all
# type — `interval day`, `double precision` — never a name and then a type.
TYPE_KEYWORDS = {
    "bigint", "bit", "boolean", "char", "character", "dec", "decimal", "double", "float", "int",
    "integer", "interval", "national", "nchar", "numeric", "real", "smallint", "time", "timestamp",
    "varchar",
}
# An interval's fields are a typmod: `format_type` prints `interval` whatever
# follows it in an argument list.
INTERVAL_FIELDS = {"year", "month", "day", "hour", "minute", "second", "to"}
IDENT = sql_re(r"[A-Za-z_][A-Za-z0-9_$]*")


class Unreadable(Exception):
    """A statement this model will not guess at. Refused by name."""


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


def statements(skel: str) -> list[tuple[int, int]]:
    """Spans of the statements in a skeleton: literals and bodies are masked
    there, so a `;` inside one cannot end a statement early."""
    spans, start = [], 0
    for m in READER.STATEMENT_END.finditer(skel):
        spans.append((start, m.start()))
        start = m.end()
    if skel[start:].strip():
        spans.append((start, len(skel)))
    return spans


def close_paren(skel: str, i: int) -> int:
    """The index of the `)` matching the `(` at `i`."""
    depth = 0
    for j in range(i, len(skel)):
        if skel[j] == "(":
            depth += 1
        elif skel[j] == ")":
            depth -= 1
            if depth == 0:
                return j
    raise Unreadable("an argument list that never closes")


def top_level_commas(skel: str, a: int, b: int) -> list[tuple[int, int]]:
    parts, depth, start = [], 0, a
    for j in range(a, b):
        c = skel[j]
        # Brackets too: a default of `array[1, 2]` is one argument.
        if c in "([":
            depth += 1
        elif c in ")]":
            depth -= 1
        elif c == "," and depth == 0:
            parts.append((start, j))
            start = j + 1
    parts.append((start, b))
    return parts


def normal_type(token: str) -> str:
    # `char` is `character`, but `pg_catalog.char` is the one-byte internal
    # type, which `format_type` prints as `"char"`.
    if token.lower() == "pg_catalog.char":
        return '"char"'
    m = TYPE.fullmatch(token)
    if not m:
        raise Unreadable(f"a type it cannot read: {token!r}")
    base = m.group(1).lower()
    return TYPE_ALIASES.get(base, base) + m.group(2)


def arg_types(clean: str, skel: str, a: int, b: int) -> tuple[str, ...]:
    """The argument TYPES of a signature, which is what identifies a function.
    A name is optional everywhere, as it is to PostgreSQL: `f(uuid)` is a
    healthy CREATE, and refusing it was a red on a healthy migration (PR B
    review). A default is cut off first — on the skeleton, so an `=` inside a
    string literal is not one."""
    if not skel[a:b].strip():
        return ()
    types = []
    for s, e in top_level_commas(skel, a, b):
        d = DEFAULT_KW.search(skel, s, e)
        text = clean[s : d.start() if d else e]
        if '"' in text or "%" in text:
            raise Unreadable(f"an argument it cannot read: {' '.join(text.split())!r}")
        text = FLOAT_P.sub(lambda f: "real" if int(f.group(1)) <= 24 else "double precision", text)
        tokens = TYPMOD.sub("", text).split()
        if tokens and tokens[0].lower() in MODES:
            raise Unreadable(f"an argument with a mode: {' '.join(text.split())!r}")
        name, typ = split_argument(tokens)
        if typ is None or (name is not None and not IDENT.fullmatch(name)):
            raise Unreadable(f"an argument it cannot read: {' '.join(text.split())!r}")
        types.append(typ)
    return tuple(types)


def split_argument(tokens: list[str]) -> tuple[str | None, str | None]:
    """-> (name or None, normalised type or None).

    Array bounds and dimensions go first, as `format_type` drops them: any
    array is one `[]`, `int[3][4]` included, and so is a trailing ARRAY. Then
    PostgreSQL's own rule decides the name: a type keyword cannot be one, so
    an argument that starts with one is all type; otherwise one token in front
    of the type is the name. The type is a known multi-word name, an interval
    with its fields, or a single token."""
    if not tokens:
        return None, None
    tokens = list(tokens)
    arrays = False
    if tokens[-1].lower() == "array" or ARRAY_BOUNDS.sub("", tokens[-1]).lower() == "array":
        arrays = True
        tokens.pop()
    elif ARRAY_BOUNDS.search(tokens[-1]):
        arrays = True
        tokens[-1] = ARRAY_BOUNDS.sub("", tokens[-1])
    if not tokens or not tokens[-1]:
        return None, None
    if tokens[0].lower() in TYPE_KEYWORDS or len(tokens) == 1:
        name, rest = None, tokens
    else:
        name, rest = tokens[0], tokens[1:]
    words = [w.lower() for w in rest]
    if tuple(words) in MULTI_WORD_TYPES:
        typ = MULTI_WORD_TYPES[tuple(words)]
    elif words[0] == "interval" and all(w in INTERVAL_FIELDS for w in words[1:]):
        typ = "interval"
    elif len(rest) == 1:
        typ = normal_type(rest[0])
    else:
        return None, None
    return name, typ + ("[]" if arrays else "")


def signature(clean: str, skel: str, i: int) -> tuple[str, tuple[str, ...], int]:
    """At `i`: a function name and its parenthesised argument list.
    -> (name, argument types, index after the list)."""
    m = NAME.match(skel, i)
    if not m:
        raise Unreadable("a function name it cannot read (a quoted name?)")
    if m.group(1) and m.group(1).lower() != "public":
        raise Unreadable(f"a function in schema {m.group(1)} — the catalogue models public")
    if m.end() >= len(skel) or skel[m.end()] != "(":
        raise Unreadable(f"{m.group(2)} without an argument list")
    close = close_paren(skel, m.end())
    return m.group(2).lower(), arg_types(clean, skel, m.end() + 1, close), close + 1


def signatures(clean: str, skel: str, a: int, b: int) -> list[tuple[str, tuple[str, ...]]]:
    """A comma-separated list of `name(args)` filling [a, b) exactly."""
    out, i = [], a
    while True:
        name, sig, i = signature(clean, skel, i)
        out.append((name, sig))
        rest = skel[i:b]
        if not rest.strip():
            return out
        if rest.lstrip().startswith(","):
            i = i + rest.index(",") + 1
            continue
        raise Unreadable("a function list it cannot read")


def roles(clean: str, skel: str, a: int, b: int) -> set[str]:
    out = set()
    for s, e in top_level_commas(skel, a, b):
        m = ROLE.fullmatch(clean[s:e])
        if not m:
            raise Unreadable(f"a role it cannot read: {' '.join(clean[s:e].split())!r}")
        if m.group(1) is not None:
            out.add(m.group(1).replace('""', '"'))
        else:
            name = m.group(2).lower()
            if name in UNKNOWABLE_ROLES:
                raise Unreadable(f"a role only known at run time: {name}")
            out.add(name)
    return out


class Model:
    """Each (name, argument types) -> {definer, acl}, plus the order names and
    signatures first appeared in, which is the order the catalogue shows."""

    def __init__(self) -> None:
        self.funcs: dict[tuple[str, tuple[str, ...]], dict] = {}
        self.first: dict[tuple[str, tuple[str, ...]], int] = {}
        self.name_first: dict[str, int] = {}
        self._n = 0

    def _seen(self, key: tuple[str, tuple[str, ...]]) -> None:
        self._n += 1
        self.first.setdefault(key, self._n)
        self.name_first.setdefault(key[0], self._n)

    def create(self, key, replace: bool, definer: bool) -> None:
        if key in self.funcs:
            if not replace:
                raise Unreadable(f"create function {fmt(key)}, which already exists — PostgreSQL refuses this")
            self.funcs[key]["definer"] = definer
        else:
            # `explicit`: the roles a GRANT has named since this function was
            # created. `authenticated` holding EXECUTE with no GRANT behind it
            # is the platform default talking. A REVOKE need not unrecord it:
            # the role then leaves the ACL, and only a GRANT (which records it)
            # or a fresh CREATE (which resets this) can put it back.
            self.funcs[key] = {"definer": definer, "acl": set(DEFAULT_ACL), "explicit": set()}
        self._seen(key)

    def drop(self, key, if_exists: bool) -> None:
        if key in self.funcs:
            del self.funcs[key]
        elif not if_exists:
            raise Unreadable(f"drop function {fmt(key)}, which no earlier migration creates")
        elif any(name == key[0] for name, _ in self.funcs):
            # IF EXISTS on a signature this model does not know, while the name
            # exists under another: either a genuine no-op, or the model spells
            # a type differently from PostgreSQL and the database is dropping
            # the function the model keeps (PR B review, `float` against
            # `double precision`). It cannot tell which, so it does not guess.
            raise Unreadable(
                f"drop function if exists {fmt(key)}, a signature it does not know while {key[0]} exists"
                " with another — a no-op, or an argument type spelt in a way this model reads differently"
            )

    def change(self, key, grant: bool, who: set[str]) -> None:
        if key not in self.funcs:
            raise Unreadable(
                f"{'grant' if grant else 'revoke'} on {fmt(key)}, which no earlier migration creates"
                " — or an argument type spelt in a way this model does not know"
            )
        acl = self.funcs[key]["acl"]
        if grant:
            acl |= who
            self.funcs[key]["explicit"] |= who
        else:
            # REVOKE FROM PUBLIC takes nothing from a role that holds its own
            # grant, which is why the platform default's anon and authenticated
            # need naming too.
            acl -= who

    def definers(self) -> list[tuple[str, tuple[str, ...]]]:
        live = [k for k, v in self.funcs.items() if v["definer"]]
        return sorted(live, key=lambda k: (self.name_first[k[0]], self.first[k]))


def fmt(key: tuple[str, tuple[str, ...]]) -> str:
    return f"{key[0]}({', '.join(key[1])})"


def apply(model: Model, clean: str, skel: str, a: int, b: int) -> None:
    stmt = skel[a:b]
    if m := CREATE_FN.match(stmt):
        i = a + m.end()
        name, sig, _ = signature(clean, skel, i)
        model.create((name, sig), replace=bool(m.group(1)), definer=bool(SECURITY_DEFINER.search(stmt)))
        return
    if m := DROP_FN.match(stmt):
        end = b
        if t := DROP_TAIL.search(stmt):
            end = a + t.start()
        for key in signatures(clean, skel, a + m.end(), end):
            model.drop(key, if_exists=bool(m.group(1)))
        return
    if m := ALTER_FN.match(stmt):
        try:
            name, sig, j = signature(clean, skel, a + m.end())
        except Unreadable:
            # Not the shape below; the refusal that follows names it.
            name, sig, j = None, (), b
        if name is not None and SET_SEARCH_PATH.fullmatch(skel, j, b):
            if (name, sig) not in model.funcs:
                raise Unreadable(
                    f"an ALTER FUNCTION of {fmt((name, sig))}, which no earlier migration creates"
                    " — or an argument type spelt in a way this model does not know"
                )
            return
    for refuse, what in (
        (DROP_CASCADE, "a DROP … CASCADE on an object functions can depend on, which drops them without naming them"),
        (CREATE_RANGE, "a range type, which creates constructor functions no statement names"),
        (CREATE_PROC, "a procedure — the catalogue models functions"),
        (DROP_ROUTINE, "a DROP ROUTINE or DROP PROCEDURE"),
        (ALTER_ROUTINE, "an ALTER FUNCTION, which can rename it, change its owner or its SECURITY"),
        (DEFAULT_PRIVILEGES, "ALTER DEFAULT PRIVILEGES, which changes what every later function starts with"),
    ):
        if refuse.match(stmt):
            raise Unreadable(what)
    if GRANT_OR_REVOKE.match(stmt) and ON_ROUTINES.search(stmt):
        m = ACL.fullmatch(stmt)
        if not m or m.group(3).lower() != ("to" if m.group(1).lower() == "grant" else "from"):
            raise Unreadable("a routine GRANT or REVOKE in a shape it does not read")
        grant = m.group(1).lower() == "grant"
        ra, rb = a + m.start(4), a + m.end(4)
        if GRANT_EXTRAS.search(skel, ra, rb):
            raise Unreadable("WITH GRANT OPTION or GRANTED BY")
        if not grant and (t := REVOKE_TAIL.search(skel, ra, rb)):
            rb = t.start()
        who = roles(clean, skel, ra, rb)
        for key in signatures(clean, skel, a + m.start(2), a + m.end(2)):
            model.change(key, grant, who)


def collect(migrations: pathlib.Path | None = None) -> Model:
    """The model after every migration, in order. Refuses — FAIL and exit 1,
    naming the file and the statement — what it cannot read."""
    model = Model()
    for path in sorted((migrations or MIGRATIONS).glob("*.sql")):
        clean, skel = read_migration(path)
        for a, b in statements(skel):
            try:
                apply(model, clean, skel, a, b)
            except Unreadable as e:
                print(
                    f"FAIL: {path.name}: {e} — the definer catalogue refuses a statement it cannot read"
                    f" rather than guess at its ACL: {' '.join(clean[a:b].split())[:160]}",
                    file=sys.stderr,
                )
                raise SystemExit(1)
    return model


def api_roles(model: Model, key: tuple[str, tuple[str, ...]]) -> list[str]:
    return [r for r in API_ROLES if r in model.funcs[key]["acl"]]


def render(model: Model) -> str:
    keys = model.definers()
    overloaded = collections.Counter(name for name, _ in keys)
    lines = [
        BEGIN,
        "",
        f"{len(keys)} `SECURITY DEFINER` functions, in migration order. Generated by",
        "`scripts/gen-definer-catalog.py`; CI fails if this table and the migrations",
        "disagree, so adding a definer function without regenerating breaks the build.",
        "",
        "*EXECUTE held by* is each function's ACL after every `CREATE`, `GRANT`,",
        "`REVOKE` and `DROP` in the migrations, in order, starting from what a new",
        "function gets on the platform: `PUBLIC` (PostgreSQL's default) plus `anon`,",
        "`authenticated` and `service_role` (Supabase's default privileges). Only the",
        "API roles are shown. **none** means no API role can call it — service-role",
        "and other definer functions only, which is the correct default. `PUBLIC` or",
        "`anon` would break invariant 5, and so would `authenticated` holding it only",
        "through the default privileges; the generator refuses both. Gate 8e holds",
        "this reading to a reset database.",
        "",
        "| Function | EXECUTE held by |",
        "|---|---|",
    ]
    for key in keys:
        label = fmt(key) if overloaded[key[0]] > 1 else key[0]
        held = api_roles(model, key)
        shown = ", ".join(f"`{SHOWN.get(r, r)}`" for r in held) if held else "**none**"
        lines.append(f"| `{label}` | {shown} |")
    lines += ["", END]
    return "\n".join(lines)


def open_to_anon(model: Model) -> list[tuple[str, list[str]]]:
    """The definer functions PUBLIC or anon can execute — invariant 5's
    REVOKE half, which the catalogue refuses rather than renders quietly."""
    out = []
    for key in model.definers():
        held = api_roles(model, key)
        if {"public", "anon"} & set(held):
            out.append((fmt(key), held))
    return out


def default_only(model: Model) -> list[str]:
    """The definer functions `authenticated` can execute only because the
    platform's default privileges gave it — never granted to it, never revoked
    from it. Invariant 5 grants EXECUTE explicitly and only where required,
    and the house pattern `revoke … from public, anon` leaves exactly this
    behind: a service-role-only function callable by every signed-in user,
    with every other check green (PR B review). None exists today."""
    return [
        fmt(k) for k in model.definers()
        if "authenticated" in model.funcs[k]["acl"] and "authenticated" not in model.funcs[k]["explicit"]
    ]


def main() -> int:
    model = collect()
    block = render(model)
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
    keys = model.definers()
    # relpath, not relative_to: the proofs drive main() against a copy of the spec outside the tree.
    print(f"{len(keys)} SECURITY DEFINER functions catalogued in {os.path.relpath(SPEC, ROOT)}")
    open_to = open_to_anon(model)
    if open_to:
        print(
            "FAIL: invariant 5 — SECURITY DEFINER functions executable by PUBLIC or anon: "
            + "; ".join(f"{f} ({', '.join(SHOWN.get(r, r) for r in rs)})" for f, rs in open_to)
            + " — `revoke all on function … from public, anon, authenticated`, then grant only the role that calls it",
            file=sys.stderr,
        )
        return 1
    implicit = default_only(model)
    if implicit:
        print(
            "FAIL: invariant 5 — SECURITY DEFINER functions authenticated can execute only through the"
            " platform's default privileges: " + "; ".join(implicit)
            + " — revoke from public, anon, authenticated, then grant authenticated explicitly if it is the caller",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
