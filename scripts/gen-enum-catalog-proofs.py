#!/usr/bin/env python3
"""The proof set for scripts/gen-enum-catalog.py — validate gate 10f.

Forty-three Codex review rounds on PR #88 each fixed one way the enum
catalogue generator could bless a wrong catalogue (a parser reading less than
SQL allows and saying nothing) or refuse a healthy migration (a gate red on a
healthy tree). Every fix was proven red against the previous head before it
shipped, and those proofs lived in a session scratchpad — a rule written
down and connected to nothing, the defect the status log records most often.
They live here now, so an edit to the generator that reopens any of them
fails this gate by name.

What this file asserts, in the generator's own terms:
- the committed catalogue in docs/spec/01-data-model.md is what the real
  migrations render (the control), and dropping 0022's `add value
  'disputed'` changes it (the gate cannot pass by seeing nothing);
- for each probe migration written into a scratch copy of the real set, the
  generator either RENDERS the expected catalogue (a healthy migration,
  `unchanged(...)` or a value list), or REFUSES with the sentence the rule
  names (`refuses(d, needle)`) — never a bare exit, never a pass by accident.

Only the fixed-behaviour half of each round's proof is here. The other half
— "the shipped generator passed this" — compared against the previous
commit's body and cannot be carried without that body; the status log entry
`docs(spec-drift)` records each of those in prose.

Mechanics: the generator is loaded once and `strip_sql` is memoised on its
arguments (it is a pure function of the text it is given), so the 51 real
migrations are parsed once rather than once per probe. The control check
runs BEFORE the cache is installed and is repeated after it, so the cache is
itself proven to change nothing. Each probe is written into its own named
copy of the ENUM-ONLY baseline under a temporary directory (a later check
may refer back to an earlier copy by name), under a version that sorts AFTER
every real migration — derived, not hard-coded, so a real `0052` landing
later cannot slip in behind a probe and change the scenario under test
(Codex on PR #90); a two-file probe takes the two versions after that,
adjacent. The baseline is the real migrations' enum DDL, every statement
verbatim under its own file name, and nothing else — so a probe inherits the
real enums and no STATE: a real migration creating a schema would otherwise
arm the generator's shadow guard against every unqualified probe (Codex on
PR #90, round four). A control asserts that baseline renders the committed
block before any probe runs.
Refusals are captured in-process (stderr + SystemExit), so a run of the
whole set takes about a minute.
"""
from __future__ import annotations

import ast

import contextlib
import functools
import importlib.util
import io
import pathlib
import re
import shutil
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
GENERATOR = ROOT / "scripts" / "gen-enum-catalog.py"
MIGRATIONS = ROOT / "supabase" / "migrations"
BS = chr(92)
DQ = chr(34)
Q = chr(39)


def load(path):
    spec = importlib.util.spec_from_file_location("gen", path)
    g = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(g)
    return g


try:
    gen = load(GENERATOR)
except Exception as e:  # noqa: BLE001 — the subject failing to import is the first thing to say plainly
    print(f"FAIL: the generator could not be loaded: {type(e).__name__}: {e}", file=sys.stderr)
    sys.exit(1)
committed = re.search(re.escape(gen.BEGIN) + r".*?" + re.escape(gen.END), gen.SPEC.read_text(), re.S).group(0)
# The header's own count — "15 enum types, in migration order" — read rather
# than hard-coded, so a real migration adding an enum moves the expectation
# with it instead of turning the probe red on a healthy tree.
committed_count = int(committed.splitlines()[2].split()[0])

TMP = tempfile.TemporaryDirectory(prefix="enum-proofs-")
S = pathlib.Path(TMP.name)  # every named scratch copy lives here, and a check may refer back to one by name
BASELINE = S / "_baseline"  # the probes' baseline: the real migrations' enum DDL and nothing else


def enum_only_baseline():
    """Build BASELINE: every `create type … as enum`, `alter type` and `drop
    type` statement of every real migration, verbatim, under its own file name
    — and NOTHING else. The names keep the creation order and the versions the
    catalogue prints, so it renders the committed block (asserted below, before
    any probe runs); the omissions are the point. A probe must not inherit
    STATE from the baseline: a real migration that creates or renames a
    non-public schema arms the generator's shadow guard for every later
    unqualified enum statement, so a probe appended after the full real set
    fails while the real tree stays green — one `create schema aux_future;`
    migration turned 64 proofs red on a healthy tree (Codex on PR #90, round
    four). Session settings, bodies and schema DDL are the real tree's business
    and gate 10e checks them there; a probe needs the real enums and a baseline
    that carries no state. The statements are the spans the generator's own
    `enum_statement_spans` reports on the skeleton — the seam `collect()`
    itself iterates — copied from the clean text at the same positions, so
    the baseline and the generator cannot disagree about what an enum
    statement is."""
    enum_only_copy(MIGRATIONS, BASELINE)


def enum_only_copy(src, dst):
    """Write `dst` as the enum-only image of the migrations in `src` (see
    `enum_only_baseline`): every enum statement, in source position, nothing
    else."""
    dst.mkdir()
    for path in sorted(src.glob("*.sql")):
        sql, skel = gen.strip_sql(path.read_text())
        if skel.strip() and not skel.rstrip().endswith(";"):
            sql, skel = sql + ";", skel + ";"  # collect() makes EOF a terminator the same way
        (dst / path.name).write_text(
            "".join(sql[a:b] + "\n" for _kind, a, b in gen.enum_statement_spans(skel))
        )


class Refused(Exception):
    """The generator refused a probe that `run()` expected it to render.
    Raised rather than returned as an empty result, because an absence
    proof — `"payment_status" not in run(d)[2]` — is satisfied by an EMPTY
    creation order, so a generator that wrongly REFUSED a valid `drop type`
    passed every proof asserting the type was gone (Codex on PR #90, round
    two). A refusal is a failed render; `check()` reports the raise as a
    named FAIL carrying the generator's own sentence."""


def run(d, path=None):
    """(rendered block, values, creation order) for the migrations in `d`.
    Raises `Refused` when the generator refused — never an empty result,
    which an absence proof cannot tell from success. `path` is accepted for
    call-site compatibility with the scratchpad harness; the generator is
    always this tree's."""
    gen.MIGRATIONS = pathlib.Path(d)
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        try:
            v, t, o = gen.collect()
        except SystemExit as e:
            raise Refused(f"exit {e.code}: {' '.join(err.getvalue().split())[:200]}") from None
    return gen.render(v, t, o), v, o


def refuses(d, needle="cannot read", path=None):
    """True only when the generator exits 1 AND names the rule."""
    gen.MIGRATIONS = pathlib.Path(d)
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        try:
            gen.collect()
        except SystemExit as e:
            return e.code == 1 and needle in err.getvalue()
    return False


def probe_versions():
    """Two version strings that sort after every real migration and adjacent
    to each other. Hard-coding `0052` would have put a real 0053 AFTER the
    probe: a probe that creates a schema and expects no enum DDL to follow
    would then meet the real migration's unqualified `create type` and the
    gate would refuse a healthy tree (Codex on PR #90)."""
    top = max(int(p.name.split("_", 1)[0]) for p in MIGRATIONS.glob("*.sql"))
    return f"{top + 1:04d}", f"{top + 2:04d}"


PROBE, PROBE2 = probe_versions()


def scratch(name, sql):
    """A named copy of the enum-only baseline with `sql` as its probe,
    versioned past every real file. Named, because a later check may refer
    back to it (`S / name`)."""
    d = S / name
    shutil.rmtree(d, ignore_errors=True)
    shutil.copytree(BASELINE, d)
    (d / f"{PROBE}_probe.sql").write_text(sql)
    return d


def scratch_edit(name, filename, old, new):
    """A named copy of the enum-only baseline with one file edited; `old`
    must be an enum statement, since nothing else survives into the
    baseline."""
    d = S / name
    shutil.rmtree(d, ignore_errors=True)
    shutil.copytree(BASELINE, d)
    p = d / filename
    text = p.read_text()
    assert text.count(old) == 1, (filename, old)
    p.write_text(text.replace(old, new))
    return d


def unchanged(d):
    return run(d)[0] == committed


def refused_with(fn, needle):
    """True only when `fn()` raises ValueError AND the message names the rule."""
    try:
        fn()
    except ValueError as e:
        return needle in str(e)
    return False


def sql_re_call_count(path):
    """How many times the module at `path` builds a pattern through `sql_re`."""
    tree = ast.parse(path.read_text())
    return sum(
        1 for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "sql_re"
    )


checks = []


def check(name, thunk):
    """Evaluate one proof. A probe that RAISES is a failed proof with the
    exception in its name, never a dead suite: when a future migration
    displaced the probes (Codex on PR #90) the first affected check died on a
    KeyError and took the other 580 with it, which reads as a broken harness
    rather than a broken rule."""
    try:
        ok = bool(thunk())
    except Exception as e:  # noqa: BLE001 — any exception is a failed proof
        ok = False
        name = f"{name} — raised {type(e).__name__}: {e}"
    checks.append((name, ok))

# The control, uncached: the real tree renders the committed block.
check("control byte-identical (uncached)", lambda: run(MIGRATIONS)[0] == committed)
# Memoise the pure lexer so the 51 real files are parsed once; the control is
# repeated below under the cache so the cache is proven to change nothing.
gen.strip_sql = functools.lru_cache(maxsize=None)(gen.strip_sql)
check("control byte-identical (cached)", lambda: run(MIGRATIONS)[0] == committed)
# The probes' baseline must render the committed block too: the same enums,
# in the same order, created and altered in the same versions. A future
# migration whose enum DDL the filter did not carry across fails HERE, by
# name, rather than as sixty unexplained reds further down.
enum_only_baseline()
check("the enum-only probe baseline renders the committed block", lambda: run(BASELINE)[0] == committed)
# The filter must keep statement ORDER, not just statements: a migration that
# drops a type and then creates it again is a net create, and an image sorted
# by statement kind would have copied it as create-then-drop, so a healthy
# future migration of that shape turned the control red (Codex round seven).
d = scratch("order7", "drop type if exists mood;\ncreate type mood as enum ('x');\n")
enum_only_copy(d, S / "order7-filtered")
check("the enum-only filter keeps drop-then-create in source order", lambda: run(S / "order7-filtered")[1].get("mood") == ["x"] and run(d)[1].get("mood") == ["x"])
d = scratch("s1", "select 'drop type payment_status;';\n")
check("DDL in a string value: fixed leaves the catalogue unchanged", lambda: run(d)[0] == committed)
d = scratch("s2", "alter type payment_status add value 'awaiting;review';\n")
check("semicolon in a label: fixed reads it", lambda: "awaiting;review" in run(d)[1].get("payment_status", []))
check("punctuation in create labels read correctly", lambda: run(scratch("s3", "create type t as enum ('a;b', 'c)d', 'e--f');\n"))[1].get("t") == ["a;b", "c)d", "e--f"])
check("string value naming a type does not alter it", lambda: run(scratch("s5", "insert into job_runs(job) values ('alter type payment_status add value ''ghost''');\n"))[0] == committed)
d = scratch("r1", "comment on type payment_status is $doc$create type ghost as enum ('x');$doc$;\n"); check("dollar-quoted DDL refused", lambda: refuses(d, "dollar-quoted"))
check("dollar-quoted prose fine", lambda: run(scratch("r2", "comment on type payment_status is $doc$the payment lifecycle; it's fine$doc$;\n"))[0] == committed)
check("DO body with a comment mentioning alter type is fine", lambda: run(scratch("r3", "do $$ begin\n  -- alter type payment_status add value 'ghost' would be wrong here\n  perform 1;\nend $$;\n"))[0] == committed)
check("$word$ inside a $$ value is text", lambda: run(scratch("r4", "comment on type payment_status is $$has a $sign$ inside$$;\n"))[0] == committed)
check("DO body with real DDL refused", lambda: refuses(scratch("r5b", "do $$ begin alter type payment_status add value 'ghost'; end $$;\n"), "dollar-quoted"))
check("comment between tokens catalogued", lambda: run(scratch("r6", "CREATE/*gap*/TYPE ghost AS ENUM ('x');\n"))[1].get("ghost") == ["x"])
check("nested comment stripped", lambda: "ghost" not in run(scratch("q1", "/* outer /* inner */ create type ghost as enum ('x'); */\n"))[2])
check("E'' label refused", lambda: refuses(scratch("q2", "create type t as enum (E'can" + BS + "'t', 'b');\n")))
check("dollar-quoted label refused", lambda: refuses(scratch("q3", "create type t as enum ($$a$$, 'b');\n")))
check("trailing comma tolerated", lambda: run(scratch("q5", "create type t as enum ('a', 'b',);\n"))[1].get("t") == ["a", "b"])
check("escaped quote in a label survives", lambda: "it's" in run(scratch("p1", "alter type payment_status add value 'it''s';\n"))[1]["payment_status"])
check("label with -- survives", lambda: "client--reminder" in run(scratch("p3", "alter type notification_type add value 'client--reminder';\n"))[1]["notification_type"])
check("quoted create refused", lambda: refuses(scratch("p4", 'CREATE TYPE public."delivery_status" AS ENUM (' + "'queued');\n")))
check("quoted alter refused", lambda: refuses(scratch("p5", 'alter type "payment_status" add value ' + "'x';\n")))
check("unreadable drop refused", lambda: refuses(scratch("p6", "drop type payment_status cascade restrict;\n")))
check("unknown alter refused", lambda: refuses(scratch("p7", "alter type payment_status rename to payment_state;\n"), "neither"))
check("comments stripped, real kept", lambda: (lambda v: "ghost" not in v and "ghost2" not in v and "real" in v)(run(scratch("p8", "-- Codex's note: alter type payment_status add value 'ghost';\n/* it's /* nested */ still a comment: alter type payment_status add value 'ghost2'; */\nalter type payment_status add value 'real';\n"))[1]["payment_status"]))
check("cascade drop removes", lambda: "payment_status" not in run(scratch("p9", "drop type payment_status cascade;\n"))[2])
check("drop-then-create keeps", lambda: "mood" in run(scratch("p10", "drop type if exists mood;\ncreate type mood as enum ('happy');\n"))[2])
check("before anchor", lambda: [l for l in run(scratch("p11", "create type mood as enum ('happy');\nalter type mood add value 'tired' before 'happy';\n"))[0].splitlines() if l.startswith("- `mood`")][0].endswith("`tired` · `happy`"))
check("dropped-`disputed` sabotage red", lambda: run(scratch_edit("mig-sab1", "0022_reversal_enums.sql", "alter type payment_status add value if not exists 'disputed';", ""))[0] != committed)
DQ = chr(34)
# --- round seven, finding 1: quoted identifiers masked in the skeleton
d = scratch("t1", "select 1 as " + DQ + "drop type payment_status;" + DQ + ";\n")
check("DDL in a quoted identifier: fixed leaves the catalogue unchanged", lambda: run(d)[0] == committed)
d = scratch("t2", "select 1 as " + DQ + "say " + DQ + DQ + "drop type payment_status;" + DQ + DQ + " now" + DQ + ";\n")
check("doubled quote inside an identifier is content, catalogue unchanged", lambda: run(d)[0] == committed)
d = scratch("t3", "comment on column clients." + DQ + "odd;name" + DQ + " is 'x';\nalter type payment_status add value 'real2';\n")
check("semicolon inside an identifier does not swallow the next statement", lambda: "real2" in run(d)[1]["payment_status"])
# --- round seven, finding 2: whitespace inside labels preserved
d = scratch("t4", "alter type payment_status add value 'needs  review';\n")
check("double space in a label: fixed records two", lambda: "needs  review" in run(d)[1]["payment_status"] and "needs review" not in run(d)[1]["payment_status"])
d = scratch("t5", "create type mood as enum ('a', 'needs  review');\nalter type mood add value 'z' before 'needs  review';\n")
check("anchor with a double space: fixed places before it", lambda: run(d)[1]["mood"] == ["a", "z", "needs  review"])
d = scratch("t6", "create type mood as enum ('needs  review');\nalter type mood rename value 'needs  review' to 'nr';\n")
check("rename of a double-spaced label: fixed renames", lambda: run(d)[1]["mood"] == ["nr"])
check("trailing whitespace before the terminator still reads", lambda: "tw" in run(scratch("t7", "alter type payment_status add value 'tw'   ;\n"))[1]["payment_status"])
check("multi-line alter still reads", lambda: "ml" in run(scratch("t8", "alter type payment_status\n  add value\n  'ml'\n;\n"))[1]["payment_status"])
check("padded label preserved", lambda: "  padded " in run(scratch("t10", "alter type payment_status add value '  padded ';\n"))[1]["payment_status"])
check("unknown alter still refused by name", lambda: refuses(scratch("t11", "alter type payment_status\n   rename   to payment_state;\n"), "neither"))
Q = chr(39); DQ = chr(34)
def unchanged(d): return run(d)[0] == committed
# --- round eight, finding 1: search_path
d = scratch("u1", "set search_path = private, public;\ncreate type payment_status as enum ('z');\n")
check("search_path then unqualified create: fixed refuses naming search_path", lambda: refuses(d, "moves search_path"))
d = scratch("u2", "set search_path = private, public;\ncreate type mood as enum ('x');\n")
check("search_path then new type: fixed refuses", lambda: refuses(d, "moves search_path"))
check("search_path = public is allowed and the create is read", lambda: run(scratch("u3", "set search_path = public;\ncreate type mood as enum ('x');\n"))[1].get("mood") == ["x"])
check("set local … to public, extensions allowed", lambda: unchanged(scratch("u4", "set local search_path to public, extensions;\n")))
check("reset search_path allowed", lambda: unchanged(scratch("u5", "reset search_path;\n")))
check("set_config to private refused", lambda: refuses(scratch("u6", "select set_config('search_path', 'private', false);\n"), "moves search_path"))
check("set_config public-first allowed", lambda: unchanged(scratch("u7", "select set_config('search_path', 'public, private', false);\n")))
check("alter database … search_path refused", lambda: refuses(scratch("u8", "alter database postgres set search_path = private;\n"), "moves search_path"))
check("alter role … search_path refused", lambda: refuses(scratch("u9", "alter role postgres set search_path to private;\n"), "moves search_path"))
check("quoted value refused", lambda: refuses(scratch("u10", "set search_path = 'private';\n"), "moves search_path"))
check("$user first refused", lambda: refuses(scratch("u10b", "SET SEARCH_PATH TO " + DQ + "$user" + DQ + ", public;\n"), "moves search_path"))
check("set_config inside a DO body refused", lambda: refuses(scratch("u11", "do $$ begin perform set_config('search_path', 'private', false); end $$;\n"), "does not read"))
check("function clause set search_path = public is not a statement (control)", lambda: unchanged(scratch("u12", "create function probe_f() returns int language sql security definer set search_path = public as $$ select 1 $$;\n")))
# --- round eight, finding 2: executable single-quoted bodies
codex = "DO 'BEGIN EXECUTE ''CREATE TYPE mood AS ENUM (''''x'''')''; END';\n"
d = scratch("v1", codex)
check("single-quoted DO body with EXECUTE DDL: fixed refuses", lambda: refuses(d, "does not read"))
d = scratch("v2", "do $$ begin execute 'create type mood as enum (''x'')'; end $$;\n")
check("dollar-quoted DO body with EXECUTE DDL: fixed refuses", lambda: refuses(d, "does not read"))
check("inert single-quoted DO body allowed", lambda: unchanged(scratch("v3", "do 'begin perform 1; end';\n")))
check("DO LANGUAGE … 'execute drop type' refused", lambda: refuses(scratch("v4", "DO LANGUAGE plpgsql 'begin execute ''drop type payment_status''; end';\n"), "does not read"))
check("prose naming DDL inside a DO body is refused now (round-six decision reversed)", lambda: refuses(scratch("v5", "do $$ begin raise notice 'create type is not allowed here'; end $$;\n"), "does not read"))
check("bare DDL inside a dollar-quoted function body refused", lambda: refuses(scratch("v7", "create function probe_f() returns void language plpgsql as $$ begin create type mood as enum ('x'); end $$;\n"), "does not read"))
check("bare DDL inside a single-quoted function body refused", lambda: refuses(scratch("v8", "create function probe_f() returns void language plpgsql as 'begin create type mood as enum (''x''); end';\n"), "does not read"))
e_body = "do E'begin execute " + BS + Q + "create type mood as enum (" + BS + Q + BS + Q + "x" + BS + Q + BS + Q + ")" + BS + Q + "; end';\n"
check("E'' DO body with EXECUTE DDL refused", lambda: refuses(scratch("v10", e_body), "does not read"))
check("inert value naming DDL in an insert still allowed", lambda: unchanged(scratch("v11", "insert into job_runs(job) values ('alter type payment_status add value ''ghost''');\n")))
check("DO after a comment still recognised as DO", lambda: refuses(scratch("v12", "-- setup\ndo $$ begin execute 'alter type payment_status add value ''ghost'''; end $$;\n"), "does not read"))
check("DO as a later statement recognised", lambda: refuses(scratch("v13", "select 1;\n" + codex), "does not read"))
check("`;` inside an earlier literal does not shift statement boundaries", lambda: unchanged(scratch("v14", "select 'a;b';\ndo 'begin perform 1; end';\n")))
check("`;` inside an earlier literal does not hide a DO", lambda: refuses(scratch("v15", "select 'a;b';\n" + codex), "does not read"))
d = scratch("w1", "set schema 'private';\ncreate type mood as enum ('happy');\n")
check("set schema then unqualified create: fixed refuses naming search_path", lambda: refuses(d, "moves search_path"))
d = scratch("w2", "set schema 'private';\ncreate type payment_status as enum ('z');\n")
check("set schema over an existing enum: fixed refuses", lambda: refuses(d, "moves search_path"))
check("set schema 'public' allowed and the create is read", lambda: run(scratch("w3", "set schema 'public';\ncreate type mood as enum ('x');\n"))[1].get("mood") == ["x"])
check("SET LOCAL SCHEMA refused", lambda: refuses(scratch("w4", "SET LOCAL SCHEMA 'private';\n"), "moves search_path"))
check("set schema unquoted refused", lambda: refuses(scratch("w5", "set schema private;\n"), "moves search_path"))
check("alter table … set schema is a move, not a search_path change (allowed)", lambda: unchanged(scratch("w6", "alter table clients set schema private;\n")))
check("set search_path still refused after the regex widened", lambda: refuses(scratch("w7", "set search_path = private, public;\n"), "moves search_path"))
check("set search_path = public still allowed after the regex widened", lambda: unchanged(scratch("w8", "set search_path = public;\n")))
codex10 = "select set_config('search_path', concat('private', ',public'), false);\ncreate type mood as enum ('happy');\n"
d = scratch("x1", codex10)
check("computed set_config value: fixed refuses naming search_path", lambda: refuses(d, "moves search_path"))
check("|| concatenation refused", lambda: refuses(scratch("x2", "select set_config('search_path', 'private' || ',public', false);\n"), "moves search_path"))
check("function-valued refused", lambda: refuses(scratch("x3", "select set_config('search_path', current_setting('x'), false);\n"), "moves search_path"))
check("computed GUC name refused", lambda: refuses(scratch("x4", "select set_config(concat('search', '_path'), 'private', false);\n"), "moves search_path"))
check("literal public-first value still allowed", lambda: unchanged(scratch("x5", "select set_config('search_path', 'public, private', false);\n")))
check("literal private value still refused", lambda: refuses(scratch("x6", "select set_config('search_path', 'private', false);\n"), "moves search_path"))
check("unrelated GUC with a computed value allowed", lambda: unchanged(scratch("x7", "select set_config('sanpo.flag', concat('a', 'b'), false);\n")))
check("schema-qualified pg_catalog.set_config refused", lambda: refuses(scratch("x8", "select pg_catalog.set_config('search_path', 'private', false);\n"), "moves search_path"))
check("upper-case GUC name refused", lambda: refuses(scratch("x9", "select set_config('SEARCH_PATH', 'private', false);\n"), "moves search_path"))
check("second call in one statement refused", lambda: refuses(scratch("x10", "select set_config('search_path', 'public', false), set_config('search_path', 'private', false);\n"), "moves search_path"))
check("E'' value refused as unreadable", lambda: refuses(scratch("x11", "select set_config('search_path', E'public', false);\n"), "moves search_path"))
check("set_config inside a function body is not a top-level call (control)", lambda: unchanged(scratch("x12", "create function probe_f() returns void language plpgsql as $$ begin perform set_config('sanpo.x', sqlerrm, false); end $$;\n")))
d = scratch("y1", "select 'set_config(foo)';\n")
check("inert literal naming set_config: fixed leaves the catalogue unchanged", lambda: unchanged(d))
check("inert value holding a whole set_config call allowed", lambda: unchanged(scratch("y2", "insert into job_runs(job) values ('select set_config(''search_path'', ''private'', false)');\n")))
codex11 = "SELECT pg_catalog." + DQ + "set_config" + DQ + "('search_path', 'private', false);\nCREATE TYPE mood AS ENUM ('x');\n"
d = scratch("y3", codex11)
check("quoted set_config call: fixed refuses naming search_path", lambda: refuses(d, "moves search_path"))
check("unqualified quoted call refused", lambda: refuses(scratch("y4", "select " + DQ + "set_config" + DQ + "('search_path', 'private', false);\n"), "moves search_path"))
check("upper-case quoted call refused (conservative)", lambda: refuses(scratch("y5", "select " + DQ + "SET_CONFIG" + DQ + "('search_path', 'private', false);\n"), "moves search_path"))
check("some other quoted function with those arguments allowed", lambda: unchanged(scratch("y6", "select " + DQ + "my_fn" + DQ + "('search_path', 'private', false);\n")))
check("quoted public-first call allowed", lambda: unchanged(scratch("y7", "select " + DQ + "set_config" + DQ + "('search_path', 'public, private', false);\n")))
check("set quoted search_path refused", lambda: refuses(scratch("y8", "set " + DQ + "search_path" + DQ + " = private;\n"), "moves search_path"))
check("set quoted search_path to public allowed", lambda: unchanged(scratch("y9", "set " + DQ + "search_path" + DQ + " to public;\n")))
check("alter role with search_path only inside a literal allowed", lambda: unchanged(scratch("y10", "alter role postgres set app.note = 'search_path';\n")))
check("alter role quoted search_path refused", lambda: refuses(scratch("y11", "alter role postgres set " + DQ + "search_path" + DQ + " = private;\n"), "moves search_path"))
check("computed value still refused after moving to the skeleton", lambda: refuses(scratch("y12", codex10), "moves search_path"))
codex12 = "create function mk() returns void language plpgsql as $$ begin execute 'create type public.mood as enum (''x'')'; end $$;\nselect mk();\n"
d = scratch("z1", codex12)
check("function with EXECUTE DDL then called: fixed refuses at definition", lambda: refuses(d, "does not read"))
check("same function wired to a trigger refused", lambda: refuses(scratch("z2", "create function mk() returns trigger language plpgsql as $$ begin execute 'alter type payment_status add value ''ghost'''; return new; end $$;\ncreate trigger t after insert on job_runs for each row execute function mk();\n"), "does not read"))
check("single-quoted function body with EXECUTE DDL refused", lambda: refuses(scratch("z3", "create function mk() returns void language plpgsql as 'begin execute ''create type public.mood as enum (''''x'''')''; end';\n"), "does not read"))
check("function body touching search_path refused", lambda: refuses(scratch("z4", "create function mk() returns void language plpgsql as $$ begin perform set_config('search_path', 'private', false); end $$;\n"), "does not read"))
check("prose naming DDL inside a function body is refused now (round-eight allowance reversed)", lambda: refuses(scratch("z5", "create function probe_f() returns void language plpgsql as $$ begin raise notice 'create type is not allowed here'; end $$;\n"), "does not read"))
check("procedure body with EXECUTE DDL refused", lambda: refuses(scratch("z6", "create procedure mk() language plpgsql as $$ begin execute 'drop type payment_status'; end $$;\ncall mk();\n"), "does not read"))
check("ordinary function body allowed", lambda: unchanged(scratch("z7", "create function probe_f() returns int language sql security definer set search_path = public as $$ select count(*)::int from job_runs $$;\nselect probe_f();\n")))
check("COMMENT ON value with prose still allowed", lambda: unchanged(scratch("z8", "comment on type payment_status is $doc$the lifecycle; nothing here creates a type$doc$;\n")))
check("COMMENT ON value with bare DDL still refused", lambda: refuses(scratch("z9", "comment on type payment_status is $doc$create type ghost as enum ('x');$doc$;\n"), "does not read"))
# --- round thirteen, finding 1: EOF as a terminator
d = scratch("e1", "create type mood as enum ('x')")
check("final create with no semicolon: fixed catalogues it", lambda: run(d)[1].get("mood") == ["x"])
check("final create, trailing whitespace, no semicolon", lambda: run(scratch("e2", "create type mood as enum ('x')  \n\n"))[1].get("mood") == ["x"])
check("final alter with no semicolon read", lambda: "eofv" in run(scratch("e3", "alter type payment_status add value 'eofv'"))[1]["payment_status"])
check("final drop with no semicolon applied", lambda: "payment_status" not in run(scratch("e4", "drop type payment_status"))[2])
check("trailing comment after the last semicolon unchanged", lambda: unchanged(scratch("e5", "select 1;\n-- done\n")))
check("comment-only file unchanged", lambda: unchanged(scratch("e6", "-- nothing here\n")))
check("final unterminated DO with DDL refused", lambda: refuses(scratch("e7", "do $$ begin execute 'create type mood as enum (''x'')'; end $$"), "does not read"))
# --- round thirteen, finding 2: EXECUTE must be readable
codex13 = "do $$ begin execute 'create ' || 'type public.mood as enum (''x'')'; end $$;\n"
d = scratch("f1", codex13)
check("concatenated EXECUTE: fixed refuses", lambda: refuses(d, "cannot read"))
check("concat() EXECUTE refused", lambda: refuses(scratch("f2", "do $$ begin execute concat('create ', 'type mood as enum (''x'')'); end $$;\n"), "cannot read"))
check("variable EXECUTE refused", lambda: refuses(scratch("f3", "do $$ declare v text := 'select 1'; begin execute v; end $$;\n"), "cannot read"))
check("concatenated EXECUTE in a function body refused", lambda: refuses(scratch("f4", "create function mk() returns void language plpgsql as $$ begin execute 'cre' || 'ate type mood as enum (''x'')'; end $$;\n"), "cannot read"))
check("format() with a literal template allowed (0004 pattern)", lambda: unchanged(scratch("f5", "do $$ declare t text; begin for t in select 'clients' loop execute format('alter table %I enable row level security', t); end loop; end $$;\n")))
check("plain literal EXECUTE allowed (0028 pattern)", lambda: unchanged(scratch("f6", "do $$ begin execute 'create extension if not exists pg_cron'; exception when others then null; end $$;\n")))
check("EXECUTE … INTO with a literal allowed", lambda: unchanged(scratch("f7", "do $$ declare n int; begin execute 'select 1' into n; end $$;\n")))
check("EXECUTE … USING with a literal allowed", lambda: unchanged(scratch("f8", "do $$ declare n int; begin execute 'select $1' into n using 1; end $$;\n")))
check("grant execute on inside a DO is not an EXECUTE", lambda: unchanged(scratch("f9", "do $$ begin grant execute on function fn_job_health() to service_role; end $$;\n")))
check("create trigger … execute function inside a DO is not an EXECUTE", lambda: unchanged(scratch("f10", "do $$ begin create trigger probe_t after insert on job_runs for each row execute function fn_touch_updated_at(); end $$;\n")))
check("the word execute inside a string is not an EXECUTE", lambda: unchanged(scratch("f11", "do $$ begin raise notice 'grant execute fn_unsubscribe_by_token'; end $$;\n")))
check("format() with a computed template refused", lambda: refuses(scratch("f12", "do $$ declare t text := 'select 1'; begin execute format(t); end $$;\n"), "cannot read"))
def line_for(d, name):
    return [l for l in run(d)[0].splitlines() if l.startswith("- `" + name + "`")][0]
# --- round fourteen, finding 1: nested dollar strings inside a body
codex14a = "create function probe_f() returns int language plpgsql as $$ begin perform length($msg$please execute this later$msg$); return 1; end $$;\n"
d = scratch("n1", codex14a)
check("nested $msg$ prose naming execute: fixed leaves the catalogue unchanged", lambda: unchanged(d))
check("same inside a DO body allowed", lambda: unchanged(scratch("n2", "do $$ begin perform length($msg$please execute this later$msg$); end $$;\n")))
check("EXECUTE of a nested dollar string carrying DDL still refused", lambda: refuses(scratch("n3", "do $$ begin execute $q$create type mood as enum ('x')$q$; end $$;\n"), "does not read"))
check("EXECUTE of a nested dollar string that is inert allowed", lambda: unchanged(scratch("n4", "do $$ begin execute $q$select 1$q$; end $$;\n")))
check("EXECUTE of a nested dollar string concatenated refused", lambda: refuses(scratch("n5", "do $$ begin execute $q$select 1$q$ || 'x'; end $$;\n"), "cannot read"))
check("unterminated nested dollar tag in a body refused", lambda: refuses(scratch("n6", "do $$ begin perform length($m$oops); end $$;\n"), "does not read"))
check("$body$-quoted body with a nested $$ literal allowed", lambda: unchanged(scratch("n8", "do $body$ begin perform length($$inner execute$$); end $body$;\n")))
check("nested dollar string naming search_path refused (body clean text)", lambda: refuses(scratch("n9", "do $$ begin perform length($m$search_path$m$); end $$;\n"), "does not read"))
# --- round fourteen, finding 2: labels as code spans
d = scratch("m1", "create type t as enum ('two · labels', 'b');\n")
check("label containing the separator: fixed renders one code span", lambda: line_for(d, "t").endswith("`two · labels` · `b`"))
check("label with a backtick gets a longer fence", lambda: line_for(scratch("m2", "create type t as enum ('a`b');\n"), "t").endswith("``a`b``"))
check("label with a newline refused", lambda: refuses(scratch("m3", "create type t as enum ('a\nb');\n"), "control character"))
check("padded label keeps its spaces through CommonMark stripping", lambda: line_for(scratch("m4", "create type t as enum ('  padded ');\n"), "t").endswith("`   padded  `"))
check("label shaped like a list item stays one value", lambda: line_for(scratch("m5", "create type t as enum ('- x', 'y');\n"), "t").endswith("`- x` · `y`"))
check("label starting with a backtick padded", lambda: line_for(scratch("m6", "create type t as enum ('`x');\n"), "t").endswith("`` `x ``"))
# --- round fifteen, finding 1: quoted schema identity
d = scratch("q1", "set search_path = " + DQ + "PUBLIC" + DQ + ", public;\ncreate type mood as enum ('x');\n")
check("quoted PUBLIC schema: fixed refuses naming search_path", lambda: refuses(d, "moves search_path"))
check("quoted lowercase public allowed", lambda: unchanged(scratch("q2", "set search_path = " + DQ + "public" + DQ + ";\n")))
check("unquoted mixed-case Public folds and is allowed", lambda: unchanged(scratch("q3", "set search_path = Public;\n")))
check("single-quoted string holding unquoted PUBLIC folds and is allowed", lambda: unchanged(scratch("q4", "set search_path = 'PUBLIC';\n")))
check("single-quoted string holding a quoted PUBLIC refused", lambda: refuses(scratch("q5", "set search_path = '" + DQ + "PUBLIC" + DQ + "';\n"), "moves search_path"))
check("set_config with a quoted PUBLIC first refused", lambda: refuses(scratch("q6", "select set_config('search_path', '" + DQ + "PUBLIC" + DQ + ", public', false);\n"), "moves search_path"))
check("set schema with a quoted PUBLIC refused", lambda: refuses(scratch("q7", "set schema '" + DQ + "PUBLIC" + DQ + "';\n"), "moves search_path"))
check("set_config public-first literal still allowed", lambda: unchanged(scratch("q8", "select set_config('search_path', 'public, private', false);\n")))
# --- round fifteen, finding 2: all-whitespace labels
d = scratch("w1", "create type t as enum (' ', 'b');\n")
check("one-space label: fixed refuses", lambda: refuses(d, "only whitespace"))
check("three-space label refused", lambda: refuses(scratch("w2", "create type t as enum ('   ');\n"), "only whitespace"))
check("empty label refused", lambda: refuses(scratch("w3", "create type t as enum ('');\n"), "only whitespace"))
check("interior space label still rendered", lambda: line_for(scratch("w4", "create type t as enum ('a b');\n"), "t").endswith("`a b`"))
# --- round fifteen, finding 3: dollar tag inside an identifier
codex15 = "select 1 as first$tag$;\ncreate type mood as enum ('x');\nselect 1 as second$tag$;\n"
d = scratch("d1", codex15)
check("$tag$ inside two aliases: fixed catalogues the enum", lambda: run(d)[1].get("mood") == ["x"])
check("$$ inside two aliases likewise", lambda: run(scratch("d2", "select 1 as a$$;\ncreate type mood as enum ('x');\nselect 1 as b$$;\n"))[1].get("mood") == ["x"])
check("a real dollar quote after whitespace still opens (DDL inside refused)", lambda: refuses(scratch("d4", "select 1 as x$tag$;\ndo $tag$ begin execute 'create type mood as enum (''x'')'; end $tag$;\n"), "does not read"))
check("a dollar quote after an open paren still opens (its DDL is refused, proving the region was read)", lambda: refuses(scratch("d5", "select length($q$abc create type$q$);\n"), "does not read"))
check("a dollar quote after an open paren with inert contents allowed", lambda: unchanged(scratch("d5b", "select length($q$abc execute$q$);\n")))
check("a dollar quote at file start still opens", lambda: refuses(scratch("d6", "$doc$create type ghost as enum ('x');$doc$;\n"), "does not read"))

# --- round sixteen, finding 2: an empty enum body is legal SQL
d = scratch("e1", "create type phase as enum ();\n")
check("empty enum: fixed catalogues it with no values", lambda: run(d)[1].get("phase") == [])
check("empty enum renders (no values)", lambda: line_for(d, "phase").endswith("): (no values)"))
check("empty enum counted in the header", lambda: run(d)[0].splitlines()[2].startswith(f"{committed_count + 1} enum types"))
check("empty then add value populates", lambda: run(scratch("e2", "create type phase as enum ();\nalter type phase add value 'x';\n"))[1].get("phase") == ["x"])
check("empty then add value renders the value", lambda: line_for(scratch("e2", "create type phase as enum ();\nalter type phase add value 'x';\n"), "phase").endswith("`x`"))
check("whitespace-only body accepted", lambda: run(scratch("e3", "create type phase as enum (  \n );\n"))[1].get("phase") == [])
check("bare comma body refused", lambda: refuses(scratch("e4", "create type phase as enum (,);\n")))
check("empty label still refused", lambda: refuses(scratch("e5", "create type phase as enum ('');\n"), "only whitespace"))
check("empty enum then drop leaves the catalogue unchanged", lambda: run(scratch("e6", "create type phase as enum ();\ndrop type phase;\n"))[0] == committed)

# --- round seventeen: standard_conforming_strings
BSN = chr(92) + "n"
SCS = "standard_conforming_strings"
d = scratch("c1", "set standard_conforming_strings = off;\ncreate type mood as enum ('line" + BSN + "feed');\n")
check("scs off: fixed refuses naming the setting", lambda: refuses(d, SCS))
check("set local … to off refused", lambda: refuses(scratch("c2", "set local standard_conforming_strings to off;\n"), SCS))
check("set session … = false refused", lambda: refuses(scratch("c3", "set session standard_conforming_strings = false;\n"), SCS))
check("= 0 refused", lambda: refuses(scratch("c4", "set standard_conforming_strings = 0;\n"), SCS))
check("= 'no' refused", lambda: refuses(scratch("c5", "set standard_conforming_strings = 'no';\n"), SCS))
check("quoted identifier form refused", lambda: refuses(scratch("c6", 'set "standard_conforming_strings" = off;\n'), SCS))
check("= on allowed", lambda: unchanged(scratch("c7", "set standard_conforming_strings = on;\n")))
check("= 'ON' allowed", lambda: unchanged(scratch("c8", "set standard_conforming_strings = 'ON';\n")))
check("to true allowed", lambda: unchanged(scratch("c9", "set local standard_conforming_strings to true;\n")))
check("to default allowed", lambda: unchanged(scratch("c10", "set standard_conforming_strings to default;\n")))
check("reset allowed", lambda: unchanged(scratch("c11", "reset standard_conforming_strings;\n")))
check("set_config off refused", lambda: refuses(scratch("c12", "select set_config('standard_conforming_strings', 'off', false);\n"), SCS))
check("set_config on allowed", lambda: unchanged(scratch("c13", "select set_config('standard_conforming_strings', 'on', true);\n")))
check("set_config computed value refused", lambda: refuses(scratch("c14", "select set_config('standard_conforming_strings', lower('OFF'), false);\n"), SCS))
check("alter database … refused", lambda: refuses(scratch("c15", "alter database postgres set standard_conforming_strings = off;\n"), SCS))
check("alter role … refused", lambda: refuses(scratch("c16", "alter role postgres set standard_conforming_strings = off;\n"), SCS))
check("alter system … search_path refused too", lambda: refuses(scratch("c16b", "alter system set search_path = private;\n"), "moves search_path"))
check("DO body turning it off refused", lambda: refuses(scratch("c17", "do $$ begin set standard_conforming_strings = off; end $$;\n"), "does not read"))
check("body EXECUTE turning it off refused", lambda: refuses(scratch("c18", "do $$ begin execute 'set standard_conforming_strings = off'; end $$;\n"), "does not read"))
check("the words inside a value are inert", lambda: unchanged(scratch("c19", "select 'set standard_conforming_strings = off';\n")))
check("the words inside a comment are inert", lambda: unchanged(scratch("c20", "-- set standard_conforming_strings = off\ncomment on type payment_status is 'standard_conforming_strings';\n")))
check("search_path guard still works", lambda: refuses(scratch("c21", "set search_path = private, public;\n"), "moves search_path"))
check("set_config computed NAME still refused", lambda: refuses(scratch("c22", "select set_config(lower('SEARCH_PATH'), 'private', false);\n"), "moves search_path"))

# --- round nineteen: the bare DEFAULT keyword is a reset
d = scratch("f1", "set search_path to default;\ncreate type mood as enum ('x');\n")
check("search_path TO DEFAULT: fixed reads the create after it", lambda: run(d)[1].get("mood") == ["x"])
check("search_path = DEFAULT allowed", lambda: unchanged(scratch("f2", "set search_path = DEFAULT;\n")))
check("set local search_path to default allowed", lambda: unchanged(scratch("f3", "set local search_path to default;\n")))
check("quoted literal 'default' is a schema: refused", lambda: refuses(scratch("f4", "set search_path = 'default';\n"), "moves search_path"))
check("quoted identifier default is a schema: refused", lambda: refuses(scratch("f5", 'set search_path = "default";\n'), "moves search_path"))
check("set_config search_path 'default' is a schema: refused", lambda: refuses(scratch("f6", "select set_config('search_path', 'default', false);\n"), "moves search_path"))
check("scs TO DEFAULT still allowed", lambda: unchanged(scratch("f7", "set standard_conforming_strings to default;\n")))
d8 = scratch("f8", "set standard_conforming_strings = 'default';\n")
check("scs = 'default': fixed refuses", lambda: refuses(d8, "standard_conforming_strings"))
check("default then private still refused", lambda: refuses(scratch("f9", "set search_path to default;\nset search_path = private;\n"), "moves search_path"))
check("reset all allowed", lambda: unchanged(scratch("f10", "reset all;\n")))

# --- round twenty: ALTER ROLE/DATABASE reset forms
d = scratch("g1", "alter role postgres set search_path to default;\n")
check("alter role … set search_path to default: fixed allows", lambda: unchanged(d))
check("alter role … reset search_path allowed", lambda: unchanged(scratch("g2", "alter role postgres reset search_path;\n")))
check("alter database … reset search_path allowed", lambda: unchanged(scratch("g3", "alter database postgres reset search_path;\n")))
check("alter role … in database … = DEFAULT allowed", lambda: unchanged(scratch("g4", "alter role postgres in database postgres set search_path = DEFAULT;\n")))
check("alter role … reset all allowed", lambda: unchanged(scratch("g5", "alter role postgres reset all;\n")))
check("alter system reset search_path allowed", lambda: unchanged(scratch("g6", "alter system reset search_path;\n")))
check("alter role … set search_path = private still refused", lambda: refuses(scratch("g7", "alter role postgres set search_path = private;\n"), "moves search_path"))
check("alter role … set search_path from current refused", lambda: refuses(scratch("g8", "alter role postgres set search_path from current;\n"), "moves search_path"))
check("alter role … set search_path = 'a, default' refused (a value)", lambda: refuses(scratch("g9", "alter role postgres set search_path = 'a, default';\n"), "moves search_path"))
check("alter role … set scs to default allowed", lambda: unchanged(scratch("g10", "alter role postgres set standard_conforming_strings to default;\n")))
check("alter role … reset scs allowed", lambda: unchanged(scratch("g11", "alter role postgres reset standard_conforming_strings;\n")))
check("alter role … set scs = off still refused", lambda: refuses(scratch("g12", "alter role postgres set standard_conforming_strings = off;\n"), "standard_conforming_strings"))
check("alter system set search_path = private still refused", lambda: refuses(scratch("g13", "alter system set search_path = private;\n"), "moves search_path"))

# --- round twenty-one: the current role decides where an unqualified type lands
ROLE = "switches the current role"
codex21 = "create schema authorization authenticated;\nset role authenticated;\ncreate type mood as enum ('happy');\n"
d = scratch("h1", codex21)
check("set role then unqualified create: fixed refuses naming the role switch", lambda: refuses(d, ROLE))
check("set local role refused", lambda: refuses(scratch("h2", "set local role authenticated;\n"), ROLE))
check("set session role refused", lambda: refuses(scratch("h3", "set session role authenticated;\n"), ROLE))
check("set role none allowed", lambda: unchanged(scratch("h4", "set role none;\n")))
check("reset role allowed", lambda: unchanged(scratch("h5", "reset role;\n")))
check("set session authorization refused", lambda: refuses(scratch("h6", "set session authorization authenticated;\n"), ROLE))
check("set local session authorization default allowed", lambda: unchanged(scratch("h7", "set local session authorization default;\n")))
check("reset session authorization allowed", lambda: unchanged(scratch("h8", "reset session authorization;\n")))
check("set_config role refused", lambda: refuses(scratch("h9", "select set_config('role', 'authenticated', true);\n"), ROLE))
check("set_config role none allowed", lambda: unchanged(scratch("h10", "select set_config('role', 'none', true);\n")))
check("set_config session_authorization refused", lambda: refuses(scratch("h11", "select set_config('session_authorization', 'postgres', false);\n"), ROLE))
check("alter role … set role = x refused", lambda: refuses(scratch("h12", "alter role postgres set role = authenticated;\n"), ROLE))
check("alter role … set session_authorization refused", lambda: refuses(scratch("h13", "alter role postgres set session_authorization = authenticated;\n"), ROLE))
check("alter role … reset role allowed", lambda: unchanged(scratch("h14", "alter role postgres reset role;\n")))
check("alter role … set role to default allowed", lambda: unchanged(scratch("h15", "alter role postgres set role to default;\n")))
check("alter role … set work_mem allowed (the word role in ALTER ROLE is not a switch)", lambda: unchanged(scratch("h16", "alter role postgres set work_mem = '1MB';\n")))
check("alter role … set quoted search_path still refused", lambda: refuses(scratch("h17", 'alter role postgres set "search_path" = private;\n'), "moves search_path"))
check("alter role … set search_path from current still refused", lambda: refuses(scratch("h18", "alter role postgres set search_path from current;\n"), "moves search_path"))
check("DO body switching role refused", lambda: refuses(scratch("h19", "do $$ begin set local role authenticated; end $$;\n"), "does not read"))
check("the words inside a value are inert", lambda: unchanged(scratch("h20", "select 'set role authenticated';\n")))
check("session authorization inside a comment value is inert", lambda: unchanged(scratch("h21", "comment on type payment_status is 'session authorization';\n")))
check("a body calling auth.role() is fine", lambda: unchanged(scratch("h22", "create function probe_role() returns text language sql as $$ select auth.role() $$;\n")))
check("a qualified create after set role is still refused (rule is on the switch)", lambda: refuses(scratch("h23", "set role authenticated;\ncreate type public.mood as enum ('happy');\n"), ROLE))

# --- round twenty-two: the generic GUC forms of role and session_authorization
DQ = chr(34)
d = scratch("i1", "set " + DQ + "role" + DQ + " = authenticated;\ncreate type mood as enum ('happy');\n")
check("set \"role\" = x then create: fixed refuses", lambda: refuses(d, ROLE))
d2 = scratch("i2", "set session_authorization = authenticated;\ncreate type mood as enum ('happy');\n")
check("set session_authorization = x: fixed refuses", lambda: refuses(d2, ROLE))
check("set role = x refused", lambda: refuses(scratch("i3", "set role = authenticated;\n"), ROLE))
check("set role to x refused", lambda: refuses(scratch("i4", "set role to authenticated;\n"), ROLE))
check("set \"role\" to 'x' refused", lambda: refuses(scratch("i5", "set " + DQ + "role" + DQ + " to 'authenticated';\n"), ROLE))
check("set \"session_authorization\" to x refused", lambda: refuses(scratch("i6", "set " + DQ + "session_authorization" + DQ + " to authenticated;\n"), ROLE))
check("set session_authorization to 'x' refused", lambda: refuses(scratch("i7", "set session_authorization to 'postgres';\n"), ROLE))
check("set role = 'none' allowed", lambda: unchanged(scratch("i8", "set role = 'none';\n")))
check("set role to default allowed", lambda: unchanged(scratch("i9", "set role to default;\n")))
check("set \"role\" = none allowed", lambda: unchanged(scratch("i10", "set " + DQ + "role" + DQ + " = none;\n")))
check("set session_authorization = default allowed", lambda: unchanged(scratch("i11", "set session_authorization = default;\n")))
check("body set \"role\" = x refused", lambda: refuses(scratch("i12", "do $$ begin set " + DQ + "role" + DQ + " = authenticated; end $$;\n"), "does not read"))
check("body set session_authorization refused", lambda: refuses(scratch("i13", "do $$ begin set session_authorization = authenticated; end $$;\n"), "does not read"))
check("the generic form inside a value is inert", lambda: unchanged(scratch("i14", "select 'set " + DQ + "role" + DQ + " = authenticated';\n")))
check("a column named role in a body is fine", lambda: unchanged(scratch("i15", "create function probe_r() returns text language sql as $$ select role from pg_roles_view $$;\n")))

# --- round twenty-three: set_config inside a procedural body
codex23 = "do $$ begin perform set_config('role', 'authenticated', false); end $$;\ncreate type mood as enum ('happy');\n"
d = scratch("j1", codex23)
check("body set_config(role) then create: fixed refuses", lambda: refuses(d, "does not read"))
check("body set_config(role, none) refused too (a body is not a value)", lambda: refuses(scratch("j2", "do $$ begin perform set_config('role', 'none', false); end $$;\n"), "does not read"))
check("body set_config(session_authorization) refused", lambda: refuses(scratch("j3", "do $$ begin perform set_config('session_authorization', 'postgres', false); end $$;\n"), "does not read"))
check("body set_config(standard_conforming_strings) refused", lambda: refuses(scratch("j4", "do $$ begin perform set_config('standard_conforming_strings', 'off', false); end $$;\n"), "does not read"))
check("body set_config(search_path) refused", lambda: refuses(scratch("j5", "do $$ begin perform set_config('search_path', 'private', false); end $$;\n"), "does not read"))
check("body EXECUTE of a set_config(role) literal refused", lambda: refuses(scratch("j6", "do $$ begin execute 'select set_config(''role'', ''authenticated'', false)'; end $$;\n"), "does not read"))
check("body format() template with %L name refused as unreadable", lambda: refuses(scratch("j7", "do $$ begin execute format('select set_config(%L, %L, false)', 'role', 'x'); end $$;\n"), "does not read"))
check("body set_config with a variable name refused as unreadable", lambda: refuses(scratch("j8", "do $$ declare v text := 'role'; begin perform set_config(v, 'x', false); end $$;\n"), "does not read"))
check("body set_config of an unguarded literal allowed", lambda: unchanged(scratch("j9", "do $$ begin perform set_config('work_mem', '1MB', true); end $$;\n")))
check("function body set_config(role) refused", lambda: refuses(scratch("j10", "create function probe_sc() returns void language plpgsql as $$ begin perform set_config('role', 'authenticated', false); end $$;\n"), "does not read"))
check("top-level value naming set_config(role) is inert", lambda: unchanged(scratch("j11", "select 'set_config(''role'', ''x'', false)';\n")))
check("body quoted \"set_config\"(role) refused", lambda: refuses(scratch("j12", 'do $$ begin perform "set_config"(' + "'role', 'authenticated', false); end $$;\n"), "does not read"))

# --- round twenty-four: the name must be the entire first argument
codex24 = "do $$ begin perform set_config('ro' || 'le', 'authenticated', false); end $$;\ncreate type mood as enum ('happy');\n"
d = scratch("k1", codex24)
check("body concat name then create: fixed refuses", lambda: refuses(d, "does not read"))
d2 = scratch("k2", "select set_config('ro' || 'le', 'authenticated', false);\ncreate type mood as enum ('happy');\n")
check("top-level concat name: fixed refuses", lambda: refuses(d2, "moves search_path"))
check("body 'search' || '_path' refused", lambda: refuses(scratch("k3", "do $$ begin perform set_config('search' || '_path', 'private', false); end $$;\n"), "does not read"))
check("body cast name refused as unreadable", lambda: refuses(scratch("k4", "do $$ begin perform set_config('role'::text, 'x', false); end $$;\n"), "does not read"))
check("body E'' name refused as unreadable", lambda: refuses(scratch("k5", "do $$ begin perform set_config(E'role', 'x', false); end $$;\n"), "does not read"))
check("body unguarded literal with spaces allowed", lambda: unchanged(scratch("k6", "do $$ begin perform set_config( 'work_mem' , '1MB', true); end $$;\n")))
check("top-level unguarded concat refused (a computed name could be any setting)", lambda: refuses(scratch("k7", "select set_config('work_mem' || '', '1MB', true);\n"), "moves search_path"))
check("top-level unguarded literal still allowed", lambda: unchanged(scratch("k8", "select set_config('work_mem', '1MB', true);\n")))
check("body EXECUTE'd doubled-quote guarded name still refused", lambda: refuses(scratch("k9", "do $$ begin execute 'select set_config(''role'', ''x'', false)'; end $$;\n"), "does not read"))

# --- round twenty-five: a created or renamed schema may be "$user"
SHADOW = "may be the current user's"
def scratch2(name, sql52, sql53):
    d = scratch(name, sql52); (d / f"{PROBE2}_probe2.sql").write_text(sql53); return d
codex25 = "create schema authorization current_user;\ncreate type mood as enum ('happy');\n"
d = scratch("l1", codex25)
check("schema authorization current_user then create: fixed refuses, naming the qualification", lambda: refuses(d, SHADOW))
check("qualified create after the schema is read", lambda: run(scratch("l2", "create schema authorization current_user;\ncreate type public.mood as enum ('happy');\n"))[1].get("mood") == ["happy"])
check("any created schema counts (the role is unknowable): private then unqualified refused", lambda: refuses(scratch("l3", "create schema private;\ncreate type mood as enum ('happy');\n"), SHADOW))
check("create schema public itself is exempt", lambda: run(scratch("l4", "create schema if not exists public;\ncreate type mood as enum ('happy');\n"))[1].get("mood") == ["happy"])
check("unqualified alter after a schema refused", lambda: refuses(scratch("l5", "create schema postgres;\nalter type payment_status add value 'x';\n"), SHADOW))
check("qualified alter after a schema applied", lambda: "x" in run(scratch("l6", "create schema postgres;\nalter type public.payment_status add value 'x';\n"))[1]["payment_status"])
check("unqualified drop after a schema refused", lambda: refuses(scratch("l7", "create schema postgres;\ndrop type payment_status;\n"), SHADOW))
check("qualified drop after a schema applied", lambda: "payment_status" not in run(scratch("l8", "create schema postgres;\ndrop type public.payment_status cascade;\n"))[2])
check("the rule persists into later files", lambda: refuses(scratch2("l9", "create schema private;\n", "create type mood as enum ('happy');\n"), SHADOW))
check("a rename to the role name counts", lambda: refuses(scratch("l10", "create schema private;\nalter schema private rename to postgres;\ncreate type mood as enum ('happy');\n"), SHADOW))
check("enum DDL before the schema is unaffected", lambda: run(scratch("l11", "create type mood as enum ('happy');\ncreate schema private;\n"))[1].get("mood") == ["happy"])
check("a body creating a schema refused", lambda: refuses(scratch("l12", "do $$ begin execute 'create schema authorization current_user'; end $$;\n"), "does not read"))
check("the words inside a value are inert", lambda: unchanged(scratch("l13", "select 'create schema authorization current_user';\n")))

# --- round twenty-six: the public exemption must read the whole identifier
DQ = chr(34)
d = scratch("m1", "create schema public$deploy;\ncreate type mood as enum ('happy');\n")
check("create schema public$deploy then create: fixed refuses", lambda: refuses(d, SHADOW))
check("create schema public_x counts", lambda: refuses(scratch("m2", "create schema public_x;\ncreate type mood as enum ('happy');\n"), SHADOW))
check("create schema publicx counts", lambda: refuses(scratch("m3", "create schema publicx;\ncreate type mood as enum ('happy');\n"), SHADOW))
check("create schema \"Public\" counts (a different schema)", lambda: refuses(scratch("m4", "create schema " + DQ + "Public" + DQ + ";\ncreate type mood as enum ('happy');\n"), SHADOW))
check("create schema \"public\" is exempt", lambda: run(scratch("m5", "create schema " + DQ + "public" + DQ + ";\ncreate type mood as enum ('happy');\n"))[1].get("mood") == ["happy"])
check("create schema public authorization x is exempt (the name is public)", lambda: run(scratch("m6", "create schema public authorization postgres;\ncreate type mood as enum ('happy');\n"))[1].get("mood") == ["happy"])
check("create schema public; still exempt", lambda: run(scratch("m7", "create schema public;\ncreate type mood as enum ('happy');\n"))[1].get("mood") == ["happy"])
check("create schema \"PUBLIC\" counts (quoted names are exact)", lambda: refuses(scratch("m8", "create schema " + DQ + "PUBLIC" + DQ + ";\ncreate type mood as enum ('happy');\n"), SHADOW))
check("CREATE SCHEMA PUBLIC (unquoted, upper) is exempt", lambda: run(scratch("m9", "CREATE SCHEMA PUBLIC;\ncreate type mood as enum ('happy');\n"))[1].get("mood") == ["happy"])

# --- round twenty-seven: non-ASCII identifier characters
d = scratch("n1", "create schema publicé;\ncreate type mood as enum ('happy');\n")
check("create schema publicé then create: fixed refuses", lambda: refuses(d, SHADOW))
check("create schema public€ counts", lambda: refuses(scratch("n2", "create schema public€;\ncreate type mood as enum ('happy');\n"), SHADOW))
check("create schema public; still exempt after the widening", lambda: run(scratch("n3", "create schema public;\ncreate type mood as enum ('happy');\n"))[1].get("mood") == ["happy"])
check("create schema public authorization x still exempt", lambda: run(scratch("n4", "create schema public authorization postgres;\ncreate type mood as enum ('happy');\n"))[1].get("mood") == ["happy"])

# --- round twenty-eight: SQL-standard routine bodies
codex28 = "create procedure later() language sql begin atomic create type ghost as enum ('x'); end;\n"
d = scratch("o1", codex28)
check("begin atomic with enum DDL: fixed refuses by name", lambda: refuses(d, "BEGIN ATOMIC"))
check("begin atomic without enum DDL refused too (the rule is on the form)", lambda: refuses(scratch("o2", "create function two() returns int language sql begin atomic select 2; end;\n"), "BEGIN ATOMIC"))
check("BEGIN ATOMIC upper-case refused", lambda: refuses(scratch("o3", "CREATE PROCEDURE later() LANGUAGE SQL BEGIN ATOMIC SELECT 1; END;\n"), "BEGIN ATOMIC"))
check("dollar-quoted procedure body with DDL still refused as a body", lambda: refuses(scratch("o4", "create procedure later() language sql as $$ create type ghost as enum ('x'); $$;\n"), "does not read"))
check("the RETURN form of a SQL body is allowed", lambda: unchanged(scratch("o5", "create function one() returns int language sql return 1;\n")))
check("the words inside a value are inert", lambda: unchanged(scratch("o6", "select 'begin atomic';\n")))
check("the words inside a comment are inert", lambda: unchanged(scratch("o7", "-- begin atomic is not used here\nselect 1;\n")))

# --- round twenty-nine: non-ASCII dollar-quote tags
codex29 = "do $é$ begin execute 'create ' || 'type public.ghost as enum (''x'')'; end $é$;\n"
d = scratch("p1", codex29)
check("$é$ body with a concatenated EXECUTE: fixed refuses as unreadable", lambda: refuses(d, "does not read"))
check("$é$ value carrying DDL refused", lambda: refuses(scratch("p2", "comment on type payment_status is $é$create type ghost as enum ('x')$é$;\n"), "does not read"))
check("$日本$ body with inert content allowed", lambda: unchanged(scratch("p3", "do $日本$ begin perform 1; end $日本$;\n")))
check("$日本$ plain value allowed", lambda: unchanged(scratch("p4", "select $日本$plain value$日本$;\n")))
check("$é$ body with a plain-literal EXECUTE of DDL refused", lambda: refuses(scratch("p5", "do $é$ begin execute 'create type public.ghost as enum (''x'')'; end $é$;\n"), "does not read"))
check("an identifier ending in $é$ is not a tag", lambda: unchanged(scratch("p6", "select 1 as a$é$;\nselect 2 as b$é$;\n")))
check("ASCII tags still work", lambda: refuses(scratch("p7", "do $q$ begin execute 'create type public.ghost as enum (''x'')'; end $q$;\n"), "does not read"))

# --- round thirty A: every non-ASCII predecessor continues an identifier
codex30a = "select 1 as first€$tag$;\ncreate type mood as enum ('x');\nselect 1 as second€$tag$;\n"
d = scratch("q1", codex30a)
check("€ before $tag$: fixed catalogues the enum", lambda: run(d)[1].get("mood") == ["x"])
check("é before $$ likewise", lambda: run(scratch("q2", "select 1 as aé$$;\ncreate type mood as enum ('x');\nselect 1 as bé$$;\n"))[1].get("mood") == ["x"])
check("a real dollar quote after € and a space still opens (DDL inside refused)", lambda: refuses(scratch("q3", "select 1 as a€ $q$create type$q$;\n"), "does not read"))
# --- round thirty B: a schema-qualified set_config is somebody else's function
codex30b = "select app.set_config('role', 'authenticated', false);\n"
d = scratch("q4", codex30b)
check("app.set_config(role): fixed allows", lambda: unchanged(d))
check("pg_catalog.set_config(role) still refused", lambda: refuses(scratch("q5", "select pg_catalog.set_config('role', 'authenticated', false);\n"), "switches the current role"))
check("public.set_config(role) still refused", lambda: refuses(scratch("q6", "select public.set_config('role', 'authenticated', false);\n"), "switches the current role"))
check("quoted \"pg_catalog\".\"set_config\"(role) still refused", lambda: refuses(scratch("q7", 'select "pg_catalog"."set_config"(' + "'role', 'authenticated', false);\n"), "switches the current role"))
check("quoted \"app\".set_config allowed", lambda: unchanged(scratch("q8", 'select "app".set_config(' + "'role', 'authenticated', false);\n")))
check("app . set_config with spaces allowed", lambda: unchanged(scratch("q9", "select app . set_config('role', 'authenticated', false);\n")))
check("unqualified set_config(role) still refused", lambda: refuses(scratch("q10", "select set_config('role', 'authenticated', false);\n"), "switches the current role"))
check("body app.set_config(role) allowed", lambda: unchanged(scratch("q11", "do $$ begin perform app.set_config('role', 'authenticated', false); end $$;\n")))
check("body pg_catalog.set_config(role) still refused", lambda: refuses(scratch("q12", "do $$ begin perform pg_catalog.set_config('role', 'authenticated', false); end $$;\n"), "does not read"))
check("body unqualified set_config(role) still refused", lambda: refuses(scratch("q13", "do $$ begin perform set_config('role', 'authenticated', false); end $$;\n"), "does not read"))
check("app.set_config(search_path) allowed too", lambda: unchanged(scratch("q14", "select app.set_config('search_path', 'private', false);\n")))

# --- round thirty-one: identifier boundaries by the lexer's rule, everywhere
codex31 = "select custom$set_config('role', 'authenticated', false);\n"
d = scratch("r31a", codex31)
check("custom$set_config(role): fixed allows", lambda: unchanged(d))
scratch('r31b', "select x·set_config('role', 'authenticated', false);\n")
check("x·set_config(role): fixed allows", lambda: unchanged(S/"r31b"))
check("custom$set_config(search_path): fixed allows", lambda: unchanged(scratch("r31c", "select custom$set_config('search_path', 'private', false);\n")))
scratch('r31d', "do $$ begin perform custom$set_config('role', 'authenticated', false); end $$;\n")
check("body custom$set_config(role): fixed allows", lambda: unchanged(S/"r31d"))
check("unqualified set_config(role) still refused", lambda: refuses(scratch("r31e", "select set_config('role', 'authenticated', false);\n"), "switches the current role"))
check("body set_config(role) still refused", lambda: refuses(scratch("r31f", "do $$ begin perform set_config('role', 'authenticated', false); end $$;\n"), "does not read"))
check("body EXECUTE'd set_config(role) still refused (clean-text scan kept)", lambda: refuses(scratch("r31g", "do $$ begin execute 'select set_config(''role'', ''authenticated'', false)'; end $$;\n"), "does not read"))
check("two spaces then set_config( is still the built-in", lambda: refuses(scratch("r31h", "select  set_config('role', 'authenticated', false);\n"), "switches the current role"))
scratch('r31i', "do $$ declare v$search_path text := 'x'; begin raise notice '%', v$search_path; end $$;\n")
check("body variable v$search_path: fixed allows", lambda: unchanged(S/"r31i"))
scratch('r31j', "do $$ declare search_path$1 text := 'x'; begin raise notice '%', search_path$1; end $$;\n")
check("body variable search_path$1: fixed allows", lambda: unchanged(S/"r31j"))
check("body mentioning search_path in a string still refused", lambda: refuses(scratch("r31k", "do $$ begin raise notice 'search_path'; end $$;\n"), "does not read"))
scratch('r31l', 'do $$ declare r record; begin select 1 as my$execute into r; end $$;\n')
check("body alias my$execute: fixed allows", lambda: unchanged(S/"r31l"))
check("body EXECUTE of a variable still refused", lambda: refuses(scratch("r31m", "do $$ declare q text := 'x'; begin execute q; end $$;\n"), "does not read"))
check("body EXECUTE … INTO still parsed (literal command allowed)", lambda: unchanged(scratch("r31m2", "do $$ declare n int; begin execute 'select 1' into n; end $$;\n")))
d = scratch("r31n", "alter role my$set set search_path = private;\n")
check("alter role my$set set search_path: fixed refuses", lambda: refuses(d, "moves search_path"))
check("alter role my$set set work_mem allowed", lambda: unchanged(scratch("r31o", "alter role my$set set work_mem = '64MB';\n")))
check("alter role my$set reset search_path allowed", lambda: unchanged(scratch("r31p", "alter role my$set reset search_path;\n")))
check("alter role my$set set search_path to default allowed", lambda: unchanged(scratch("r31q", "alter role my$set set search_path to default;\n")))
check("set role to$x still refused (a switch to a role named to$x)", lambda: refuses(scratch("r31r", "set role to$x;\n"), "switches the current role"))
check("set search_path to$x still refused (a schema named to$x)", lambda: refuses(scratch("r31r2", "set search_path to$x;\n"), "moves search_path"))
check("create schema public$deploy still counts (round 26 control)", lambda: refuses(scratch("r31s", "create schema public$deploy;\ncreate type mood as enum ('happy');\n"), SHADOW))
check("begin atomic still refused", lambda: refuses(scratch("r31t", "create procedure later() language sql begin atomic select 1; end;\n"), "BEGIN ATOMIC"))
check("drop type with cascade still read", lambda: "payment_status" not in run(scratch("r31u", "drop type payment_status cascade;\n"))[2])
check("create type$x is not an enum statement and not a crash", lambda: run(scratch("r31v", "select 1 as type$x;\n"))[0] == committed)
# Round thirty-one made the lexer's identifier boundary the one rule for every
# SQL scan, because Python's `\b` stops at `$` and at non-ASCII letters where
# PostgreSQL's lexer continues an identifier — four rounds paid for that. The
# rule lives in the GENERATOR now: every SQL-reading pattern is built by
# `sql_re`, which refuses `\b` at construction, so the proofs pin the factory
# and that the scanners go through it. A ban over source lines refused a `\b`
# in an error message (Codex on PR #90, round six) and a scan over every
# compiled pattern would refuse one in the Markdown-label or block-replacement
# regexes, which read no SQL (round seven); those use `re` directly and are
# outside the rule by construction.
check("sql_re refuses a word boundary and names the rule", lambda: refused_with(lambda: gen.sql_re(r"alter\s+type\b"), "IDENT_START"))
check("sql_re compiles an ordinary SQL pattern", lambda: gen.sql_re(r"alter\s+type", re.I).match("ALTER TYPE x") is not None)
check("the generator builds its SQL scanners through sql_re (a rule applied to something)", lambda: sql_re_call_count(GENERATOR) >= 40)

# --- round thirty-two A: only the literal in body position is a routine body
codex32a = "create function f(x text default 'create type') returns text language sql as $$ select x $$;\n"
d = scratch("s32a", codex32a)
check("default 'create type': fixed allows", lambda: unchanged(d))
scratch('s32b', "create function f(x text default 'search_path') returns text language sql as $$ select x $$;\n")
check("default 'search_path': fixed allows", lambda: unchanged(S/"s32b"))
check("upper-case DEFAULT and AS still parsed", lambda: unchanged(scratch("s32b2", "CREATE FUNCTION f(x TEXT DEFAULT 'create type') RETURNS TEXT LANGUAGE SQL AS $$ SELECT x $$;\n")))
check("dollar-quoted default carrying DDL still refused as a value", lambda: refuses(scratch("s32c", "create function f(x text default $d$create type$d$) returns text language sql as $$ select x $$;\n"), "does not read"))
check("function body with DDL still refused", lambda: refuses(scratch("s32d", "create function f() returns void language plpgsql as $$ begin execute 'create type public.mood as enum (''x'')'; end $$;\n"), "does not read"))
check("body after a default still checked", lambda: refuses(scratch("s32d2", "create function f(x text default 'a') returns void language plpgsql as $$ begin execute 'create type public.mood as enum (''x'')'; end $$;\n"), "does not read"))
check("single-quoted function body with a role switch still refused", lambda: refuses(scratch("s32e", "create function f() returns void language plpgsql as 'begin perform set_config(''role'', ''authenticated'', false); end';\n"), "does not read"))
check("AS then newline then body still a body", lambda: refuses(scratch("s32e2", "create function f() returns void language plpgsql as\n  $$ begin execute 'create type public.mood as enum (''x'')'; end $$;\n"), "does not read"))
check("DO body still refused", lambda: refuses(scratch("s32f", "do $$ begin execute 'create type public.mood as enum (''x'')'; end $$;\n"), "does not read"))
check("DO LANGUAGE plpgsql body still refused", lambda: refuses(scratch("s32g", "do language plpgsql $$ begin execute 'create type public.mood as enum (''x'')'; end $$;\n"), "does not read"))
check("single-quoted DO body still refused", lambda: refuses(scratch("s32h", "DO 'BEGIN EXECUTE ''CREATE TYPE mood AS ENUM (''''x'''')''; END';\n"), "does not read"))
check("a role switch in a DEFAULT expression is still caught by the top-level reader", lambda: refuses(scratch("s32i", "create function g(x text default set_config('role', 'authenticated', false)) returns text language sql as $$ select x $$;\n"), "switches the current role"))
check("C function AS 'obj', 'sym' allowed", lambda: unchanged(scratch("s32j", "create function h() returns text language c as 'obj_file', 'link_symbol';\n")))
check("function SET clause with a quoted value is not a body", lambda: unchanged(scratch("s32k", "create function f() returns int language sql set search_path = 'public' as $$ select 1 $$;\n")))
check("RETURN form with a literal is data", lambda: unchanged(scratch("s32m", "create function one() returns text language sql return 'create type';\n")))
check("a literal in an ordinary statement is still data", lambda: unchanged(scratch("s32m2", "select 'create type';\n")))
# --- round thirty-two B: a setting's name is read whole
codex32b = "alter role deploy set search_path.custom = 'value';\n"
d = scratch("s32n", codex32b)
check("alter role … set search_path.custom: fixed allows", lambda: unchanged(d))
scratch('s32o', "set search_path.custom = 'x';\n")
check("set search_path.custom: fixed allows", lambda: unchanged(S/"s32o"))
check("set \"search_path\".custom allowed", lambda: unchanged(scratch("s32p", 'set "search_path".custom = ' + "'x';\n")))
check("set \"search_path.custom\" (quoted whole) allowed", lambda: unchanged(scratch("s32q", 'set "search_path.custom" = ' + "'z';\n")))
check("set search_path . custom (spaced dot) allowed", lambda: unchanged(scratch("s32r", "set search_path . custom = 'w';\n")))
scratch('s32s', "set role.custom = 'r';\n")
check("set role.custom: fixed allows", lambda: unchanged(S/"s32s"))
check("set standard_conforming_strings.x allowed", lambda: unchanged(scratch("s32t", "set standard_conforming_strings.x = 'q';\n")))
check("set session_authorization.x allowed", lambda: unchanged(scratch("s32u", "set session_authorization.x = 'q';\n")))
check("set schema.custom allowed (measured legal)", lambda: unchanged(scratch("s32v", "set schema.custom = 'v';\n")))
check("alter role … set role.custom allowed", lambda: unchanged(scratch("s32w", "alter role deploy set role.custom = 'r';\n")))
check("alter role … set \"a\".b allowed", lambda: unchanged(scratch("s32x", 'alter role deploy set "a".b = ' + "'v';\n")))
check("alter role … set \"search_path\".custom allowed", lambda: unchanged(scratch("s32x2", 'alter role deploy set "search_path".custom = ' + "'v';\n")))
check("alter role … set search_path = private still refused", lambda: refuses(scratch("s32y", "alter role deploy set search_path = private;\n"), "moves search_path"))
check("alter role … set \"SEARCH_PATH\" = private still refused (names fold)", lambda: refuses(scratch("s32z", 'alter role deploy set "SEARCH_PATH" = private;\n'), "moves search_path"))
check("set \"SEARCH_PATH\" = private still refused", lambda: refuses(scratch("s32z2", 'set "SEARCH_PATH" = private;\n'), "moves search_path"))
check("alter role … set role = x still refused", lambda: refuses(scratch("s32z3", "alter role deploy set role = authenticated;\n"), "switches the current role"))
check("set_config('search_path.custom') allowed", lambda: unchanged(scratch("s32z4", "select set_config('search_path.custom', 'x', false);\n")))
check("set search_path = private still refused", lambda: refuses(scratch("s32z5", "set search_path = private;\n"), "moves search_path"))
check("set role authenticated still refused", lambda: refuses(scratch("s32z6", "set role authenticated;\n"), "switches the current role"))
check("set session_authorization = x still refused", lambda: refuses(scratch("s32z7", "set session_authorization = authenticated;\n"), "switches the current role"))
check("set standard_conforming_strings = off still refused", lambda: refuses(scratch("s32z8", "set standard_conforming_strings = off;\n"), "standard_conforming_strings"))
check("E'' function body still a body", lambda: refuses(scratch("s32e3", "create function f() returns void language plpgsql as E'begin execute ''create type public.mood as enum (x)''; end';\n"), "does not read"))
check("set \"role\".custom allowed", lambda: unchanged(scratch("s32p2", 'set "role".custom = ' + "'r';\n")))
check("set \"standard_conforming_strings\".x allowed", lambda: unchanged(scratch("s32p3", 'set "standard_conforming_strings".x = ' + "'q';\n")))
check("set \"role\" = x still refused", lambda: refuses(scratch("s32p4", 'set "role" = authenticated;\n'), "switches the current role"))
check("set \"session_authorization\".x allowed", lambda: unchanged(scratch("s32p5", 'set "session_authorization".x = ' + "'q';\n")))

# --- round thirty-three: an EXECUTE'd command is a migration fragment
codex33 = "do $$ begin execute 'create /*gap*/ type public.ghost as enum (''x'')'; end $$;\n"
d = scratch("t33a", codex33)
check("comment-split DDL in an EXECUTE'd literal: fixed refuses", lambda: refuses(d, "does not read"))
scratch('t33b', "do $$ begin execute 'create -- gap\ntype public.ghost as enum (''x'')'; end $$;\n")
check("line comment with a real newline: fixed refuses", lambda: refuses(S/"t33b", "does not read"))
check("function body variant: fixed refuses", lambda: refuses(scratch("t33c", "create function mk() returns void language plpgsql as $$ begin execute 'create /*gap*/ type public.ghost as enum (''x'')'; end $$;\n"), "does not read"))
scratch('t33d', "do $$ begin execute format('create /*gap*/ type public.%I as enum (%L)', 'ghost', 'x'); end $$;\n")
check("format template split: fixed refuses", lambda: refuses(S/"t33d", "does not read"))
check("format %s argument split: fixed refuses", lambda: refuses(scratch("t33e", "do $$ begin execute format('%s', 'create /*gap*/ type public.ghost as enum (''x'')'); end $$;\n"), "does not read"))
scratch('t33f', "do $$ begin execute 'do $q$ begin execute ''create /*gap*/ type public.ghost as enum (''''x'''')''; end $q$'; end $$;\n")
check("nested DO inside an EXECUTE'd literal: fixed refuses (recursion)", lambda: refuses(S/"t33f", "does not read"))
scratch('t33g', "do $$ begin execute 'select set_config/*c*/(''role'', ''authenticated'', false)'; end $$;\n")
check("set_config split by a comment: fixed refuses", lambda: refuses(S/"t33g", "does not read"))
check("EXECUTE'd search_path change refused", lambda: refuses(scratch("t33h", "do $$ begin execute 'set /*c*/ search_path = private'; end $$;\n"), "does not read"))
check("EXECUTE'd dollar value carrying DDL refused", lambda: refuses(scratch("t33i", "do $$ begin execute 'comment on type payment_status is $d$create type ghost$d$'; end $$;\n"), "does not read"))
check("inert EXECUTE'd command still allowed", lambda: unchanged(scratch("t33j", "do $$ begin execute 'select 1'; end $$;\n")))
check("comment in an inert EXECUTE'd command still allowed", lambda: unchanged(scratch("t33k", "do $$ begin execute 'select 1 /* note */'; end $$;\n")))
check("EXECUTE'd insert with a dollar value still allowed", lambda: unchanged(scratch("t33l", "do $$ begin execute 'insert into job_runs(job) values ($v$nightly$v$)'; end $$;\n")))
check("EXECUTE … INTO with a literal still allowed", lambda: unchanged(scratch("t33m", "do $$ declare n int; begin execute 'select 1' into n; end $$;\n")))
check("EXECUTE with a $1 parameter still allowed", lambda: unchanged(scratch("t33n", "do $$ declare n int; begin execute 'select $1 + 1' into n using 1; end $$;\n")))
check("format with an inert template and args still allowed", lambda: unchanged(scratch("t33o", "do $$ begin execute format('select %L', 'hello'); end $$;\n")))
check("prose EXECUTE inside a nested dollar value is still not an EXECUTE (round fourteen)", lambda: unchanged(scratch("t33p", "do $$ begin perform length($msg$please execute this later$msg$); end $$;\n")))
check("contiguous DDL in an EXECUTE'd literal still refused", lambda: refuses(scratch("t33q", "do $$ begin execute 'create type public.ghost as enum (''x'')'; end $$;\n"), "does not read"))
check("nested DO (contiguous) inside an EXECUTE'd literal still refused", lambda: refuses(scratch("t33r", "do $$ begin execute 'do $q$ begin perform 1; execute ''create type public.ghost as enum (''''x'''')''; end $q$'; end $$;\n"), "does not read"))
check("nested dollar-quoted EXECUTE'd command with split DDL refused", lambda: refuses(scratch("t33s", "do $$ begin execute $q$create /*gap*/ type public.ghost as enum ('x')$q$; end $$;\n"), "does not read"))

# --- round thirty-four: public may be neither renamed nor dropped
codex34 = "alter schema public rename to old_public;\ncreate schema public;\n"
d = scratch("u34a", codex34)
check("rename public then recreate: fixed refuses", lambda: refuses(d, "renames or drops"))
check("rename public alone: fixed refuses", lambda: refuses(scratch("u34b", "alter schema public rename to old_public;\n"), "renames or drops"))
scratch('u34c', 'drop schema public cascade;\n')
check("drop schema public cascade: fixed refuses", lambda: refuses(S/"u34c", "renames or drops"))
check("drop schema public (no cascade) refused", lambda: refuses(scratch("u34d", "drop schema public;\n"), "renames or drops"))
check("drop schema if exists public cascade refused", lambda: refuses(scratch("u34e", "drop schema if exists public cascade;\n"), "renames or drops"))
check("drop schema aux, public cascade refused", lambda: refuses(scratch("u34f", "drop schema aux, public cascade;\n"), "renames or drops"))
check("rename \"public\" (quoted) refused", lambda: refuses(scratch("u34g", 'alter schema "public" rename to old_public;\n'), "renames or drops"))
check("rename PUBLIC (upper, folds) refused", lambda: refuses(scratch("u34h", "ALTER SCHEMA PUBLIC RENAME TO old_public;\n"), "renames or drops"))
check("rename \"Public\" (another schema) allowed", lambda: unchanged(scratch("u34i", 'alter schema "Public" rename to other;\n')))
check("rename another schema allowed", lambda: unchanged(scratch("u34j", "create schema aux;\nalter schema aux rename to aux2;\n")))
check("drop another schema allowed", lambda: unchanged(scratch("u34k", "create schema aux;\ndrop schema aux cascade;\n")))
check("dropping another schema creates no shadow", lambda: run(scratch("u34l", "drop schema if exists aux cascade;\ncreate type mood as enum ('x');\n"))[1].get("mood") == ["x"])
check("creating another schema still shadows (round twenty-five)", lambda: refuses(scratch("u34m", "create schema aux;\ncreate type mood as enum ('x');\n"), SHADOW))
check("rename another schema TO public still shadows", lambda: refuses(scratch("u34n", "alter schema aux rename to public;\ncreate type mood as enum ('x');\n"), SHADOW))
check("create schema public still exempt", lambda: run(scratch("u34o", "create schema public;\ncreate type mood as enum ('x');\n"))[1].get("mood") == ["x"])
scratch('u34p', "do $$ begin execute 'drop schema public cascade'; end $$;\n")
check("drop public inside a body: fixed refuses", lambda: refuses(S/"u34p", "does not read"))
check("drop of any schema inside a body refused (body rule)", lambda: refuses(scratch("u34q", "do $$ begin execute 'drop schema aux cascade'; end $$;\n"), "does not read"))
check("rename public inside a body still refused", lambda: refuses(scratch("u34r", "do $$ begin execute 'alter schema public rename to old_public'; end $$;\n"), "does not read"))
check("the words inside a value are inert", lambda: unchanged(scratch("u34s", "select 'drop schema public cascade';\n")))
check("the words inside a comment are inert", lambda: unchanged(scratch("u34t", "-- drop schema public cascade is not done here\nselect 1;\n")))

# --- round thirty-five: a schema name the reader cannot spell is refused, not mistaken
UNREAD = "Unicode-escaped identifier"
codex35a = 'drop schema U&"public" cascade;\n'
d = scratch("y35a", codex35a)
check("drop U&\"public\": fixed refuses as unreadable", lambda: refuses(d, UNREAD))
codex35b = 'alter schema U&"public" rename to old_public;\n'
d = scratch("y35b", codex35b)
check("rename U&\"public\": fixed refuses as unreadable", lambda: refuses(d, UNREAD))
check("drop U&\"\\0070ublic\" (escaped p) refused", lambda: refuses(scratch("y35c", 'drop schema U&"\\0070ublic" cascade;\n'), UNREAD))
check("UESCAPE form refused", lambda: refuses(scratch("y35d", "drop schema U&\"!0070ublic\" uescape '!' cascade;\n"), UNREAD))
check("drop U&\"aux\" refused too (the reader cannot tell which schema)", lambda: refuses(scratch("y35e", 'drop schema U&"aux" cascade;\n'), UNREAD))
check("rename U&\"aux\" refused too", lambda: refuses(scratch("y35f", 'alter schema U&"aux" rename to b;\n'), UNREAD))
check("drop aux, U&\"public\" refused", lambda: refuses(scratch("y35g", 'drop schema aux, U&"public" cascade;\n'), UNREAD))
check("create U&\"public\" then unqualified create: refused as the spelling since round forty", lambda: refuses(scratch("y35h", 'create schema U&"public";\ncreate type mood as enum (\'x\');\n'), "Unicode-escaped identifier"))
check("create U&\"aux\": refused as the spelling since round forty (it was allowed)", lambda: refuses(scratch("y35i", 'create schema U&"aux";\n'), "Unicode-escaped identifier"))
check("plain drop public still refused by the public rule", lambda: refuses(scratch("y35j", "drop schema public cascade;\n"), "renames or drops"))
check("plain rename public still refused by the public rule", lambda: refuses(scratch("y35k", "alter schema public rename to old_public;\n"), "renames or drops"))
check("plain rename of another schema still allowed", lambda: unchanged(scratch("y35l", "create schema aux;\nalter schema aux rename to aux2;\n")))
check("plain drop of another schema still allowed", lambda: unchanged(scratch("y35m", "create schema aux;\ndrop schema aux cascade;\n")))
check("quoted \"Public\" rename still another schema", lambda: unchanged(scratch("y35n", 'alter schema "Public" rename to other;\n')))
check("U&\"public\" drop inside a body refused (the mention rule runs first)", lambda: refuses(scratch("y35o", "do $$ begin execute 'drop schema U&\"public\" cascade'; end $$;\n"), "does not read"))
check("the words inside a value are inert", lambda: unchanged(scratch("y35p", "select 'drop schema U&\"public\" cascade';\n")))

# --- round thirty-six: schema names are read off the skeleton
DQ = chr(34)
codex36a = 'drop schema "tenant,archive" cascade;\n'
d = scratch("w36a", codex36a)
check("drop \"tenant,archive\": fixed allows", lambda: unchanged(d))
codex36b = 'alter schema "tenant rename archive" rename to archived;\n'
d = scratch("w36b", codex36b)
check("rename \"tenant rename archive\": fixed allows", lambda: unchanged(d))
check("rename \"tenant rename archive\" then unqualified create still shadows", lambda: refuses(scratch("w36b2", 'alter schema "tenant rename archive" rename to archived;\ncreate type mood as enum (\'x\');\n'), SHADOW))
check("drop \"public,x\" (another schema) allowed", lambda: unchanged(scratch("w36c", 'drop schema "public,x" cascade;\n')))
check("rename \"x rename public\" allowed", lambda: unchanged(scratch("w36d", 'alter schema "x rename public" rename to y;\n')))
check("drop \"a;b\" still allowed", lambda: unchanged(scratch("w36e", 'drop schema "a;b";\n')))
check("drop \"say \"\"public\"\"\" (doubled quotes) still allowed", lambda: unchanged(scratch("w36f", 'drop schema "say ""public""" cascade;\n')))
check("drop aux, \"tenant,archive\" allowed", lambda: unchanged(scratch("w36g", 'drop schema aux, "tenant,archive" cascade;\n')))
check("drop \"tenant,archive\", public refused by the public rule", lambda: refuses(scratch("w36h", 'drop schema "tenant,archive", public cascade;\n'), "renames or drops"))
check("drop \"public\" still refused", lambda: refuses(scratch("w36i", 'drop schema "public" cascade;\n'), "renames or drops"))
check("rename \"public\" still refused", lambda: refuses(scratch("w36j", 'alter schema "public" rename to old_public;\n'), "renames or drops"))
check("rename PUBLIC (bare, folds) still refused", lambda: refuses(scratch("w36k", "ALTER SCHEMA PUBLIC RENAME TO old_public;\n"), "renames or drops"))
check("rename \"Public\" still another schema", lambda: unchanged(scratch("w36l", 'alter schema "Public" rename to other;\n')))
check("drop U&\"public\" still refused as unreadable", lambda: refuses(scratch("w36m", 'drop schema U&"public" cascade;\n'), "Unicode-escaped identifier"))
check("rename U&\"public\" still refused as unreadable", lambda: refuses(scratch("w36n", 'alter schema U&"public" rename to old_public;\n'), "Unicode-escaped identifier"))
check("drop aux, U&\"x\" still refused as unreadable", lambda: refuses(scratch("w36o", 'drop schema aux, U&"x" cascade;\n'), "Unicode-escaped identifier"))
check("plain rename of another schema still allowed", lambda: unchanged(scratch("w36p", "create schema aux;\nalter schema aux rename to aux2;\n")))
check("plain drop of another schema still allowed and shadow-free", lambda: run(scratch("w36q", "drop schema if exists aux cascade;\ncreate type mood as enum ('x');\n"))[1].get("mood") == ["x"])

# --- round thirty-seven: the drop behaviour is a delimited keyword
codex37 = "drop schema publiccascade;\n"
d = scratch("v37a", codex37)
check("drop publiccascade: fixed allows", lambda: unchanged(d))
check("drop publicrestrict cascade: fixed allows (the shipped reader passed it too — only a glued suffix misreads)", lambda: unchanged(scratch("v37b", "drop schema publicrestrict cascade;\n")))
scratch('v37b2', 'drop schema publicrestrict;\n')
check("drop publicrestrict; fixed allows", lambda: unchanged(S/"v37b2"))
check("drop public cascade still refused", lambda: refuses(scratch("v37c", "drop schema public cascade;\n"), "renames or drops"))
check("drop public restrict still refused", lambda: refuses(scratch("v37d", "drop schema public restrict;\n"), "renames or drops"))
check("drop public (no behaviour) still refused", lambda: refuses(scratch("v37e", "drop schema public;\n"), "renames or drops"))
check("DROP SCHEMA PUBLIC CASCADE (upper) still refused", lambda: refuses(scratch("v37f", "DROP SCHEMA PUBLIC CASCADE;\n"), "renames or drops"))
check("drop aux, public cascade still refused", lambda: refuses(scratch("v37g", "drop schema aux, public cascade;\n"), "renames or drops"))
check("drop \"public\" cascade still refused", lambda: refuses(scratch("v37h", 'drop schema "public" cascade;\n'), "renames or drops"))
check("drop cascade (a schema named cascade) allowed", lambda: unchanged(scratch("v37i", "drop schema cascade;\n")))
check("drop publiccascade then unqualified create still catalogued (no shadow from a drop)", lambda: run(scratch("v37j", "drop schema publiccascade;\ncreate type mood as enum ('x');\n"))[1].get("mood") == ["x"])

# --- round thirty-eight: an escape-string routine body is refused, not read
ESC = "escape string"
codex38 = "DO U&'begin execute ''create type public.ghost as enum (''''x'''')''; end';\n"
d = scratch("e38a", codex38)
check("DO U&'…' body with DDL: fixed refuses by name", lambda: refuses(d, ESC))
d = scratch("e38b", "DO E'begin execute ''\\x63reate type public.ghost2 as enum (''''y'''')''; end';\n")
check("DO E'…' body with \\x63reate: fixed refuses by name", lambda: refuses(d, ESC))
check("DO U&'…' body with \\0063reate refused", lambda: refuses(scratch("e38c", "DO U&'begin execute ''\\0063reate type public.ghost3 as enum (''''z'''')''; end';\n"), ESC))
scratch('e38d', "create function f38() returns void language plpgsql as U&'begin execute ''create type public.ghost4 as enum (''''w'''')''; end';\n")
check("function AS U&'…' body: fixed refuses", lambda: refuses(S/"e38d", ESC))
check("function AS E'…' body refused (even inert)", lambda: refuses(scratch("e38e", "create function f38() returns int language sql as E'select 1';\n"), ESC))
check("DO E'…' inert body refused too (the form, not the content)", lambda: refuses(scratch("e38f", "DO E'begin perform 1; end';\n"), ESC))
check("DO LANGUAGE plpgsql U&'…' refused", lambda: refuses(scratch("e38g", "do language plpgsql U&'begin perform 1; end';\n"), ESC))
check("DO E'…' with plain DDL still refused", lambda: refuses(scratch("e38h", "DO E'begin execute ''create type public.ghost as enum (''''x'''')''; end';\n"), "does not read"))
check("U&'…' as a value is still data", lambda: unchanged(scratch("e38i", "select U&'create type ghost';\n")))
check("E'…' as a value is still data", lambda: unchanged(scratch("e38j", "select E'create type ghost';\n")))
check("U&'…' value inside a dollar body is data", lambda: unchanged(scratch("e38k", "do $$ begin perform length(U&'\\0063reate type'); end $$;\n")))
check("EXECUTE of a U&'…' command inside a body refused as unreadable", lambda: refuses(scratch("e38l", "do $$ begin execute U&'select 1'; end $$;\n"), "does not read"))
check("EXECUTE of an E'…' command inside a body refused as unreadable", lambda: refuses(scratch("e38m", "do $$ begin execute E'select 1'; end $$;\n"), "does not read"))
check("a schema named u followed by &? no — `u&` is only a prefix at a token boundary: xu&'…' is not one", lambda: unchanged(scratch("e38n", "select 1 as xu&'a';\n")))
check("plain dollar DO still fine", lambda: unchanged(scratch("e38o", "do $$ begin perform 1; end $$;\n")))
check("plain single-quoted DO body with DDL still refused", lambda: refuses(scratch("e38p", "DO 'BEGIN EXECUTE ''CREATE TYPE mood AS ENUM (''''x'''')''; END';\n"), "does not read"))

# --- round thirty-nine: a setting name spelled U&"…" is refused, not passed
UN = "Unicode-escaped identifier"
codex39 = 'set U&"standard_conforming_strings" = off;\ncreate type mood as enum (\'line\\nfeed\');\n'
d = scratch("h39a", codex39)
check("set U&\"standard_conforming_strings\" = off: fixed refuses by name", lambda: refuses(d, UN))
d = scratch("h39b", 'alter role deploy set U&"search_path" = private;\n')
check("alter role … set U&\"search_path\": fixed refuses", lambda: refuses(d, UN))
check("set U&\"search_path\" = private refused", lambda: refuses(scratch("h39c", 'set U&"search_path" = private;\n'), UN))
check("set U&\"role\" = x refused", lambda: refuses(scratch("h39d", 'set U&"role" = authenticated;\n'), UN))
check("set U&\"session_authorization\" = x refused", lambda: refuses(scratch("h39e", 'set U&"session_authorization" = authenticated;\n'), UN))
check("set local U&\"search_path\" refused", lambda: refuses(scratch("h39f", 'set local U&"search_path" = private;\n'), UN))
check("SET U&\"…\" upper-case refused", lambda: refuses(scratch("h39g", 'SET U&"SEARCH_PATH" = private;\n'), UN))
check("set U&\"work_mem\" refused too (the reader cannot tell which setting)", lambda: refuses(scratch("h39h", 'set U&"work_mem" = \'64MB\';\n'), UN))
check("alter database … set U&\"work_mem\" refused too", lambda: refuses(scratch("h39i", 'alter database postgres set U&"work_mem" = \'64MB\';\n'), UN))
check("reset U&\"search_path\": refused as the spelling since round forty (it was allowed)", lambda: refuses(scratch("h39j", 'reset U&"search_path";\n'), "Unicode-escaped identifier"))
check("alter role … reset U&\"search_path\": refused as the spelling since round forty (it was allowed)", lambda: refuses(scratch("h39k", 'alter role deploy reset U&"search_path";\n'), "Unicode-escaped identifier"))
check("set \"search_path\" = private still refused by the path rule", lambda: refuses(scratch("h39l", 'set "search_path" = private;\n'), "moves search_path"))
check("set \"work_mem\" allowed", lambda: unchanged(scratch("h39m", 'set "work_mem" = \'64MB\';\n')))
check("alter role … set \"work_mem\" allowed", lambda: unchanged(scratch("h39n", 'alter role deploy set "work_mem" = \'64MB\';\n')))
check("set search_path = U&\"public\" refused as the spelling", lambda: refuses(scratch("h39o", 'set search_path = U&"public";\n'), "Unicode-escaped identifier"))
check("set_config(U&'search_path') still refused", lambda: refuses(scratch("h39p", "select set_config(U&'search_path', 'private', false);\n"), "moves search_path"))
check("a body carrying U&\"search_path\" refused (the mention rule runs first)", lambda: refuses(scratch("h39q", 'do $$ begin execute \'set U&"search_path" = private\'; end $$;\n'), "does not read"))
check("the words inside a value are inert", lambda: unchanged(scratch("h39r", 'select \'set U&"search_path" = private\';\n')))
# --- round forty: a U&"…" identifier is refused wherever the generator reads code
UI = "Unicode-escaped identifier"
k1 = 'do $$ begin set U&"' + BS + '0073earch_path" = auth, public; end $$;\ncreate type mood as enum (\'x\');\n'
d = scratch("k40a", k1)
check("body: set U&\"\\0073earch_path\": fixed refuses as the spelling", lambda: refuses(d, UI))
k2 = 'select U&"' + BS + '0073et_config"(\'search_path\', \'auth, public\', false);\ncreate type mood as enum (\'x\');\n'
d = scratch("k40b", k2)
check("top level: U&\"\\0073et_config\"(…): fixed refuses", lambda: refuses(d, UI))
k3 = 'do $$ begin perform U&"' + BS + '0073et_config"(U&\'' + BS + '0073earch_path\', \'auth, public\', false); end $$;\ncreate type mood as enum (\'x\');\n'
d = scratch("k40c", k3)
check("body: U&\"\\0073et_config\"(U&'\\0073earch_path', …): fixed refuses as the spelling", lambda: refuses(d, UI))
d = scratch("k40c2", 'do $$ begin perform U&"' + BS + '0073et_config"(\'search_path\', \'auth, public\', false); end $$;\n')
check("… and fixed still refuses it", lambda: refuses(d, "does not read"))
check("execute of a dollar string carrying U&\"…\" refused", lambda: refuses(scratch("k40d", 'do $$ begin execute $q$set U&"' + BS + '0073earch_path" = auth$q$; end $$;\n'), UI))
check("an alias spelled U&\"x\" refused (stated: any name)", lambda: refuses(scratch("k40e", 'select 1 as U&"x";\n'), UI))
check("lower-case u&\"x\" refused", lambda: refuses(scratch("k40f", 'select u&"x";\n'), UI))
check("U&\"…\" inside a string is text", lambda: unchanged(scratch("k40g", 'select \'U&"x"\';\n')))
check("U&\"…\" inside a dollar-quoted value is text", lambda: unchanged(scratch("k40h", 'comment on type payment_status is $doc$see U&"x"$doc$;\n')))
check("U&\"…\" inside a body's dollar-quoted prose is text", lambda: unchanged(scratch("k40i", 'do $$ begin perform length($msg$see U&"x"$msg$); end $$;\n')))
check("U&\"…\" inside a line comment is text", lambda: unchanged(scratch("k40j", '-- see U&"x"\nselect 1;\n')))
check("U&\"…\" inside a block comment is text", lambda: unchanged(scratch("k40k", '/* see U&"x" */ select 1;\n')))
check("xu&\"col\" is `xu & \"col\"`, not a U& identifier (token boundary)", lambda: unchanged(scratch("k40l", 'select xu&"col" from job_runs;\n')))
check("u2&\"col\" likewise", lambda: unchanged(scratch("k40m", 'select u2&"col" from job_runs;\n')))
check("(u&\"col\") IS a U& identifier (the lexer's longest match) and is refused", lambda: refuses(scratch("k40n", 'select (u&"col") from job_runs;\n'), UI))
check("the schema reader's unreadable branch is still reachable for a non-token spelling", lambda: refuses(scratch("k40o", 'alter schema a b rename to c;\n'), "schema name this generator cannot read"))
check("U&'…' string as a set_config name still refused by the plain-literal rule (not new)", lambda: refuses(scratch("k40p", "select set_config(U&'" + BS + "0073earch_path', 'auth, public', false);\n"), "moves search_path"))
check("U&'…' data value still allowed", lambda: unchanged(scratch("k40q", "insert into job_runs(job) values (U&'" + BS + "00e9');\n")))
check("the round-38 E'…' body is still refused as an escape string", lambda: refuses(scratch("k40r", "do E'begin perform 1; end';\n"), "escape string"))
# --- round forty-one: a doubled quote inside a quoted set_config qualifier
ROLE = "switches the current role"
n1 = 'select "evil""pg_catalog".set_config(\'role\', \'authenticated\', false);\n'
d = scratch("n41a", n1)
check("top level: \"evil\"\"pg_catalog\".set_config: fixed passes, catalogue unchanged", lambda: unchanged(d))
n2 = 'do $$ begin perform "evil""pg_catalog".set_config(\'role\', \'authenticated\', false); end $$;\n'
d = scratch("n41b", n2)
check("body: \"evil\"\"pg_catalog\".set_config: fixed passes", lambda: unchanged(d))
check("execute'd literal calling \"evil\"\"pg_catalog\".set_config passes", lambda: unchanged(scratch("n41c", 'do $$ begin execute \'select "evil""pg_catalog".set_config(\'\'role\'\', \'\'authenticated\'\', false)\'; end $$;\n')))
check("\"pg_catalog\".set_config('role', …) still refused", lambda: refuses(scratch("n41d", 'select "pg_catalog".set_config(\'role\', \'authenticated\', false);\n'), ROLE))
check("\"pg_catalog\".\"set_config\"('role', …) still refused", lambda: refuses(scratch("n41e", 'select "pg_catalog"."set_config"(\'role\', \'authenticated\', false);\n'), ROLE))
check("execute'd literal calling \"pg_catalog\".set_config still refused", lambda: refuses(scratch("n41f", 'do $$ begin execute \'select "pg_catalog".set_config(\'\'role\'\', \'\'authenticated\'\', false)\'; end $$;\n'), "does not read"))
check("bare pg_catalog.set_config('role', …) still refused", lambda: refuses(scratch("n41g", 'select pg_catalog.set_config(\'role\', \'authenticated\', false);\n'), ROLE))
check("bare PG_CATALOG.set_config folds and is still refused", lambda: refuses(scratch("n41h", 'select PG_CATALOG.set_config(\'role\', \'authenticated\', false);\n'), ROLE))
check("\"PG_CATALOG\".set_config is another schema (quoted keeps its case) and passes", lambda: unchanged(scratch("n41i", 'select "PG_CATALOG".set_config(\'role\', \'authenticated\', false);\n')))
check("\"evil\".set_config still passes", lambda: unchanged(scratch("n41j", 'select "evil".set_config(\'role\', \'authenticated\', false);\n')))
check("a qualifier ending in a doubled quote (\"evil\"\"\") passes", lambda: unchanged(scratch("n41k", 'select "evil""".set_config(\'role\', \'authenticated\', false);\n')))
check("a qualifier beginning with a doubled quote (\"\"\"pg_catalog\") is not pg_catalog and passes", lambda: unchanged(scratch("n41l", 'select """pg_catalog".set_config(\'role\', \'authenticated\', false);\n')))
check("two doubled pairs (\"a\"\"b\"\"c\") passes", lambda: unchanged(scratch("n41m", 'select "a""b""c".set_config(\'role\', \'authenticated\', false);\n')))
check("unqualified set_config('role', …) still refused", lambda: refuses(scratch("n41n", 'select set_config(\'role\', \'authenticated\', false);\n'), ROLE))
# --- round forty-two: the E'…' prefix uses the lexer's identifier boundary
r1 = "create domain foo$e as text;\nselect foo$e'x" + BS + "';\ncreate type public.ghost as enum ('x');\n"
d = scratch("r42a", r1)
check("foo$e'x\\' then create ghost: fixed catalogues ghost", lambda: run(d)[1].get("ghost") == ["x"])
r2 = "create domain \"foo€e\" as text;\nselect foo€e'x" + BS + "';\ncreate type public.ghost as enum ('x');\n"
d = scratch("r42b", r2)
check("foo€e'x\\' then create ghost: fixed catalogues ghost", lambda: run(d)[1].get("ghost") == ["x"])
check("fooe'x\\' (a letter before e) was never an E string: ghost catalogued", lambda: run(scratch("r42c", "create domain fooe as text;\nselect fooe'x" + BS + "';\ncreate type public.ghost as enum ('x');\n"))[1].get("ghost") == ["x"])
check("_e'x\\' likewise", lambda: run(scratch("r42d", "create domain _e as text;\nselect _e'x" + BS + "';\ncreate type public.ghost as enum ('x');\n"))[1].get("ghost") == ["x"])
check("a real E string with an escaped quote still ends where PostgreSQL ends it", lambda: run(scratch("r42e", "select e'x" + BS + "'y';\ncreate type public.ghost as enum ('x');\n"))[1].get("ghost") == ["x"])
check("(e'x\\'y') — E after a parenthesis — likewise", lambda: run(scratch("r42f", "select (e'x" + BS + "'y');\ncreate type public.ghost as enum ('x');\n"))[1].get("ghost") == ["x"])
check("upper-case E'…' likewise", lambda: run(scratch("r42g", "select E'x" + BS + "'y';\ncreate type public.ghost as enum ('x');\n"))[1].get("ghost") == ["x"])
check("DDL inside a real E string stays a value (catalogue unchanged)", lambda: unchanged(scratch("r42h", "select E'x" + BS + "'; create type public.ghost as enum (''x'')';\n")))
check("body: foo$e'x\\' then an EXECUTE'd create is still refused (the body rule)", lambda: refuses(scratch("r42i", "create domain foo$e as text;\ndo $$ begin perform foo$e'x" + BS + "'; execute 'create type public.ghost as enum (''x'')'; end $$;\n"), "does not read"))
check("a $e$ dollar tag is still a dollar quote, not an E string", lambda: unchanged(scratch("r42j", "comment on type payment_status is $e$has 'quotes' and a " + BS + " in it$e$;\n")))
# --- round forty-three: the ALTER reader parses the head before the clause
SP = "moves search_path"; ROLE43 = "switches the current role"; SCS = "standard_conforming_strings off"
d = scratch("t43a", "alter role set set search_path = private;\n")
check("alter role set set search_path: fixed refuses", lambda: refuses(d, SP))
d = scratch("t43b", "alter database set set search_path = private;\n")
check("alter database set set search_path: fixed refuses", lambda: refuses(d, SP))
d = scratch("t43c", "alter role set in database d set role = authenticated;\n")
check("alter role set in database d set role: fixed refuses", lambda: refuses(d, ROLE43))
d = scratch("t43d", "alter role set set standard_conforming_strings = off;\n")
check("alter role set set standard_conforming_strings = off: fixed refuses", lambda: refuses(d, SCS))
check("alter user set set search_path refused", lambda: refuses(scratch("t43e", "alter user set set search_path = private;\n"), SP))
check("alter role set reset search_path (a reset) allowed", lambda: unchanged(scratch("t43f", "alter role set reset search_path;\n")))
check("alter role set set search_path to default (a reset) allowed", lambda: unchanged(scratch("t43g", "alter role set set search_path to default;\n")))
check("alter role set set work_mem allowed", lambda: unchanged(scratch("t43h", "alter role set set work_mem = '4MB';\n")))
check("alter role reset set search_path still refused (by design now, not first-match)", lambda: refuses(scratch("t43i", "alter role reset set search_path = private;\n"), SP))
check("alter role reset reset search_path allowed", lambda: unchanged(scratch("t43j", "alter role reset reset search_path;\n")))
check("alter role \"set\" set search_path still refused", lambda: refuses(scratch("t43k", 'alter role "set" set search_path = private;\n'), SP))
check("alter role \"reset\" reset search_path allowed", lambda: unchanged(scratch("t43l", 'alter role "reset" reset search_path;\n')))
check("in database d set search_path still refused", lambda: refuses(scratch("t43m", "alter role deploy in database d set search_path = private;\n"), SP))
check("in database \"d\" set search_path refused", lambda: refuses(scratch("t43n", 'alter role deploy in database "d" set search_path = private;\n'), SP))
check("in database d reset search_path allowed", lambda: unchanged(scratch("t43o", "alter role deploy in database d reset search_path;\n")))
check("in database d set search_path to default allowed", lambda: unchanged(scratch("t43p", "alter role deploy in database d set search_path to default;\n")))
check("alter role deploy set search_path still refused (control)", lambda: refuses(scratch("t43q", "alter role deploy set search_path = private;\n"), SP))
check("alter role deploy set search_path from current still refused", lambda: refuses(scratch("t43r", "alter role deploy set search_path from current;\n"), SP))
check("alter role all set search_path refused", lambda: refuses(scratch("t43s", "alter role all set search_path = private;\n"), SP))
check("alter role current_user set search_path refused", lambda: refuses(scratch("t43t", "alter role current_user set search_path = private;\n"), SP))
check("alter system set search_path still refused", lambda: refuses(scratch("t43u", "alter system set search_path = private;\n"), SP))
check("alter system reset all allowed", lambda: unchanged(scratch("t43v", "alter system reset all;\n")))
check("alter database x owner to y allowed", lambda: unchanged(scratch("t43w", "alter database x owner to y;\n")))
check("alter user mapping for x server y options (…) allowed", lambda: unchanged(scratch("t43x", "alter user mapping for deploy server remote options (add user 'set');\n")))
check("alter role set with password '…' allowed (the target is `set`, the clause is WITH)", lambda: unchanged(scratch("t43y", "alter role set with password 'set search_path = private';\n")))
check("alter role deploy with password containing the phrase allowed", lambda: unchanged(scratch("t43z", "alter role deploy with password 'set search_path = private';\n")))
check("an ALTER whose target cannot be read is refused by name", lambda: refuses(scratch("t43aa", "alter role 'set' set search_path = private;\n"), "target this generator cannot read"))
check("ALTER ROLE upper-case, role named SET, refused", lambda: refuses(scratch("t43ab", "ALTER ROLE SET SET SEARCH_PATH = private;\n"), SP))
check("alter role set set \"search_path\" (quoted setting) refused", lambda: refuses(scratch("t43ac", 'alter role set set "search_path" = private;\n'), SP))
check("alter role set set search_path.custom = 'v' (a custom setting) allowed", lambda: unchanged(scratch("t43ad", "alter role set set search_path.custom = 'v';\n")))

TMP.cleanup()
failed = [n for n, ok in checks if not ok]
for n, ok in checks:
    print(("ok   " if ok else "FAIL ") + n)
print(f"{len(checks) - len(failed)} of {len(checks)} enum-catalogue proofs hold")
sys.exit(1 if failed else 0)
