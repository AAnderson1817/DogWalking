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
itself proven to change nothing. Each probe is written as `0052_probe.sql`
(and `0053_probe.sql` for two-file cases) into its own named copy of the
migrations under a temporary directory, since a later check may refer back
to an earlier copy by name.
Refusals are captured in-process (stderr + SystemExit), so a run of the
whole set takes about a minute.
"""
from __future__ import annotations

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
NEW = str(GENERATOR)
BS = chr(92)
DQ = chr(34)
Q = chr(39)


def load(path):
    spec = importlib.util.spec_from_file_location("gen", path)
    g = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(g)
    return g


gen = load(GENERATOR)
committed = re.search(re.escape(gen.BEGIN) + r".*?" + re.escape(gen.END), gen.SPEC.read_text(), re.S).group(0)

TMP = tempfile.TemporaryDirectory(prefix="enum-proofs-")
S = pathlib.Path(TMP.name)  # every named scratch copy lives here, and a check may refer back to one by name


def run(d, path=None):
    """(rendered block, values, creation order) for the migrations in `d`,
    or (None, {}, []) when the generator refused. `path` is accepted for
    call-site compatibility with the scratchpad harness; the generator is
    always this tree's."""
    gen.MIGRATIONS = pathlib.Path(d)
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        try:
            v, t, o = gen.collect()
        except SystemExit:
            return None, {}, []
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


def scratch(name, sql):
    """A named copy of the real migrations with `sql` as its 0052 probe. Named,
    because a later check may refer back to it (`S / name`)."""
    d = S / name
    shutil.rmtree(d, ignore_errors=True)
    shutil.copytree(MIGRATIONS, d)
    (d / "0052_probe.sql").write_text(sql)
    return d


def scratch_edit(name, filename, old, new):
    """A named copy of the real migrations with one file edited."""
    d = S / name
    shutil.rmtree(d, ignore_errors=True)
    shutil.copytree(MIGRATIONS, d)
    p = d / filename
    text = p.read_text()
    assert text.count(old) == 1, (filename, old)
    p.write_text(text.replace(old, new))
    return d


def unchanged(d):
    return run(d)[0] == committed


checks = []
# The control, uncached: the real tree renders the committed block.
checks.append(("control byte-identical (uncached)", run(MIGRATIONS)[0] == committed))
# Memoise the pure lexer so the 51 real files are parsed once; the control is
# repeated below under the cache so the cache is proven to change nothing.
gen.strip_sql = functools.lru_cache(maxsize=None)(gen.strip_sql)
checks.append(("control byte-identical (cached)", run(MIGRATIONS)[0] == committed))
d = scratch("s1", "select 'drop type payment_status;';\n")
checks.append(("DDL in a string value: fixed leaves the catalogue unchanged", run(d)[0] == committed))
d = scratch("s2", "alter type payment_status add value 'awaiting;review';\n")
checks.append(("semicolon in a label: fixed reads it", "awaiting;review" in run(d)[1].get("payment_status", [])))
checks.append(("punctuation in create labels read correctly", run(scratch("s3", "create type t as enum ('a;b', 'c)d', 'e--f');\n"))[1].get("t") == ["a;b", "c)d", "e--f"]))
checks.append(("string value naming a type does not alter it", run(scratch("s5", "insert into job_runs(job) values ('alter type payment_status add value ''ghost''');\n"))[0] == committed))
d = scratch("r1", "comment on type payment_status is $doc$create type ghost as enum ('x');$doc$;\n"); checks.append(("dollar-quoted DDL refused", refuses(d, "dollar-quoted")))
checks.append(("dollar-quoted prose fine", run(scratch("r2", "comment on type payment_status is $doc$the payment lifecycle; it's fine$doc$;\n"))[0] == committed))
checks.append(("DO body with a comment mentioning alter type is fine", run(scratch("r3", "do $$ begin\n  -- alter type payment_status add value 'ghost' would be wrong here\n  perform 1;\nend $$;\n"))[0] == committed))
checks.append(("$word$ inside a $$ value is text", run(scratch("r4", "comment on type payment_status is $$has a $sign$ inside$$;\n"))[0] == committed))
checks.append(("DO body with real DDL refused", refuses(scratch("r5b", "do $$ begin alter type payment_status add value 'ghost'; end $$;\n"), "dollar-quoted")))
checks.append(("comment between tokens catalogued", run(scratch("r6", "CREATE/*gap*/TYPE ghost AS ENUM ('x');\n"))[1].get("ghost") == ["x"]))
checks.append(("nested comment stripped", "ghost" not in run(scratch("q1", "/* outer /* inner */ create type ghost as enum ('x'); */\n"))[2]))
checks.append(("E'' label refused", refuses(scratch("q2", "create type t as enum (E'can" + BS + "'t', 'b');\n"))))
checks.append(("dollar-quoted label refused", refuses(scratch("q3", "create type t as enum ($$a$$, 'b');\n"))))
checks.append(("trailing comma tolerated", run(scratch("q5", "create type t as enum ('a', 'b',);\n"))[1].get("t") == ["a", "b"]))
checks.append(("escaped quote in a label survives", "it's" in run(scratch("p1", "alter type payment_status add value 'it''s';\n"))[1]["payment_status"]))
checks.append(("label with -- survives", "client--reminder" in run(scratch("p3", "alter type notification_type add value 'client--reminder';\n"))[1]["notification_type"]))
checks.append(("quoted create refused", refuses(scratch("p4", 'CREATE TYPE public."delivery_status" AS ENUM (' + "'queued');\n"))))
checks.append(("quoted alter refused", refuses(scratch("p5", 'alter type "payment_status" add value ' + "'x';\n"))))
checks.append(("unreadable drop refused", refuses(scratch("p6", "drop type payment_status cascade restrict;\n"))))
checks.append(("unknown alter refused", refuses(scratch("p7", "alter type payment_status rename to payment_state;\n"), "neither")))
checks.append(("comments stripped, real kept", (lambda v: "ghost" not in v and "ghost2" not in v and "real" in v)(run(scratch("p8", "-- Codex's note: alter type payment_status add value 'ghost';\n/* it's /* nested */ still a comment: alter type payment_status add value 'ghost2'; */\nalter type payment_status add value 'real';\n"))[1]["payment_status"])))
checks.append(("cascade drop removes", "payment_status" not in run(scratch("p9", "drop type payment_status cascade;\n"))[2]))
checks.append(("drop-then-create keeps", "mood" in run(scratch("p10", "drop type if exists mood;\ncreate type mood as enum ('happy');\n"))[2]))
checks.append(("before anchor", [l for l in run(scratch("p11", "create type mood as enum ('happy');\nalter type mood add value 'tired' before 'happy';\n"))[0].splitlines() if l.startswith("- `mood`")][0].endswith("`tired` · `happy`")))
checks.append(("dropped-`disputed` sabotage red", run(scratch_edit("mig-sab1", "0022_reversal_enums.sql", "alter type payment_status add value if not exists 'disputed';", ""))[0] != committed))
DQ = chr(34)
# --- round seven, finding 1: quoted identifiers masked in the skeleton
d = scratch("t1", "select 1 as " + DQ + "drop type payment_status;" + DQ + ";\n")
checks.append(("DDL in a quoted identifier: fixed leaves the catalogue unchanged", run(d)[0] == committed))
d = scratch("t2", "select 1 as " + DQ + "say " + DQ + DQ + "drop type payment_status;" + DQ + DQ + " now" + DQ + ";\n")
checks.append(("doubled quote inside an identifier is content, catalogue unchanged", run(d)[0] == committed))
d = scratch("t3", "comment on column clients." + DQ + "odd;name" + DQ + " is 'x';\nalter type payment_status add value 'real2';\n")
checks.append(("semicolon inside an identifier does not swallow the next statement", "real2" in run(d)[1]["payment_status"]))
# --- round seven, finding 2: whitespace inside labels preserved
d = scratch("t4", "alter type payment_status add value 'needs  review';\n")
checks.append(("double space in a label: fixed records two", "needs  review" in run(d)[1]["payment_status"] and "needs review" not in run(d)[1]["payment_status"]))
d = scratch("t5", "create type mood as enum ('a', 'needs  review');\nalter type mood add value 'z' before 'needs  review';\n")
checks.append(("anchor with a double space: fixed places before it", run(d)[1]["mood"] == ["a", "z", "needs  review"]))
d = scratch("t6", "create type mood as enum ('needs  review');\nalter type mood rename value 'needs  review' to 'nr';\n")
checks.append(("rename of a double-spaced label: fixed renames", run(d)[1]["mood"] == ["nr"]))
checks.append(("trailing whitespace before the terminator still reads", "tw" in run(scratch("t7", "alter type payment_status add value 'tw'   ;\n"))[1]["payment_status"]))
checks.append(("multi-line alter still reads", "ml" in run(scratch("t8", "alter type payment_status\n  add value\n  'ml'\n;\n"))[1]["payment_status"]))
checks.append(("padded label preserved", "  padded " in run(scratch("t10", "alter type payment_status add value '  padded ';\n"))[1]["payment_status"]))
checks.append(("unknown alter still refused by name", refuses(scratch("t11", "alter type payment_status\n   rename   to payment_state;\n"), "neither")))
Q = chr(39); DQ = chr(34)
def unchanged(d): return run(d)[0] == committed
# --- round eight, finding 1: search_path
d = scratch("u1", "set search_path = private, public;\ncreate type payment_status as enum ('z');\n")
checks.append(("search_path then unqualified create: fixed refuses naming search_path", refuses(d, "moves search_path")))
d = scratch("u2", "set search_path = private, public;\ncreate type mood as enum ('x');\n")
checks.append(("search_path then new type: fixed refuses", refuses(d, "moves search_path")))
checks.append(("search_path = public is allowed and the create is read", run(scratch("u3", "set search_path = public;\ncreate type mood as enum ('x');\n"))[1].get("mood") == ["x"]))
checks.append(("set local … to public, extensions allowed", unchanged(scratch("u4", "set local search_path to public, extensions;\n"))))
checks.append(("reset search_path allowed", unchanged(scratch("u5", "reset search_path;\n"))))
checks.append(("set_config to private refused", refuses(scratch("u6", "select set_config('search_path', 'private', false);\n"), "moves search_path")))
checks.append(("set_config public-first allowed", unchanged(scratch("u7", "select set_config('search_path', 'public, private', false);\n"))))
checks.append(("alter database … search_path refused", refuses(scratch("u8", "alter database postgres set search_path = private;\n"), "moves search_path")))
checks.append(("alter role … search_path refused", refuses(scratch("u9", "alter role postgres set search_path to private;\n"), "moves search_path")))
checks.append(("quoted value refused", refuses(scratch("u10", "set search_path = 'private';\n"), "moves search_path")))
checks.append(("$user first refused", refuses(scratch("u10b", "SET SEARCH_PATH TO " + DQ + "$user" + DQ + ", public;\n"), "moves search_path")))
checks.append(("set_config inside a DO body refused", refuses(scratch("u11", "do $$ begin perform set_config('search_path', 'private', false); end $$;\n"), "does not read")))
checks.append(("function clause set search_path = public is not a statement (control)", unchanged(scratch("u12", "create function probe_f() returns int language sql security definer set search_path = public as $$ select 1 $$;\n"))))
# --- round eight, finding 2: executable single-quoted bodies
codex = "DO 'BEGIN EXECUTE ''CREATE TYPE mood AS ENUM (''''x'''')''; END';\n"
d = scratch("v1", codex)
checks.append(("single-quoted DO body with EXECUTE DDL: fixed refuses", refuses(d, "does not read")))
d = scratch("v2", "do $$ begin execute 'create type mood as enum (''x'')'; end $$;\n")
checks.append(("dollar-quoted DO body with EXECUTE DDL: fixed refuses", refuses(d, "does not read")))
checks.append(("inert single-quoted DO body allowed", unchanged(scratch("v3", "do 'begin perform 1; end';\n"))))
checks.append(("DO LANGUAGE … 'execute drop type' refused", refuses(scratch("v4", "DO LANGUAGE plpgsql 'begin execute ''drop type payment_status''; end';\n"), "does not read")))
checks.append(("prose naming DDL inside a DO body is refused now (round-six decision reversed)", refuses(scratch("v5", "do $$ begin raise notice 'create type is not allowed here'; end $$;\n"), "does not read")))
checks.append(("bare DDL inside a dollar-quoted function body refused", refuses(scratch("v7", "create function probe_f() returns void language plpgsql as $$ begin create type mood as enum ('x'); end $$;\n"), "does not read")))
checks.append(("bare DDL inside a single-quoted function body refused", refuses(scratch("v8", "create function probe_f() returns void language plpgsql as 'begin create type mood as enum (''x''); end';\n"), "does not read")))
e_body = "do E'begin execute " + BS + Q + "create type mood as enum (" + BS + Q + BS + Q + "x" + BS + Q + BS + Q + ")" + BS + Q + "; end';\n"
checks.append(("E'' DO body with EXECUTE DDL refused", refuses(scratch("v10", e_body), "does not read")))
checks.append(("inert value naming DDL in an insert still allowed", unchanged(scratch("v11", "insert into job_runs(job) values ('alter type payment_status add value ''ghost''');\n"))))
checks.append(("DO after a comment still recognised as DO", refuses(scratch("v12", "-- setup\ndo $$ begin execute 'alter type payment_status add value ''ghost'''; end $$;\n"), "does not read")))
checks.append(("DO as a later statement recognised", refuses(scratch("v13", "select 1;\n" + codex), "does not read")))
checks.append(("`;` inside an earlier literal does not shift statement boundaries", unchanged(scratch("v14", "select 'a;b';\ndo 'begin perform 1; end';\n"))))
checks.append(("`;` inside an earlier literal does not hide a DO", refuses(scratch("v15", "select 'a;b';\n" + codex), "does not read")))
d = scratch("w1", "set schema 'private';\ncreate type mood as enum ('happy');\n")
checks.append(("set schema then unqualified create: fixed refuses naming search_path", refuses(d, "moves search_path")))
d = scratch("w2", "set schema 'private';\ncreate type payment_status as enum ('z');\n")
checks.append(("set schema over an existing enum: fixed refuses", refuses(d, "moves search_path")))
checks.append(("set schema 'public' allowed and the create is read", run(scratch("w3", "set schema 'public';\ncreate type mood as enum ('x');\n"))[1].get("mood") == ["x"]))
checks.append(("SET LOCAL SCHEMA refused", refuses(scratch("w4", "SET LOCAL SCHEMA 'private';\n"), "moves search_path")))
checks.append(("set schema unquoted refused", refuses(scratch("w5", "set schema private;\n"), "moves search_path")))
checks.append(("alter table … set schema is a move, not a search_path change (allowed)", unchanged(scratch("w6", "alter table clients set schema private;\n"))))
checks.append(("set search_path still refused after the regex widened", refuses(scratch("w7", "set search_path = private, public;\n"), "moves search_path")))
checks.append(("set search_path = public still allowed after the regex widened", unchanged(scratch("w8", "set search_path = public;\n"))))
codex10 = "select set_config('search_path', concat('private', ',public'), false);\ncreate type mood as enum ('happy');\n"
d = scratch("x1", codex10)
checks.append(("computed set_config value: fixed refuses naming search_path", refuses(d, "moves search_path")))
checks.append(("|| concatenation refused", refuses(scratch("x2", "select set_config('search_path', 'private' || ',public', false);\n"), "moves search_path")))
checks.append(("function-valued refused", refuses(scratch("x3", "select set_config('search_path', current_setting('x'), false);\n"), "moves search_path")))
checks.append(("computed GUC name refused", refuses(scratch("x4", "select set_config(concat('search', '_path'), 'private', false);\n"), "moves search_path")))
checks.append(("literal public-first value still allowed", unchanged(scratch("x5", "select set_config('search_path', 'public, private', false);\n"))))
checks.append(("literal private value still refused", refuses(scratch("x6", "select set_config('search_path', 'private', false);\n"), "moves search_path")))
checks.append(("unrelated GUC with a computed value allowed", unchanged(scratch("x7", "select set_config('sanpo.flag', concat('a', 'b'), false);\n"))))
checks.append(("schema-qualified pg_catalog.set_config refused", refuses(scratch("x8", "select pg_catalog.set_config('search_path', 'private', false);\n"), "moves search_path")))
checks.append(("upper-case GUC name refused", refuses(scratch("x9", "select set_config('SEARCH_PATH', 'private', false);\n"), "moves search_path")))
checks.append(("second call in one statement refused", refuses(scratch("x10", "select set_config('search_path', 'public', false), set_config('search_path', 'private', false);\n"), "moves search_path")))
checks.append(("E'' value refused as unreadable", refuses(scratch("x11", "select set_config('search_path', E'public', false);\n"), "moves search_path")))
checks.append(("set_config inside a function body is not a top-level call (control)", unchanged(scratch("x12", "create function probe_f() returns void language plpgsql as $$ begin perform set_config('sanpo.x', sqlerrm, false); end $$;\n"))))
d = scratch("y1", "select 'set_config(foo)';\n")
checks.append(("inert literal naming set_config: fixed leaves the catalogue unchanged", unchanged(d)))
checks.append(("inert value holding a whole set_config call allowed", unchanged(scratch("y2", "insert into job_runs(job) values ('select set_config(''search_path'', ''private'', false)');\n"))))
codex11 = "SELECT pg_catalog." + DQ + "set_config" + DQ + "('search_path', 'private', false);\nCREATE TYPE mood AS ENUM ('x');\n"
d = scratch("y3", codex11)
checks.append(("quoted set_config call: fixed refuses naming search_path", refuses(d, "moves search_path")))
checks.append(("unqualified quoted call refused", refuses(scratch("y4", "select " + DQ + "set_config" + DQ + "('search_path', 'private', false);\n"), "moves search_path")))
checks.append(("upper-case quoted call refused (conservative)", refuses(scratch("y5", "select " + DQ + "SET_CONFIG" + DQ + "('search_path', 'private', false);\n"), "moves search_path")))
checks.append(("some other quoted function with those arguments allowed", unchanged(scratch("y6", "select " + DQ + "my_fn" + DQ + "('search_path', 'private', false);\n"))))
checks.append(("quoted public-first call allowed", unchanged(scratch("y7", "select " + DQ + "set_config" + DQ + "('search_path', 'public, private', false);\n"))))
checks.append(("set quoted search_path refused", refuses(scratch("y8", "set " + DQ + "search_path" + DQ + " = private;\n"), "moves search_path")))
checks.append(("set quoted search_path to public allowed", unchanged(scratch("y9", "set " + DQ + "search_path" + DQ + " to public;\n"))))
checks.append(("alter role with search_path only inside a literal allowed", unchanged(scratch("y10", "alter role postgres set app.note = 'search_path';\n"))))
checks.append(("alter role quoted search_path refused", refuses(scratch("y11", "alter role postgres set " + DQ + "search_path" + DQ + " = private;\n"), "moves search_path")))
checks.append(("computed value still refused after moving to the skeleton", refuses(scratch("y12", codex10), "moves search_path")))
codex12 = "create function mk() returns void language plpgsql as $$ begin execute 'create type public.mood as enum (''x'')'; end $$;\nselect mk();\n"
d = scratch("z1", codex12)
checks.append(("function with EXECUTE DDL then called: fixed refuses at definition", refuses(d, "does not read")))
checks.append(("same function wired to a trigger refused", refuses(scratch("z2", "create function mk() returns trigger language plpgsql as $$ begin execute 'alter type payment_status add value ''ghost'''; return new; end $$;\ncreate trigger t after insert on job_runs for each row execute function mk();\n"), "does not read")))
checks.append(("single-quoted function body with EXECUTE DDL refused", refuses(scratch("z3", "create function mk() returns void language plpgsql as 'begin execute ''create type public.mood as enum (''''x'''')''; end';\n"), "does not read")))
checks.append(("function body touching search_path refused", refuses(scratch("z4", "create function mk() returns void language plpgsql as $$ begin perform set_config('search_path', 'private', false); end $$;\n"), "does not read")))
checks.append(("prose naming DDL inside a function body is refused now (round-eight allowance reversed)", refuses(scratch("z5", "create function probe_f() returns void language plpgsql as $$ begin raise notice 'create type is not allowed here'; end $$;\n"), "does not read")))
checks.append(("procedure body with EXECUTE DDL refused", refuses(scratch("z6", "create procedure mk() language plpgsql as $$ begin execute 'drop type payment_status'; end $$;\ncall mk();\n"), "does not read")))
checks.append(("ordinary function body allowed", unchanged(scratch("z7", "create function probe_f() returns int language sql security definer set search_path = public as $$ select count(*)::int from job_runs $$;\nselect probe_f();\n"))))
checks.append(("COMMENT ON value with prose still allowed", unchanged(scratch("z8", "comment on type payment_status is $doc$the lifecycle; nothing here creates a type$doc$;\n"))))
checks.append(("COMMENT ON value with bare DDL still refused", refuses(scratch("z9", "comment on type payment_status is $doc$create type ghost as enum ('x');$doc$;\n"), "does not read")))
# --- round thirteen, finding 1: EOF as a terminator
d = scratch("e1", "create type mood as enum ('x')")
checks.append(("final create with no semicolon: fixed catalogues it", run(d)[1].get("mood") == ["x"]))
checks.append(("final create, trailing whitespace, no semicolon", run(scratch("e2", "create type mood as enum ('x')  \n\n"))[1].get("mood") == ["x"]))
checks.append(("final alter with no semicolon read", "eofv" in run(scratch("e3", "alter type payment_status add value 'eofv'"))[1]["payment_status"]))
checks.append(("final drop with no semicolon applied", "payment_status" not in run(scratch("e4", "drop type payment_status"))[2]))
checks.append(("trailing comment after the last semicolon unchanged", unchanged(scratch("e5", "select 1;\n-- done\n"))))
checks.append(("comment-only file unchanged", unchanged(scratch("e6", "-- nothing here\n"))))
checks.append(("final unterminated DO with DDL refused", refuses(scratch("e7", "do $$ begin execute 'create type mood as enum (''x'')'; end $$"), "does not read")))
# --- round thirteen, finding 2: EXECUTE must be readable
codex13 = "do $$ begin execute 'create ' || 'type public.mood as enum (''x'')'; end $$;\n"
d = scratch("f1", codex13)
checks.append(("concatenated EXECUTE: fixed refuses", refuses(d, "cannot read")))
checks.append(("concat() EXECUTE refused", refuses(scratch("f2", "do $$ begin execute concat('create ', 'type mood as enum (''x'')'); end $$;\n"), "cannot read")))
checks.append(("variable EXECUTE refused", refuses(scratch("f3", "do $$ declare v text := 'select 1'; begin execute v; end $$;\n"), "cannot read")))
checks.append(("concatenated EXECUTE in a function body refused", refuses(scratch("f4", "create function mk() returns void language plpgsql as $$ begin execute 'cre' || 'ate type mood as enum (''x'')'; end $$;\n"), "cannot read")))
checks.append(("format() with a literal template allowed (0004 pattern)", unchanged(scratch("f5", "do $$ declare t text; begin for t in select 'clients' loop execute format('alter table %I enable row level security', t); end loop; end $$;\n"))))
checks.append(("plain literal EXECUTE allowed (0028 pattern)", unchanged(scratch("f6", "do $$ begin execute 'create extension if not exists pg_cron'; exception when others then null; end $$;\n"))))
checks.append(("EXECUTE … INTO with a literal allowed", unchanged(scratch("f7", "do $$ declare n int; begin execute 'select 1' into n; end $$;\n"))))
checks.append(("EXECUTE … USING with a literal allowed", unchanged(scratch("f8", "do $$ declare n int; begin execute 'select $1' into n using 1; end $$;\n"))))
checks.append(("grant execute on inside a DO is not an EXECUTE", unchanged(scratch("f9", "do $$ begin grant execute on function fn_job_health() to service_role; end $$;\n"))))
checks.append(("create trigger … execute function inside a DO is not an EXECUTE", unchanged(scratch("f10", "do $$ begin create trigger probe_t after insert on job_runs for each row execute function fn_touch_updated_at(); end $$;\n"))))
checks.append(("the word execute inside a string is not an EXECUTE", unchanged(scratch("f11", "do $$ begin raise notice 'grant execute fn_unsubscribe_by_token'; end $$;\n"))))
checks.append(("format() with a computed template refused", refuses(scratch("f12", "do $$ declare t text := 'select 1'; begin execute format(t); end $$;\n"), "cannot read")))
def line_for(d, name):
    return [l for l in run(d)[0].splitlines() if l.startswith("- `" + name + "`")][0]
# --- round fourteen, finding 1: nested dollar strings inside a body
codex14a = "create function probe_f() returns int language plpgsql as $$ begin perform length($msg$please execute this later$msg$); return 1; end $$;\n"
d = scratch("n1", codex14a)
checks.append(("nested $msg$ prose naming execute: fixed leaves the catalogue unchanged", unchanged(d)))
checks.append(("same inside a DO body allowed", unchanged(scratch("n2", "do $$ begin perform length($msg$please execute this later$msg$); end $$;\n"))))
checks.append(("EXECUTE of a nested dollar string carrying DDL still refused", refuses(scratch("n3", "do $$ begin execute $q$create type mood as enum ('x')$q$; end $$;\n"), "does not read")))
checks.append(("EXECUTE of a nested dollar string that is inert allowed", unchanged(scratch("n4", "do $$ begin execute $q$select 1$q$; end $$;\n"))))
checks.append(("EXECUTE of a nested dollar string concatenated refused", refuses(scratch("n5", "do $$ begin execute $q$select 1$q$ || 'x'; end $$;\n"), "cannot read")))
checks.append(("unterminated nested dollar tag in a body refused", refuses(scratch("n6", "do $$ begin perform length($m$oops); end $$;\n"), "does not read")))
checks.append(("$body$-quoted body with a nested $$ literal allowed", unchanged(scratch("n8", "do $body$ begin perform length($$inner execute$$); end $body$;\n"))))
checks.append(("nested dollar string naming search_path refused (body clean text)", refuses(scratch("n9", "do $$ begin perform length($m$search_path$m$); end $$;\n"), "does not read")))
# --- round fourteen, finding 2: labels as code spans
d = scratch("m1", "create type t as enum ('two · labels', 'b');\n")
checks.append(("label containing the separator: fixed renders one code span", line_for(d, "t").endswith("`two · labels` · `b`")))
checks.append(("label with a backtick gets a longer fence", line_for(scratch("m2", "create type t as enum ('a`b');\n"), "t").endswith("``a`b``")))
checks.append(("label with a newline refused", refuses(scratch("m3", "create type t as enum ('a\nb');\n"), "control character")))
checks.append(("padded label keeps its spaces through CommonMark stripping", line_for(scratch("m4", "create type t as enum ('  padded ');\n"), "t").endswith("`   padded  `")))
checks.append(("label shaped like a list item stays one value", line_for(scratch("m5", "create type t as enum ('- x', 'y');\n"), "t").endswith("`- x` · `y`")))
checks.append(("label starting with a backtick padded", line_for(scratch("m6", "create type t as enum ('`x');\n"), "t").endswith("`` `x ``")))
# --- round fifteen, finding 1: quoted schema identity
d = scratch("q1", "set search_path = " + DQ + "PUBLIC" + DQ + ", public;\ncreate type mood as enum ('x');\n")
checks.append(("quoted PUBLIC schema: fixed refuses naming search_path", refuses(d, "moves search_path")))
checks.append(("quoted lowercase public allowed", unchanged(scratch("q2", "set search_path = " + DQ + "public" + DQ + ";\n"))))
checks.append(("unquoted mixed-case Public folds and is allowed", unchanged(scratch("q3", "set search_path = Public;\n"))))
checks.append(("single-quoted string holding unquoted PUBLIC folds and is allowed", unchanged(scratch("q4", "set search_path = 'PUBLIC';\n"))))
checks.append(("single-quoted string holding a quoted PUBLIC refused", refuses(scratch("q5", "set search_path = '" + DQ + "PUBLIC" + DQ + "';\n"), "moves search_path")))
checks.append(("set_config with a quoted PUBLIC first refused", refuses(scratch("q6", "select set_config('search_path', '" + DQ + "PUBLIC" + DQ + ", public', false);\n"), "moves search_path")))
checks.append(("set schema with a quoted PUBLIC refused", refuses(scratch("q7", "set schema '" + DQ + "PUBLIC" + DQ + "';\n"), "moves search_path")))
checks.append(("set_config public-first literal still allowed", unchanged(scratch("q8", "select set_config('search_path', 'public, private', false);\n"))))
# --- round fifteen, finding 2: all-whitespace labels
d = scratch("w1", "create type t as enum (' ', 'b');\n")
checks.append(("one-space label: fixed refuses", refuses(d, "only whitespace")))
checks.append(("three-space label refused", refuses(scratch("w2", "create type t as enum ('   ');\n"), "only whitespace")))
checks.append(("empty label refused", refuses(scratch("w3", "create type t as enum ('');\n"), "only whitespace")))
checks.append(("interior space label still rendered", line_for(scratch("w4", "create type t as enum ('a b');\n"), "t").endswith("`a b`")))
# --- round fifteen, finding 3: dollar tag inside an identifier
codex15 = "select 1 as first$tag$;\ncreate type mood as enum ('x');\nselect 1 as second$tag$;\n"
d = scratch("d1", codex15)
checks.append(("$tag$ inside two aliases: fixed catalogues the enum", run(d)[1].get("mood") == ["x"]))
checks.append(("$$ inside two aliases likewise", run(scratch("d2", "select 1 as a$$;\ncreate type mood as enum ('x');\nselect 1 as b$$;\n"))[1].get("mood") == ["x"]))
checks.append(("a real dollar quote after whitespace still opens (DDL inside refused)", refuses(scratch("d4", "select 1 as x$tag$;\ndo $tag$ begin execute 'create type mood as enum (''x'')'; end $tag$;\n"), "does not read")))
checks.append(("a dollar quote after an open paren still opens (its DDL is refused, proving the region was read)", refuses(scratch("d5", "select length($q$abc create type$q$);\n"), "does not read")))
checks.append(("a dollar quote after an open paren with inert contents allowed", unchanged(scratch("d5b", "select length($q$abc execute$q$);\n"))))
checks.append(("a dollar quote at file start still opens", refuses(scratch("d6", "$doc$create type ghost as enum ('x');$doc$;\n"), "does not read")))

# --- round sixteen, finding 2: an empty enum body is legal SQL
d = scratch("e1", "create type phase as enum ();\n")
checks.append(("empty enum: fixed catalogues it with no values", run(d)[1].get("phase") == []))
checks.append(("empty enum renders (no values)", line_for(d, "phase").endswith("): (no values)")))
checks.append(("empty enum counted in the header", run(d)[0].splitlines()[2].startswith("16 enum types")))
checks.append(("empty then add value populates", run(scratch("e2", "create type phase as enum ();\nalter type phase add value 'x';\n"))[1].get("phase") == ["x"]))
checks.append(("empty then add value renders the value", line_for(scratch("e2", "create type phase as enum ();\nalter type phase add value 'x';\n"), "phase").endswith("`x`")))
checks.append(("whitespace-only body accepted", run(scratch("e3", "create type phase as enum (  \n );\n"))[1].get("phase") == []))
checks.append(("bare comma body refused", refuses(scratch("e4", "create type phase as enum (,);\n"))))
checks.append(("empty label still refused", refuses(scratch("e5", "create type phase as enum ('');\n"), "only whitespace")))
checks.append(("empty enum then drop leaves the catalogue unchanged", run(scratch("e6", "create type phase as enum ();\ndrop type phase;\n"))[0] == committed))

# --- round seventeen: standard_conforming_strings
BSN = chr(92) + "n"
SCS = "standard_conforming_strings"
d = scratch("c1", "set standard_conforming_strings = off;\ncreate type mood as enum ('line" + BSN + "feed');\n")
checks.append(("scs off: fixed refuses naming the setting", refuses(d, SCS)))
checks.append(("set local … to off refused", refuses(scratch("c2", "set local standard_conforming_strings to off;\n"), SCS)))
checks.append(("set session … = false refused", refuses(scratch("c3", "set session standard_conforming_strings = false;\n"), SCS)))
checks.append(("= 0 refused", refuses(scratch("c4", "set standard_conforming_strings = 0;\n"), SCS)))
checks.append(("= 'no' refused", refuses(scratch("c5", "set standard_conforming_strings = 'no';\n"), SCS)))
checks.append(("quoted identifier form refused", refuses(scratch("c6", 'set "standard_conforming_strings" = off;\n'), SCS)))
checks.append(("= on allowed", unchanged(scratch("c7", "set standard_conforming_strings = on;\n"))))
checks.append(("= 'ON' allowed", unchanged(scratch("c8", "set standard_conforming_strings = 'ON';\n"))))
checks.append(("to true allowed", unchanged(scratch("c9", "set local standard_conforming_strings to true;\n"))))
checks.append(("to default allowed", unchanged(scratch("c10", "set standard_conforming_strings to default;\n"))))
checks.append(("reset allowed", unchanged(scratch("c11", "reset standard_conforming_strings;\n"))))
checks.append(("set_config off refused", refuses(scratch("c12", "select set_config('standard_conforming_strings', 'off', false);\n"), SCS)))
checks.append(("set_config on allowed", unchanged(scratch("c13", "select set_config('standard_conforming_strings', 'on', true);\n"))))
checks.append(("set_config computed value refused", refuses(scratch("c14", "select set_config('standard_conforming_strings', lower('OFF'), false);\n"), SCS)))
checks.append(("alter database … refused", refuses(scratch("c15", "alter database postgres set standard_conforming_strings = off;\n"), SCS)))
checks.append(("alter role … refused", refuses(scratch("c16", "alter role postgres set standard_conforming_strings = off;\n"), SCS)))
checks.append(("alter system … search_path refused too", refuses(scratch("c16b", "alter system set search_path = private;\n"), "moves search_path")))
checks.append(("DO body turning it off refused", refuses(scratch("c17", "do $$ begin set standard_conforming_strings = off; end $$;\n"), "does not read")))
checks.append(("body EXECUTE turning it off refused", refuses(scratch("c18", "do $$ begin execute 'set standard_conforming_strings = off'; end $$;\n"), "does not read")))
checks.append(("the words inside a value are inert", unchanged(scratch("c19", "select 'set standard_conforming_strings = off';\n"))))
checks.append(("the words inside a comment are inert", unchanged(scratch("c20", "-- set standard_conforming_strings = off\ncomment on type payment_status is 'standard_conforming_strings';\n"))))
checks.append(("search_path guard still works", refuses(scratch("c21", "set search_path = private, public;\n"), "moves search_path")))
checks.append(("set_config computed NAME still refused", refuses(scratch("c22", "select set_config(lower('SEARCH_PATH'), 'private', false);\n"), "moves search_path")))

# --- round nineteen: the bare DEFAULT keyword is a reset
d = scratch("f1", "set search_path to default;\ncreate type mood as enum ('x');\n")
checks.append(("search_path TO DEFAULT: fixed reads the create after it", run(d)[1].get("mood") == ["x"]))
checks.append(("search_path = DEFAULT allowed", unchanged(scratch("f2", "set search_path = DEFAULT;\n"))))
checks.append(("set local search_path to default allowed", unchanged(scratch("f3", "set local search_path to default;\n"))))
checks.append(("quoted literal 'default' is a schema: refused", refuses(scratch("f4", "set search_path = 'default';\n"), "moves search_path")))
checks.append(("quoted identifier default is a schema: refused", refuses(scratch("f5", 'set search_path = "default";\n'), "moves search_path")))
checks.append(("set_config search_path 'default' is a schema: refused", refuses(scratch("f6", "select set_config('search_path', 'default', false);\n"), "moves search_path")))
checks.append(("scs TO DEFAULT still allowed", unchanged(scratch("f7", "set standard_conforming_strings to default;\n"))))
d8 = scratch("f8", "set standard_conforming_strings = 'default';\n")
checks.append(("scs = 'default': fixed refuses", refuses(d8, "standard_conforming_strings")))
checks.append(("default then private still refused", refuses(scratch("f9", "set search_path to default;\nset search_path = private;\n"), "moves search_path")))
checks.append(("reset all allowed", unchanged(scratch("f10", "reset all;\n"))))

# --- round twenty: ALTER ROLE/DATABASE reset forms
d = scratch("g1", "alter role postgres set search_path to default;\n")
checks.append(("alter role … set search_path to default: fixed allows", unchanged(d)))
checks.append(("alter role … reset search_path allowed", unchanged(scratch("g2", "alter role postgres reset search_path;\n"))))
checks.append(("alter database … reset search_path allowed", unchanged(scratch("g3", "alter database postgres reset search_path;\n"))))
checks.append(("alter role … in database … = DEFAULT allowed", unchanged(scratch("g4", "alter role postgres in database postgres set search_path = DEFAULT;\n"))))
checks.append(("alter role … reset all allowed", unchanged(scratch("g5", "alter role postgres reset all;\n"))))
checks.append(("alter system reset search_path allowed", unchanged(scratch("g6", "alter system reset search_path;\n"))))
checks.append(("alter role … set search_path = private still refused", refuses(scratch("g7", "alter role postgres set search_path = private;\n"), "moves search_path")))
checks.append(("alter role … set search_path from current refused", refuses(scratch("g8", "alter role postgres set search_path from current;\n"), "moves search_path")))
checks.append(("alter role … set search_path = 'a, default' refused (a value)", refuses(scratch("g9", "alter role postgres set search_path = 'a, default';\n"), "moves search_path")))
checks.append(("alter role … set scs to default allowed", unchanged(scratch("g10", "alter role postgres set standard_conforming_strings to default;\n"))))
checks.append(("alter role … reset scs allowed", unchanged(scratch("g11", "alter role postgres reset standard_conforming_strings;\n"))))
checks.append(("alter role … set scs = off still refused", refuses(scratch("g12", "alter role postgres set standard_conforming_strings = off;\n"), "standard_conforming_strings")))
checks.append(("alter system set search_path = private still refused", refuses(scratch("g13", "alter system set search_path = private;\n"), "moves search_path")))

# --- round twenty-one: the current role decides where an unqualified type lands
ROLE = "switches the current role"
codex21 = "create schema authorization authenticated;\nset role authenticated;\ncreate type mood as enum ('happy');\n"
d = scratch("h1", codex21)
checks.append(("set role then unqualified create: fixed refuses naming the role switch", refuses(d, ROLE)))
checks.append(("set local role refused", refuses(scratch("h2", "set local role authenticated;\n"), ROLE)))
checks.append(("set session role refused", refuses(scratch("h3", "set session role authenticated;\n"), ROLE)))
checks.append(("set role none allowed", unchanged(scratch("h4", "set role none;\n"))))
checks.append(("reset role allowed", unchanged(scratch("h5", "reset role;\n"))))
checks.append(("set session authorization refused", refuses(scratch("h6", "set session authorization authenticated;\n"), ROLE)))
checks.append(("set local session authorization default allowed", unchanged(scratch("h7", "set local session authorization default;\n"))))
checks.append(("reset session authorization allowed", unchanged(scratch("h8", "reset session authorization;\n"))))
checks.append(("set_config role refused", refuses(scratch("h9", "select set_config('role', 'authenticated', true);\n"), ROLE)))
checks.append(("set_config role none allowed", unchanged(scratch("h10", "select set_config('role', 'none', true);\n"))))
checks.append(("set_config session_authorization refused", refuses(scratch("h11", "select set_config('session_authorization', 'postgres', false);\n"), ROLE)))
checks.append(("alter role … set role = x refused", refuses(scratch("h12", "alter role postgres set role = authenticated;\n"), ROLE)))
checks.append(("alter role … set session_authorization refused", refuses(scratch("h13", "alter role postgres set session_authorization = authenticated;\n"), ROLE)))
checks.append(("alter role … reset role allowed", unchanged(scratch("h14", "alter role postgres reset role;\n"))))
checks.append(("alter role … set role to default allowed", unchanged(scratch("h15", "alter role postgres set role to default;\n"))))
checks.append(("alter role … set work_mem allowed (the word role in ALTER ROLE is not a switch)", unchanged(scratch("h16", "alter role postgres set work_mem = '1MB';\n"))))
checks.append(("alter role … set quoted search_path still refused", refuses(scratch("h17", 'alter role postgres set "search_path" = private;\n'), "moves search_path")))
checks.append(("alter role … set search_path from current still refused", refuses(scratch("h18", "alter role postgres set search_path from current;\n"), "moves search_path")))
checks.append(("DO body switching role refused", refuses(scratch("h19", "do $$ begin set local role authenticated; end $$;\n"), "does not read")))
checks.append(("the words inside a value are inert", unchanged(scratch("h20", "select 'set role authenticated';\n"))))
checks.append(("session authorization inside a comment value is inert", unchanged(scratch("h21", "comment on type payment_status is 'session authorization';\n"))))
checks.append(("a body calling auth.role() is fine", unchanged(scratch("h22", "create function probe_role() returns text language sql as $$ select auth.role() $$;\n"))))
checks.append(("a qualified create after set role is still refused (rule is on the switch)", refuses(scratch("h23", "set role authenticated;\ncreate type public.mood as enum ('happy');\n"), ROLE)))

# --- round twenty-two: the generic GUC forms of role and session_authorization
DQ = chr(34)
d = scratch("i1", "set " + DQ + "role" + DQ + " = authenticated;\ncreate type mood as enum ('happy');\n")
checks.append(("set \"role\" = x then create: fixed refuses", refuses(d, ROLE)))
d2 = scratch("i2", "set session_authorization = authenticated;\ncreate type mood as enum ('happy');\n")
checks.append(("set session_authorization = x: fixed refuses", refuses(d2, ROLE)))
checks.append(("set role = x refused", refuses(scratch("i3", "set role = authenticated;\n"), ROLE)))
checks.append(("set role to x refused", refuses(scratch("i4", "set role to authenticated;\n"), ROLE)))
checks.append(("set \"role\" to 'x' refused", refuses(scratch("i5", "set " + DQ + "role" + DQ + " to 'authenticated';\n"), ROLE)))
checks.append(("set \"session_authorization\" to x refused", refuses(scratch("i6", "set " + DQ + "session_authorization" + DQ + " to authenticated;\n"), ROLE)))
checks.append(("set session_authorization to 'x' refused", refuses(scratch("i7", "set session_authorization to 'postgres';\n"), ROLE)))
checks.append(("set role = 'none' allowed", unchanged(scratch("i8", "set role = 'none';\n"))))
checks.append(("set role to default allowed", unchanged(scratch("i9", "set role to default;\n"))))
checks.append(("set \"role\" = none allowed", unchanged(scratch("i10", "set " + DQ + "role" + DQ + " = none;\n"))))
checks.append(("set session_authorization = default allowed", unchanged(scratch("i11", "set session_authorization = default;\n"))))
checks.append(("body set \"role\" = x refused", refuses(scratch("i12", "do $$ begin set " + DQ + "role" + DQ + " = authenticated; end $$;\n"), "does not read")))
checks.append(("body set session_authorization refused", refuses(scratch("i13", "do $$ begin set session_authorization = authenticated; end $$;\n"), "does not read")))
checks.append(("the generic form inside a value is inert", unchanged(scratch("i14", "select 'set " + DQ + "role" + DQ + " = authenticated';\n"))))
checks.append(("a column named role in a body is fine", unchanged(scratch("i15", "create function probe_r() returns text language sql as $$ select role from pg_roles_view $$;\n"))))

# --- round twenty-three: set_config inside a procedural body
codex23 = "do $$ begin perform set_config('role', 'authenticated', false); end $$;\ncreate type mood as enum ('happy');\n"
d = scratch("j1", codex23)
checks.append(("body set_config(role) then create: fixed refuses", refuses(d, "does not read")))
checks.append(("body set_config(role, none) refused too (a body is not a value)", refuses(scratch("j2", "do $$ begin perform set_config('role', 'none', false); end $$;\n"), "does not read")))
checks.append(("body set_config(session_authorization) refused", refuses(scratch("j3", "do $$ begin perform set_config('session_authorization', 'postgres', false); end $$;\n"), "does not read")))
checks.append(("body set_config(standard_conforming_strings) refused", refuses(scratch("j4", "do $$ begin perform set_config('standard_conforming_strings', 'off', false); end $$;\n"), "does not read")))
checks.append(("body set_config(search_path) refused", refuses(scratch("j5", "do $$ begin perform set_config('search_path', 'private', false); end $$;\n"), "does not read")))
checks.append(("body EXECUTE of a set_config(role) literal refused", refuses(scratch("j6", "do $$ begin execute 'select set_config(''role'', ''authenticated'', false)'; end $$;\n"), "does not read")))
checks.append(("body format() template with %L name refused as unreadable", refuses(scratch("j7", "do $$ begin execute format('select set_config(%L, %L, false)', 'role', 'x'); end $$;\n"), "does not read")))
checks.append(("body set_config with a variable name refused as unreadable", refuses(scratch("j8", "do $$ declare v text := 'role'; begin perform set_config(v, 'x', false); end $$;\n"), "does not read")))
checks.append(("body set_config of an unguarded literal allowed", unchanged(scratch("j9", "do $$ begin perform set_config('work_mem', '1MB', true); end $$;\n"))))
checks.append(("function body set_config(role) refused", refuses(scratch("j10", "create function probe_sc() returns void language plpgsql as $$ begin perform set_config('role', 'authenticated', false); end $$;\n"), "does not read")))
checks.append(("top-level value naming set_config(role) is inert", unchanged(scratch("j11", "select 'set_config(''role'', ''x'', false)';\n"))))
checks.append(("body quoted \"set_config\"(role) refused", refuses(scratch("j12", 'do $$ begin perform "set_config"(' + "'role', 'authenticated', false); end $$;\n"), "does not read")))

# --- round twenty-four: the name must be the entire first argument
codex24 = "do $$ begin perform set_config('ro' || 'le', 'authenticated', false); end $$;\ncreate type mood as enum ('happy');\n"
d = scratch("k1", codex24)
checks.append(("body concat name then create: fixed refuses", refuses(d, "does not read")))
d2 = scratch("k2", "select set_config('ro' || 'le', 'authenticated', false);\ncreate type mood as enum ('happy');\n")
checks.append(("top-level concat name: fixed refuses", refuses(d2, "moves search_path")))
checks.append(("body 'search' || '_path' refused", refuses(scratch("k3", "do $$ begin perform set_config('search' || '_path', 'private', false); end $$;\n"), "does not read")))
checks.append(("body cast name refused as unreadable", refuses(scratch("k4", "do $$ begin perform set_config('role'::text, 'x', false); end $$;\n"), "does not read")))
checks.append(("body E'' name refused as unreadable", refuses(scratch("k5", "do $$ begin perform set_config(E'role', 'x', false); end $$;\n"), "does not read")))
checks.append(("body unguarded literal with spaces allowed", unchanged(scratch("k6", "do $$ begin perform set_config( 'work_mem' , '1MB', true); end $$;\n"))))
checks.append(("top-level unguarded concat refused (a computed name could be any setting)", refuses(scratch("k7", "select set_config('work_mem' || '', '1MB', true);\n"), "moves search_path")))
checks.append(("top-level unguarded literal still allowed", unchanged(scratch("k8", "select set_config('work_mem', '1MB', true);\n"))))
checks.append(("body EXECUTE'd doubled-quote guarded name still refused", refuses(scratch("k9", "do $$ begin execute 'select set_config(''role'', ''x'', false)'; end $$;\n"), "does not read")))

# --- round twenty-five: a created or renamed schema may be "$user"
SHADOW = "may be the current user's"
def scratch2(name, sql52, sql53):
    d = scratch(name, sql52); (d/"0053_probe2.sql").write_text(sql53); return d
codex25 = "create schema authorization current_user;\ncreate type mood as enum ('happy');\n"
d = scratch("l1", codex25)
checks.append(("schema authorization current_user then create: fixed refuses, naming the qualification", refuses(d, SHADOW)))
checks.append(("qualified create after the schema is read", run(scratch("l2", "create schema authorization current_user;\ncreate type public.mood as enum ('happy');\n"))[1].get("mood") == ["happy"]))
checks.append(("any created schema counts (the role is unknowable): private then unqualified refused", refuses(scratch("l3", "create schema private;\ncreate type mood as enum ('happy');\n"), SHADOW)))
checks.append(("create schema public itself is exempt", run(scratch("l4", "create schema if not exists public;\ncreate type mood as enum ('happy');\n"))[1].get("mood") == ["happy"]))
checks.append(("unqualified alter after a schema refused", refuses(scratch("l5", "create schema postgres;\nalter type payment_status add value 'x';\n"), SHADOW)))
checks.append(("qualified alter after a schema applied", "x" in run(scratch("l6", "create schema postgres;\nalter type public.payment_status add value 'x';\n"))[1]["payment_status"]))
checks.append(("unqualified drop after a schema refused", refuses(scratch("l7", "create schema postgres;\ndrop type payment_status;\n"), SHADOW)))
checks.append(("qualified drop after a schema applied", "payment_status" not in run(scratch("l8", "create schema postgres;\ndrop type public.payment_status cascade;\n"))[2]))
checks.append(("the rule persists into later files", refuses(scratch2("l9", "create schema private;\n", "create type mood as enum ('happy');\n"), SHADOW)))
checks.append(("a rename to the role name counts", refuses(scratch("l10", "create schema private;\nalter schema private rename to postgres;\ncreate type mood as enum ('happy');\n"), SHADOW)))
checks.append(("enum DDL before the schema is unaffected", run(scratch("l11", "create type mood as enum ('happy');\ncreate schema private;\n"))[1].get("mood") == ["happy"]))
checks.append(("a body creating a schema refused", refuses(scratch("l12", "do $$ begin execute 'create schema authorization current_user'; end $$;\n"), "does not read")))
checks.append(("the words inside a value are inert", unchanged(scratch("l13", "select 'create schema authorization current_user';\n"))))

# --- round twenty-six: the public exemption must read the whole identifier
DQ = chr(34)
d = scratch("m1", "create schema public$deploy;\ncreate type mood as enum ('happy');\n")
checks.append(("create schema public$deploy then create: fixed refuses", refuses(d, SHADOW)))
checks.append(("create schema public_x counts", refuses(scratch("m2", "create schema public_x;\ncreate type mood as enum ('happy');\n"), SHADOW)))
checks.append(("create schema publicx counts", refuses(scratch("m3", "create schema publicx;\ncreate type mood as enum ('happy');\n"), SHADOW)))
checks.append(("create schema \"Public\" counts (a different schema)", refuses(scratch("m4", "create schema " + DQ + "Public" + DQ + ";\ncreate type mood as enum ('happy');\n"), SHADOW)))
checks.append(("create schema \"public\" is exempt", run(scratch("m5", "create schema " + DQ + "public" + DQ + ";\ncreate type mood as enum ('happy');\n"))[1].get("mood") == ["happy"]))
checks.append(("create schema public authorization x is exempt (the name is public)", run(scratch("m6", "create schema public authorization postgres;\ncreate type mood as enum ('happy');\n"))[1].get("mood") == ["happy"]))
checks.append(("create schema public; still exempt", run(scratch("m7", "create schema public;\ncreate type mood as enum ('happy');\n"))[1].get("mood") == ["happy"]))
checks.append(("create schema \"PUBLIC\" counts (quoted names are exact)", refuses(scratch("m8", "create schema " + DQ + "PUBLIC" + DQ + ";\ncreate type mood as enum ('happy');\n"), SHADOW)))
checks.append(("CREATE SCHEMA PUBLIC (unquoted, upper) is exempt", run(scratch("m9", "CREATE SCHEMA PUBLIC;\ncreate type mood as enum ('happy');\n"))[1].get("mood") == ["happy"]))

# --- round twenty-seven: non-ASCII identifier characters
d = scratch("n1", "create schema publicé;\ncreate type mood as enum ('happy');\n")
checks.append(("create schema publicé then create: fixed refuses", refuses(d, SHADOW)))
checks.append(("create schema public€ counts", refuses(scratch("n2", "create schema public€;\ncreate type mood as enum ('happy');\n"), SHADOW)))
checks.append(("create schema public; still exempt after the widening", run(scratch("n3", "create schema public;\ncreate type mood as enum ('happy');\n"))[1].get("mood") == ["happy"]))
checks.append(("create schema public authorization x still exempt", run(scratch("n4", "create schema public authorization postgres;\ncreate type mood as enum ('happy');\n"))[1].get("mood") == ["happy"]))

# --- round twenty-eight: SQL-standard routine bodies
codex28 = "create procedure later() language sql begin atomic create type ghost as enum ('x'); end;\n"
d = scratch("o1", codex28)
checks.append(("begin atomic with enum DDL: fixed refuses by name", refuses(d, "BEGIN ATOMIC")))
checks.append(("begin atomic without enum DDL refused too (the rule is on the form)", refuses(scratch("o2", "create function two() returns int language sql begin atomic select 2; end;\n"), "BEGIN ATOMIC")))
checks.append(("BEGIN ATOMIC upper-case refused", refuses(scratch("o3", "CREATE PROCEDURE later() LANGUAGE SQL BEGIN ATOMIC SELECT 1; END;\n"), "BEGIN ATOMIC")))
checks.append(("dollar-quoted procedure body with DDL still refused as a body", refuses(scratch("o4", "create procedure later() language sql as $$ create type ghost as enum ('x'); $$;\n"), "does not read")))
checks.append(("the RETURN form of a SQL body is allowed", unchanged(scratch("o5", "create function one() returns int language sql return 1;\n"))))
checks.append(("the words inside a value are inert", unchanged(scratch("o6", "select 'begin atomic';\n"))))
checks.append(("the words inside a comment are inert", unchanged(scratch("o7", "-- begin atomic is not used here\nselect 1;\n"))))

# --- round twenty-nine: non-ASCII dollar-quote tags
codex29 = "do $é$ begin execute 'create ' || 'type public.ghost as enum (''x'')'; end $é$;\n"
d = scratch("p1", codex29)
checks.append(("$é$ body with a concatenated EXECUTE: fixed refuses as unreadable", refuses(d, "does not read")))
checks.append(("$é$ value carrying DDL refused", refuses(scratch("p2", "comment on type payment_status is $é$create type ghost as enum ('x')$é$;\n"), "does not read")))
checks.append(("$日本$ body with inert content allowed", unchanged(scratch("p3", "do $日本$ begin perform 1; end $日本$;\n"))))
checks.append(("$日本$ plain value allowed", unchanged(scratch("p4", "select $日本$plain value$日本$;\n"))))
checks.append(("$é$ body with a plain-literal EXECUTE of DDL refused", refuses(scratch("p5", "do $é$ begin execute 'create type public.ghost as enum (''x'')'; end $é$;\n"), "does not read")))
checks.append(("an identifier ending in $é$ is not a tag", unchanged(scratch("p6", "select 1 as a$é$;\nselect 2 as b$é$;\n"))))
checks.append(("ASCII tags still work", refuses(scratch("p7", "do $q$ begin execute 'create type public.ghost as enum (''x'')'; end $q$;\n"), "does not read")))

# --- round thirty A: every non-ASCII predecessor continues an identifier
codex30a = "select 1 as first€$tag$;\ncreate type mood as enum ('x');\nselect 1 as second€$tag$;\n"
d = scratch("q1", codex30a)
checks.append(("€ before $tag$: fixed catalogues the enum", run(d)[1].get("mood") == ["x"]))
checks.append(("é before $$ likewise", run(scratch("q2", "select 1 as aé$$;\ncreate type mood as enum ('x');\nselect 1 as bé$$;\n"))[1].get("mood") == ["x"]))
checks.append(("a real dollar quote after € and a space still opens (DDL inside refused)", refuses(scratch("q3", "select 1 as a€ $q$create type$q$;\n"), "does not read")))
# --- round thirty B: a schema-qualified set_config is somebody else's function
codex30b = "select app.set_config('role', 'authenticated', false);\n"
d = scratch("q4", codex30b)
checks.append(("app.set_config(role): fixed allows", unchanged(d)))
checks.append(("pg_catalog.set_config(role) still refused", refuses(scratch("q5", "select pg_catalog.set_config('role', 'authenticated', false);\n"), "switches the current role")))
checks.append(("public.set_config(role) still refused", refuses(scratch("q6", "select public.set_config('role', 'authenticated', false);\n"), "switches the current role")))
checks.append(("quoted \"pg_catalog\".\"set_config\"(role) still refused", refuses(scratch("q7", 'select "pg_catalog"."set_config"(' + "'role', 'authenticated', false);\n"), "switches the current role")))
checks.append(("quoted \"app\".set_config allowed", unchanged(scratch("q8", 'select "app".set_config(' + "'role', 'authenticated', false);\n"))))
checks.append(("app . set_config with spaces allowed", unchanged(scratch("q9", "select app . set_config('role', 'authenticated', false);\n"))))
checks.append(("unqualified set_config(role) still refused", refuses(scratch("q10", "select set_config('role', 'authenticated', false);\n"), "switches the current role")))
checks.append(("body app.set_config(role) allowed", unchanged(scratch("q11", "do $$ begin perform app.set_config('role', 'authenticated', false); end $$;\n"))))
checks.append(("body pg_catalog.set_config(role) still refused", refuses(scratch("q12", "do $$ begin perform pg_catalog.set_config('role', 'authenticated', false); end $$;\n"), "does not read")))
checks.append(("body unqualified set_config(role) still refused", refuses(scratch("q13", "do $$ begin perform set_config('role', 'authenticated', false); end $$;\n"), "does not read")))
checks.append(("app.set_config(search_path) allowed too", unchanged(scratch("q14", "select app.set_config('search_path', 'private', false);\n"))))

# --- round thirty-one: identifier boundaries by the lexer's rule, everywhere
codex31 = "select custom$set_config('role', 'authenticated', false);\n"
d = scratch("r31a", codex31)
checks.append(("custom$set_config(role): fixed allows", unchanged(d)))
scratch('r31b', "select x·set_config('role', 'authenticated', false);\n")
checks.append(("x·set_config(role): fixed allows", unchanged(S/"r31b")))
checks.append(("custom$set_config(search_path): fixed allows", unchanged(scratch("r31c", "select custom$set_config('search_path', 'private', false);\n"))))
scratch('r31d', "do $$ begin perform custom$set_config('role', 'authenticated', false); end $$;\n")
checks.append(("body custom$set_config(role): fixed allows", unchanged(S/"r31d")))
checks.append(("unqualified set_config(role) still refused", refuses(scratch("r31e", "select set_config('role', 'authenticated', false);\n"), "switches the current role")))
checks.append(("body set_config(role) still refused", refuses(scratch("r31f", "do $$ begin perform set_config('role', 'authenticated', false); end $$;\n"), "does not read")))
checks.append(("body EXECUTE'd set_config(role) still refused (clean-text scan kept)", refuses(scratch("r31g", "do $$ begin execute 'select set_config(''role'', ''authenticated'', false)'; end $$;\n"), "does not read")))
checks.append(("two spaces then set_config( is still the built-in", refuses(scratch("r31h", "select  set_config('role', 'authenticated', false);\n"), "switches the current role")))
scratch('r31i', "do $$ declare v$search_path text := 'x'; begin raise notice '%', v$search_path; end $$;\n")
checks.append(("body variable v$search_path: fixed allows", unchanged(S/"r31i")))
scratch('r31j', "do $$ declare search_path$1 text := 'x'; begin raise notice '%', search_path$1; end $$;\n")
checks.append(("body variable search_path$1: fixed allows", unchanged(S/"r31j")))
checks.append(("body mentioning search_path in a string still refused", refuses(scratch("r31k", "do $$ begin raise notice 'search_path'; end $$;\n"), "does not read")))
scratch('r31l', 'do $$ declare r record; begin select 1 as my$execute into r; end $$;\n')
checks.append(("body alias my$execute: fixed allows", unchanged(S/"r31l")))
checks.append(("body EXECUTE of a variable still refused", refuses(scratch("r31m", "do $$ declare q text := 'x'; begin execute q; end $$;\n"), "does not read")))
checks.append(("body EXECUTE … INTO still parsed (literal command allowed)", unchanged(scratch("r31m2", "do $$ declare n int; begin execute 'select 1' into n; end $$;\n"))))
d = scratch("r31n", "alter role my$set set search_path = private;\n")
checks.append(("alter role my$set set search_path: fixed refuses", refuses(d, "moves search_path")))
checks.append(("alter role my$set set work_mem allowed", unchanged(scratch("r31o", "alter role my$set set work_mem = '64MB';\n"))))
checks.append(("alter role my$set reset search_path allowed", unchanged(scratch("r31p", "alter role my$set reset search_path;\n"))))
checks.append(("alter role my$set set search_path to default allowed", unchanged(scratch("r31q", "alter role my$set set search_path to default;\n"))))
checks.append(("set role to$x still refused (a switch to a role named to$x)", refuses(scratch("r31r", "set role to$x;\n"), "switches the current role")))
checks.append(("set search_path to$x still refused (a schema named to$x)", refuses(scratch("r31r2", "set search_path to$x;\n"), "moves search_path")))
checks.append(("create schema public$deploy still counts (round 26 control)", refuses(scratch("r31s", "create schema public$deploy;\ncreate type mood as enum ('happy');\n"), SHADOW)))
checks.append(("begin atomic still refused", refuses(scratch("r31t", "create procedure later() language sql begin atomic select 1; end;\n"), "BEGIN ATOMIC")))
checks.append(("drop type with cascade still read", "payment_status" not in run(scratch("r31u", "drop type payment_status cascade;\n"))[2]))
checks.append(("create type$x is not an enum statement and not a crash", run(scratch("r31v", "select 1 as type$x;\n"))[0] == committed))
src31 = GENERATOR.read_text().splitlines()
checks.append(("no `\\b` survives outside comments", not any(chr(92) + "b" in l for l in src31 if not l.lstrip().startswith("#"))))

# --- round thirty-two A: only the literal in body position is a routine body
codex32a = "create function f(x text default 'create type') returns text language sql as $$ select x $$;\n"
d = scratch("s32a", codex32a)
checks.append(("default 'create type': fixed allows", unchanged(d)))
scratch('s32b', "create function f(x text default 'search_path') returns text language sql as $$ select x $$;\n")
checks.append(("default 'search_path': fixed allows", unchanged(S/"s32b")))
checks.append(("upper-case DEFAULT and AS still parsed", unchanged(scratch("s32b2", "CREATE FUNCTION f(x TEXT DEFAULT 'create type') RETURNS TEXT LANGUAGE SQL AS $$ SELECT x $$;\n"))))
checks.append(("dollar-quoted default carrying DDL still refused as a value", refuses(scratch("s32c", "create function f(x text default $d$create type$d$) returns text language sql as $$ select x $$;\n"), "does not read")))
checks.append(("function body with DDL still refused", refuses(scratch("s32d", "create function f() returns void language plpgsql as $$ begin execute 'create type public.mood as enum (''x'')'; end $$;\n"), "does not read")))
checks.append(("body after a default still checked", refuses(scratch("s32d2", "create function f(x text default 'a') returns void language plpgsql as $$ begin execute 'create type public.mood as enum (''x'')'; end $$;\n"), "does not read")))
checks.append(("single-quoted function body with a role switch still refused", refuses(scratch("s32e", "create function f() returns void language plpgsql as 'begin perform set_config(''role'', ''authenticated'', false); end';\n"), "does not read")))
checks.append(("AS then newline then body still a body", refuses(scratch("s32e2", "create function f() returns void language plpgsql as\n  $$ begin execute 'create type public.mood as enum (''x'')'; end $$;\n"), "does not read")))
checks.append(("DO body still refused", refuses(scratch("s32f", "do $$ begin execute 'create type public.mood as enum (''x'')'; end $$;\n"), "does not read")))
checks.append(("DO LANGUAGE plpgsql body still refused", refuses(scratch("s32g", "do language plpgsql $$ begin execute 'create type public.mood as enum (''x'')'; end $$;\n"), "does not read")))
checks.append(("single-quoted DO body still refused", refuses(scratch("s32h", "DO 'BEGIN EXECUTE ''CREATE TYPE mood AS ENUM (''''x'''')''; END';\n"), "does not read")))
checks.append(("a role switch in a DEFAULT expression is still caught by the top-level reader", refuses(scratch("s32i", "create function g(x text default set_config('role', 'authenticated', false)) returns text language sql as $$ select x $$;\n"), "switches the current role")))
checks.append(("C function AS 'obj', 'sym' allowed", unchanged(scratch("s32j", "create function h() returns text language c as 'obj_file', 'link_symbol';\n"))))
checks.append(("function SET clause with a quoted value is not a body", unchanged(scratch("s32k", "create function f() returns int language sql set search_path = 'public' as $$ select 1 $$;\n"))))
checks.append(("RETURN form with a literal is data", unchanged(scratch("s32m", "create function one() returns text language sql return 'create type';\n"))))
checks.append(("a literal in an ordinary statement is still data", unchanged(scratch("s32m2", "select 'create type';\n"))))
# --- round thirty-two B: a setting's name is read whole
codex32b = "alter role deploy set search_path.custom = 'value';\n"
d = scratch("s32n", codex32b)
checks.append(("alter role … set search_path.custom: fixed allows", unchanged(d)))
checks.append(("alter role … set search_path.custom: fixed reads the target whole", load(NEW).alter_set_target("alter role deploy set search_path.custom = 'value'", "alter role deploy set search_path.custom = 'xxxxx'") == "search_path.custom"))
scratch('s32o', "set search_path.custom = 'x';\n")
checks.append(("set search_path.custom: fixed allows", unchanged(S/"s32o")))
checks.append(("set \"search_path\".custom allowed", unchanged(scratch("s32p", 'set "search_path".custom = ' + "'x';\n"))))
checks.append(("set \"search_path.custom\" (quoted whole) allowed", unchanged(scratch("s32q", 'set "search_path.custom" = ' + "'z';\n"))))
checks.append(("set search_path . custom (spaced dot) allowed", unchanged(scratch("s32r", "set search_path . custom = 'w';\n"))))
scratch('s32s', "set role.custom = 'r';\n")
checks.append(("set role.custom: fixed allows", unchanged(S/"s32s")))
checks.append(("set standard_conforming_strings.x allowed", unchanged(scratch("s32t", "set standard_conforming_strings.x = 'q';\n"))))
checks.append(("set session_authorization.x allowed", unchanged(scratch("s32u", "set session_authorization.x = 'q';\n"))))
checks.append(("set schema.custom allowed (measured legal)", unchanged(scratch("s32v", "set schema.custom = 'v';\n"))))
checks.append(("alter role … set role.custom allowed", unchanged(scratch("s32w", "alter role deploy set role.custom = 'r';\n"))))
checks.append(("alter role … set \"a\".b allowed", unchanged(scratch("s32x", 'alter role deploy set "a".b = ' + "'v';\n"))))
checks.append(("alter role … set \"search_path\".custom allowed", unchanged(scratch("s32x2", 'alter role deploy set "search_path".custom = ' + "'v';\n"))))
checks.append(("alter role … set search_path = private still refused", refuses(scratch("s32y", "alter role deploy set search_path = private;\n"), "moves search_path")))
checks.append(("alter role … set \"SEARCH_PATH\" = private still refused (names fold)", refuses(scratch("s32z", 'alter role deploy set "SEARCH_PATH" = private;\n'), "moves search_path")))
checks.append(("set \"SEARCH_PATH\" = private still refused", refuses(scratch("s32z2", 'set "SEARCH_PATH" = private;\n'), "moves search_path")))
checks.append(("alter role … set role = x still refused", refuses(scratch("s32z3", "alter role deploy set role = authenticated;\n"), "switches the current role")))
checks.append(("set_config('search_path.custom') allowed", unchanged(scratch("s32z4", "select set_config('search_path.custom', 'x', false);\n"))))
checks.append(("set search_path = private still refused", refuses(scratch("s32z5", "set search_path = private;\n"), "moves search_path")))
checks.append(("set role authenticated still refused", refuses(scratch("s32z6", "set role authenticated;\n"), "switches the current role")))
checks.append(("set session_authorization = x still refused", refuses(scratch("s32z7", "set session_authorization = authenticated;\n"), "switches the current role")))
checks.append(("set standard_conforming_strings = off still refused", refuses(scratch("s32z8", "set standard_conforming_strings = off;\n"), "standard_conforming_strings")))
checks.append(("E'' function body still a body", refuses(scratch("s32e3", "create function f() returns void language plpgsql as E'begin execute ''create type public.mood as enum (x)''; end';\n"), "does not read")))
checks.append(("set \"role\".custom allowed", unchanged(scratch("s32p2", 'set "role".custom = ' + "'r';\n"))))
checks.append(("set \"standard_conforming_strings\".x allowed", unchanged(scratch("s32p3", 'set "standard_conforming_strings".x = ' + "'q';\n"))))
checks.append(("set \"role\" = x still refused", refuses(scratch("s32p4", 'set "role" = authenticated;\n'), "switches the current role")))
checks.append(("set \"session_authorization\".x allowed", unchanged(scratch("s32p5", 'set "session_authorization".x = ' + "'q';\n"))))

# --- round thirty-three: an EXECUTE'd command is a migration fragment
codex33 = "do $$ begin execute 'create /*gap*/ type public.ghost as enum (''x'')'; end $$;\n"
d = scratch("t33a", codex33)
checks.append(("comment-split DDL in an EXECUTE'd literal: fixed refuses", refuses(d, "does not read")))
scratch('t33b', "do $$ begin execute 'create -- gap\ntype public.ghost as enum (''x'')'; end $$;\n")
checks.append(("line comment with a real newline: fixed refuses", refuses(S/"t33b", "does not read")))
checks.append(("function body variant: fixed refuses", refuses(scratch("t33c", "create function mk() returns void language plpgsql as $$ begin execute 'create /*gap*/ type public.ghost as enum (''x'')'; end $$;\n"), "does not read")))
scratch('t33d', "do $$ begin execute format('create /*gap*/ type public.%I as enum (%L)', 'ghost', 'x'); end $$;\n")
checks.append(("format template split: fixed refuses", refuses(S/"t33d", "does not read")))
checks.append(("format %s argument split: fixed refuses", refuses(scratch("t33e", "do $$ begin execute format('%s', 'create /*gap*/ type public.ghost as enum (''x'')'); end $$;\n"), "does not read")))
scratch('t33f', "do $$ begin execute 'do $q$ begin execute ''create /*gap*/ type public.ghost as enum (''''x'''')''; end $q$'; end $$;\n")
checks.append(("nested DO inside an EXECUTE'd literal: fixed refuses (recursion)", refuses(S/"t33f", "does not read")))
scratch('t33g', "do $$ begin execute 'select set_config/*c*/(''role'', ''authenticated'', false)'; end $$;\n")
checks.append(("set_config split by a comment: fixed refuses", refuses(S/"t33g", "does not read")))
checks.append(("EXECUTE'd search_path change refused", refuses(scratch("t33h", "do $$ begin execute 'set /*c*/ search_path = private'; end $$;\n"), "does not read")))
checks.append(("EXECUTE'd dollar value carrying DDL refused", refuses(scratch("t33i", "do $$ begin execute 'comment on type payment_status is $d$create type ghost$d$'; end $$;\n"), "does not read")))
checks.append(("inert EXECUTE'd command still allowed", unchanged(scratch("t33j", "do $$ begin execute 'select 1'; end $$;\n"))))
checks.append(("comment in an inert EXECUTE'd command still allowed", unchanged(scratch("t33k", "do $$ begin execute 'select 1 /* note */'; end $$;\n"))))
checks.append(("EXECUTE'd insert with a dollar value still allowed", unchanged(scratch("t33l", "do $$ begin execute 'insert into job_runs(job) values ($v$nightly$v$)'; end $$;\n"))))
checks.append(("EXECUTE … INTO with a literal still allowed", unchanged(scratch("t33m", "do $$ declare n int; begin execute 'select 1' into n; end $$;\n"))))
checks.append(("EXECUTE with a $1 parameter still allowed", unchanged(scratch("t33n", "do $$ declare n int; begin execute 'select $1 + 1' into n using 1; end $$;\n"))))
checks.append(("format with an inert template and args still allowed", unchanged(scratch("t33o", "do $$ begin execute format('select %L', 'hello'); end $$;\n"))))
checks.append(("prose EXECUTE inside a nested dollar value is still not an EXECUTE (round fourteen)", unchanged(scratch("t33p", "do $$ begin perform length($msg$please execute this later$msg$); end $$;\n"))))
checks.append(("contiguous DDL in an EXECUTE'd literal still refused", refuses(scratch("t33q", "do $$ begin execute 'create type public.ghost as enum (''x'')'; end $$;\n"), "does not read")))
checks.append(("nested DO (contiguous) inside an EXECUTE'd literal still refused", refuses(scratch("t33r", "do $$ begin execute 'do $q$ begin perform 1; execute ''create type public.ghost as enum (''''x'''')''; end $q$'; end $$;\n"), "does not read")))
checks.append(("nested dollar-quoted EXECUTE'd command with split DDL refused", refuses(scratch("t33s", "do $$ begin execute $q$create /*gap*/ type public.ghost as enum ('x')$q$; end $$;\n"), "does not read")))

# --- round thirty-four: public may be neither renamed nor dropped
codex34 = "alter schema public rename to old_public;\ncreate schema public;\n"
d = scratch("u34a", codex34)
checks.append(("rename public then recreate: fixed refuses", refuses(d, "renames or drops")))
checks.append(("rename public alone: fixed refuses", refuses(scratch("u34b", "alter schema public rename to old_public;\n"), "renames or drops")))
scratch('u34c', 'drop schema public cascade;\n')
checks.append(("drop schema public cascade: fixed refuses", refuses(S/"u34c", "renames or drops")))
checks.append(("drop schema public (no cascade) refused", refuses(scratch("u34d", "drop schema public;\n"), "renames or drops")))
checks.append(("drop schema if exists public cascade refused", refuses(scratch("u34e", "drop schema if exists public cascade;\n"), "renames or drops")))
checks.append(("drop schema aux, public cascade refused", refuses(scratch("u34f", "drop schema aux, public cascade;\n"), "renames or drops")))
checks.append(("rename \"public\" (quoted) refused", refuses(scratch("u34g", 'alter schema "public" rename to old_public;\n'), "renames or drops")))
checks.append(("rename PUBLIC (upper, folds) refused", refuses(scratch("u34h", "ALTER SCHEMA PUBLIC RENAME TO old_public;\n"), "renames or drops")))
checks.append(("rename \"Public\" (another schema) allowed", unchanged(scratch("u34i", 'alter schema "Public" rename to other;\n'))))
checks.append(("rename another schema allowed", unchanged(scratch("u34j", "create schema aux;\nalter schema aux rename to aux2;\n"))))
checks.append(("drop another schema allowed", unchanged(scratch("u34k", "create schema aux;\ndrop schema aux cascade;\n"))))
checks.append(("dropping another schema creates no shadow", run(scratch("u34l", "drop schema if exists aux cascade;\ncreate type mood as enum ('x');\n"))[1].get("mood") == ["x"]))
checks.append(("creating another schema still shadows (round twenty-five)", refuses(scratch("u34m", "create schema aux;\ncreate type mood as enum ('x');\n"), SHADOW)))
checks.append(("rename another schema TO public still shadows", refuses(scratch("u34n", "alter schema aux rename to public;\ncreate type mood as enum ('x');\n"), SHADOW)))
checks.append(("create schema public still exempt", run(scratch("u34o", "create schema public;\ncreate type mood as enum ('x');\n"))[1].get("mood") == ["x"]))
scratch('u34p', "do $$ begin execute 'drop schema public cascade'; end $$;\n")
checks.append(("drop public inside a body: fixed refuses", refuses(S/"u34p", "does not read")))
checks.append(("drop of any schema inside a body refused (body rule)", refuses(scratch("u34q", "do $$ begin execute 'drop schema aux cascade'; end $$;\n"), "does not read")))
checks.append(("rename public inside a body still refused", refuses(scratch("u34r", "do $$ begin execute 'alter schema public rename to old_public'; end $$;\n"), "does not read")))
checks.append(("the words inside a value are inert", unchanged(scratch("u34s", "select 'drop schema public cascade';\n"))))
checks.append(("the words inside a comment are inert", unchanged(scratch("u34t", "-- drop schema public cascade is not done here\nselect 1;\n"))))

# --- round thirty-five: a schema name the reader cannot spell is refused, not mistaken
UNREAD = "Unicode-escaped identifier"
codex35a = 'drop schema U&"public" cascade;\n'
d = scratch("y35a", codex35a)
checks.append(("drop U&\"public\": fixed refuses as unreadable", refuses(d, UNREAD)))
codex35b = 'alter schema U&"public" rename to old_public;\n'
d = scratch("y35b", codex35b)
checks.append(("rename U&\"public\": fixed refuses as unreadable", refuses(d, UNREAD)))
checks.append(("drop U&\"\\0070ublic\" (escaped p) refused", refuses(scratch("y35c", 'drop schema U&"\\0070ublic" cascade;\n'), UNREAD)))
checks.append(("UESCAPE form refused", refuses(scratch("y35d", "drop schema U&\"!0070ublic\" uescape '!' cascade;\n"), UNREAD)))
checks.append(("drop U&\"aux\" refused too (the reader cannot tell which schema)", refuses(scratch("y35e", 'drop schema U&"aux" cascade;\n'), UNREAD)))
checks.append(("rename U&\"aux\" refused too", refuses(scratch("y35f", 'alter schema U&"aux" rename to b;\n'), UNREAD)))
checks.append(("drop aux, U&\"public\" refused", refuses(scratch("y35g", 'drop schema aux, U&"public" cascade;\n'), UNREAD)))
checks.append(("create U&\"public\" then unqualified create: refused as the spelling since round forty", refuses(scratch("y35h", 'create schema U&"public";\ncreate type mood as enum (\'x\');\n'), "Unicode-escaped identifier")))
checks.append(("create U&\"aux\": refused as the spelling since round forty (it was allowed)", refuses(scratch("y35i", 'create schema U&"aux";\n'), "Unicode-escaped identifier")))
checks.append(("plain drop public still refused by the public rule", refuses(scratch("y35j", "drop schema public cascade;\n"), "renames or drops")))
checks.append(("plain rename public still refused by the public rule", refuses(scratch("y35k", "alter schema public rename to old_public;\n"), "renames or drops")))
checks.append(("plain rename of another schema still allowed", unchanged(scratch("y35l", "create schema aux;\nalter schema aux rename to aux2;\n"))))
checks.append(("plain drop of another schema still allowed", unchanged(scratch("y35m", "create schema aux;\ndrop schema aux cascade;\n"))))
checks.append(("quoted \"Public\" rename still another schema", unchanged(scratch("y35n", 'alter schema "Public" rename to other;\n'))))
checks.append(("U&\"public\" drop inside a body refused (the mention rule runs first)", refuses(scratch("y35o", "do $$ begin execute 'drop schema U&\"public\" cascade'; end $$;\n"), "does not read")))
checks.append(("the words inside a value are inert", unchanged(scratch("y35p", "select 'drop schema U&\"public\" cascade';\n"))))

# --- round thirty-six: schema names are read off the skeleton
DQ = chr(34)
codex36a = 'drop schema "tenant,archive" cascade;\n'
d = scratch("w36a", codex36a)
checks.append(("drop \"tenant,archive\": fixed allows", unchanged(d)))
codex36b = 'alter schema "tenant rename archive" rename to archived;\n'
d = scratch("w36b", codex36b)
checks.append(("rename \"tenant rename archive\": fixed allows", unchanged(d)))
checks.append(("rename \"tenant rename archive\" then unqualified create still shadows", refuses(scratch("w36b2", 'alter schema "tenant rename archive" rename to archived;\ncreate type mood as enum (\'x\');\n'), SHADOW)))
checks.append(("drop \"public,x\" (another schema) allowed", unchanged(scratch("w36c", 'drop schema "public,x" cascade;\n'))))
checks.append(("rename \"x rename public\" allowed", unchanged(scratch("w36d", 'alter schema "x rename public" rename to y;\n'))))
checks.append(("drop \"a;b\" still allowed", unchanged(scratch("w36e", 'drop schema "a;b";\n'))))
checks.append(("drop \"say \"\"public\"\"\" (doubled quotes) still allowed", unchanged(scratch("w36f", 'drop schema "say ""public""" cascade;\n'))))
checks.append(("drop aux, \"tenant,archive\" allowed", unchanged(scratch("w36g", 'drop schema aux, "tenant,archive" cascade;\n'))))
checks.append(("drop \"tenant,archive\", public refused by the public rule", refuses(scratch("w36h", 'drop schema "tenant,archive", public cascade;\n'), "renames or drops")))
checks.append(("drop \"public\" still refused", refuses(scratch("w36i", 'drop schema "public" cascade;\n'), "renames or drops")))
checks.append(("rename \"public\" still refused", refuses(scratch("w36j", 'alter schema "public" rename to old_public;\n'), "renames or drops")))
checks.append(("rename PUBLIC (bare, folds) still refused", refuses(scratch("w36k", "ALTER SCHEMA PUBLIC RENAME TO old_public;\n"), "renames or drops")))
checks.append(("rename \"Public\" still another schema", unchanged(scratch("w36l", 'alter schema "Public" rename to other;\n'))))
checks.append(("drop U&\"public\" still refused as unreadable", refuses(scratch("w36m", 'drop schema U&"public" cascade;\n'), "Unicode-escaped identifier")))
checks.append(("rename U&\"public\" still refused as unreadable", refuses(scratch("w36n", 'alter schema U&"public" rename to old_public;\n'), "Unicode-escaped identifier")))
checks.append(("drop aux, U&\"x\" still refused as unreadable", refuses(scratch("w36o", 'drop schema aux, U&"x" cascade;\n'), "Unicode-escaped identifier")))
checks.append(("plain rename of another schema still allowed", unchanged(scratch("w36p", "create schema aux;\nalter schema aux rename to aux2;\n"))))
checks.append(("plain drop of another schema still allowed and shadow-free", run(scratch("w36q", "drop schema if exists aux cascade;\ncreate type mood as enum ('x');\n"))[1].get("mood") == ["x"]))

# --- round thirty-seven: the drop behaviour is a delimited keyword
codex37 = "drop schema publiccascade;\n"
d = scratch("v37a", codex37)
checks.append(("drop publiccascade: fixed allows", unchanged(d)))
checks.append(("drop publicrestrict cascade: fixed allows (the shipped reader passed it too — only a glued suffix misreads)", unchanged(scratch("v37b", "drop schema publicrestrict cascade;\n"))))
scratch('v37b2', 'drop schema publicrestrict;\n')
checks.append(("drop publicrestrict; fixed allows", unchanged(S/"v37b2")))
checks.append(("drop public cascade still refused", refuses(scratch("v37c", "drop schema public cascade;\n"), "renames or drops")))
checks.append(("drop public restrict still refused", refuses(scratch("v37d", "drop schema public restrict;\n"), "renames or drops")))
checks.append(("drop public (no behaviour) still refused", refuses(scratch("v37e", "drop schema public;\n"), "renames or drops")))
checks.append(("DROP SCHEMA PUBLIC CASCADE (upper) still refused", refuses(scratch("v37f", "DROP SCHEMA PUBLIC CASCADE;\n"), "renames or drops")))
checks.append(("drop aux, public cascade still refused", refuses(scratch("v37g", "drop schema aux, public cascade;\n"), "renames or drops")))
checks.append(("drop \"public\" cascade still refused", refuses(scratch("v37h", 'drop schema "public" cascade;\n'), "renames or drops")))
checks.append(("drop cascade (a schema named cascade) allowed", unchanged(scratch("v37i", "drop schema cascade;\n"))))
checks.append(("drop publiccascade then unqualified create still catalogued (no shadow from a drop)", run(scratch("v37j", "drop schema publiccascade;\ncreate type mood as enum ('x');\n"))[1].get("mood") == ["x"]))

# --- round thirty-eight: an escape-string routine body is refused, not read
ESC = "escape string"
codex38 = "DO U&'begin execute ''create type public.ghost as enum (''''x'''')''; end';\n"
d = scratch("e38a", codex38)
checks.append(("DO U&'…' body with DDL: fixed refuses by name", refuses(d, ESC)))
d = scratch("e38b", "DO E'begin execute ''\\x63reate type public.ghost2 as enum (''''y'''')''; end';\n")
checks.append(("DO E'…' body with \\x63reate: fixed refuses by name", refuses(d, ESC)))
checks.append(("DO U&'…' body with \\0063reate refused", refuses(scratch("e38c", "DO U&'begin execute ''\\0063reate type public.ghost3 as enum (''''z'''')''; end';\n"), ESC)))
scratch('e38d', "create function f38() returns void language plpgsql as U&'begin execute ''create type public.ghost4 as enum (''''w'''')''; end';\n")
checks.append(("function AS U&'…' body: fixed refuses", refuses(S/"e38d", ESC)))
checks.append(("function AS E'…' body refused (even inert)", refuses(scratch("e38e", "create function f38() returns int language sql as E'select 1';\n"), ESC)))
checks.append(("DO E'…' inert body refused too (the form, not the content)", refuses(scratch("e38f", "DO E'begin perform 1; end';\n"), ESC)))
checks.append(("DO LANGUAGE plpgsql U&'…' refused", refuses(scratch("e38g", "do language plpgsql U&'begin perform 1; end';\n"), ESC)))
checks.append(("DO E'…' with plain DDL still refused", refuses(scratch("e38h", "DO E'begin execute ''create type public.ghost as enum (''''x'''')''; end';\n"), "does not read")))
checks.append(("U&'…' as a value is still data", unchanged(scratch("e38i", "select U&'create type ghost';\n"))))
checks.append(("E'…' as a value is still data", unchanged(scratch("e38j", "select E'create type ghost';\n"))))
checks.append(("U&'…' value inside a dollar body is data", unchanged(scratch("e38k", "do $$ begin perform length(U&'\\0063reate type'); end $$;\n"))))
checks.append(("EXECUTE of a U&'…' command inside a body refused as unreadable", refuses(scratch("e38l", "do $$ begin execute U&'select 1'; end $$;\n"), "does not read")))
checks.append(("EXECUTE of an E'…' command inside a body refused as unreadable", refuses(scratch("e38m", "do $$ begin execute E'select 1'; end $$;\n"), "does not read")))
checks.append(("a schema named u followed by &? no — `u&` is only a prefix at a token boundary: xu&'…' is not one", unchanged(scratch("e38n", "select 1 as xu&'a';\n")) or run(scratch("e38n2", "select 1;\n"))[0] == committed))
checks.append(("plain dollar DO still fine", unchanged(scratch("e38o", "do $$ begin perform 1; end $$;\n"))))
checks.append(("plain single-quoted DO body with DDL still refused", refuses(scratch("e38p", "DO 'BEGIN EXECUTE ''CREATE TYPE mood AS ENUM (''''x'''')''; END';\n"), "does not read")))

# --- round thirty-nine: a setting name spelled U&"…" is refused, not passed
UN = "Unicode-escaped identifier"
codex39 = 'set U&"standard_conforming_strings" = off;\ncreate type mood as enum (\'line\\nfeed\');\n'
d = scratch("h39a", codex39)
checks.append(("set U&\"standard_conforming_strings\" = off: fixed refuses by name", refuses(d, UN)))
d = scratch("h39b", 'alter role deploy set U&"search_path" = private;\n')
checks.append(("alter role … set U&\"search_path\": fixed refuses", refuses(d, UN)))
checks.append(("set U&\"search_path\" = private refused", refuses(scratch("h39c", 'set U&"search_path" = private;\n'), UN)))
checks.append(("set U&\"role\" = x refused", refuses(scratch("h39d", 'set U&"role" = authenticated;\n'), UN)))
checks.append(("set U&\"session_authorization\" = x refused", refuses(scratch("h39e", 'set U&"session_authorization" = authenticated;\n'), UN)))
checks.append(("set local U&\"search_path\" refused", refuses(scratch("h39f", 'set local U&"search_path" = private;\n'), UN)))
checks.append(("SET U&\"…\" upper-case refused", refuses(scratch("h39g", 'SET U&"SEARCH_PATH" = private;\n'), UN)))
checks.append(("set U&\"work_mem\" refused too (the reader cannot tell which setting)", refuses(scratch("h39h", 'set U&"work_mem" = \'64MB\';\n'), UN)))
checks.append(("alter database … set U&\"work_mem\" refused too", refuses(scratch("h39i", 'alter database postgres set U&"work_mem" = \'64MB\';\n'), UN)))
checks.append(("reset U&\"search_path\": refused as the spelling since round forty (it was allowed)", refuses(scratch("h39j", 'reset U&"search_path";\n'), "Unicode-escaped identifier")))
checks.append(("alter role … reset U&\"search_path\": refused as the spelling since round forty (it was allowed)", refuses(scratch("h39k", 'alter role deploy reset U&"search_path";\n'), "Unicode-escaped identifier")))
checks.append(("set \"search_path\" = private still refused by the path rule", refuses(scratch("h39l", 'set "search_path" = private;\n'), "moves search_path")))
checks.append(("set \"work_mem\" allowed", unchanged(scratch("h39m", 'set "work_mem" = \'64MB\';\n'))))
checks.append(("alter role … set \"work_mem\" allowed", unchanged(scratch("h39n", 'alter role deploy set "work_mem" = \'64MB\';\n'))))
checks.append(("set search_path = U&\"public\" refused as the spelling", refuses(scratch("h39o", 'set search_path = U&"public";\n'), "Unicode-escaped identifier")))
checks.append(("set_config(U&'search_path') still refused", refuses(scratch("h39p", "select set_config(U&'search_path', 'private', false);\n"), "moves search_path")))
checks.append(("a body carrying U&\"search_path\" refused (the mention rule runs first)", refuses(scratch("h39q", 'do $$ begin execute \'set U&"search_path" = private\'; end $$;\n'), "does not read")))
checks.append(("the words inside a value are inert", unchanged(scratch("h39r", 'select \'set U&"search_path" = private\';\n'))))
# --- round forty: a U&"…" identifier is refused wherever the generator reads code
UI = "Unicode-escaped identifier"
k1 = 'do $$ begin set U&"' + BS + '0073earch_path" = auth, public; end $$;\ncreate type mood as enum (\'x\');\n'
d = scratch("k40a", k1)
checks.append(("body: set U&\"\\0073earch_path\": fixed refuses as the spelling", refuses(d, UI)))
k2 = 'select U&"' + BS + '0073et_config"(\'search_path\', \'auth, public\', false);\ncreate type mood as enum (\'x\');\n'
d = scratch("k40b", k2)
checks.append(("top level: U&\"\\0073et_config\"(…): fixed refuses", refuses(d, UI)))
k3 = 'do $$ begin perform U&"' + BS + '0073et_config"(U&\'' + BS + '0073earch_path\', \'auth, public\', false); end $$;\ncreate type mood as enum (\'x\');\n'
d = scratch("k40c", k3)
checks.append(("body: U&\"\\0073et_config\"(U&'\\0073earch_path', …): fixed refuses as the spelling", refuses(d, UI)))
d = scratch("k40c2", 'do $$ begin perform U&"' + BS + '0073et_config"(\'search_path\', \'auth, public\', false); end $$;\n')
checks.append(("… and fixed still refuses it", refuses(d, "does not read")))
checks.append(("execute of a dollar string carrying U&\"…\" refused", refuses(scratch("k40d", 'do $$ begin execute $q$set U&"' + BS + '0073earch_path" = auth$q$; end $$;\n'), UI)))
checks.append(("an alias spelled U&\"x\" refused (stated: any name)", refuses(scratch("k40e", 'select 1 as U&"x";\n'), UI)))
checks.append(("lower-case u&\"x\" refused", refuses(scratch("k40f", 'select u&"x";\n'), UI)))
checks.append(("U&\"…\" inside a string is text", unchanged(scratch("k40g", 'select \'U&"x"\';\n'))))
checks.append(("U&\"…\" inside a dollar-quoted value is text", unchanged(scratch("k40h", 'comment on type payment_status is $doc$see U&"x"$doc$;\n'))))
checks.append(("U&\"…\" inside a body's dollar-quoted prose is text", unchanged(scratch("k40i", 'do $$ begin perform length($msg$see U&"x"$msg$); end $$;\n'))))
checks.append(("U&\"…\" inside a line comment is text", unchanged(scratch("k40j", '-- see U&"x"\nselect 1;\n'))))
checks.append(("U&\"…\" inside a block comment is text", unchanged(scratch("k40k", '/* see U&"x" */ select 1;\n'))))
checks.append(("xu&\"col\" is `xu & \"col\"`, not a U& identifier (token boundary)", unchanged(scratch("k40l", 'select xu&"col" from job_runs;\n'))))
checks.append(("u2&\"col\" likewise", unchanged(scratch("k40m", 'select u2&"col" from job_runs;\n'))))
checks.append(("(u&\"col\") IS a U& identifier (the lexer's longest match) and is refused", refuses(scratch("k40n", 'select (u&"col") from job_runs;\n'), UI)))
checks.append(("the schema reader's unreadable branch is still reachable for a non-token spelling", refuses(scratch("k40o", 'alter schema a b rename to c;\n'), "schema name this generator cannot read")))
checks.append(("U&'…' string as a set_config name still refused by the plain-literal rule (not new)", refuses(scratch("k40p", "select set_config(U&'" + BS + "0073earch_path', 'auth, public', false);\n"), "moves search_path")))
checks.append(("U&'…' data value still allowed", unchanged(scratch("k40q", "insert into job_runs(job) values (U&'" + BS + "00e9');\n"))))
checks.append(("the round-38 E'…' body is still refused as an escape string", refuses(scratch("k40r", "do E'begin perform 1; end';\n"), "escape string")))
# --- round forty-one: a doubled quote inside a quoted set_config qualifier
ROLE = "switches the current role"
n1 = 'select "evil""pg_catalog".set_config(\'role\', \'authenticated\', false);\n'
d = scratch("n41a", n1)
checks.append(("top level: \"evil\"\"pg_catalog\".set_config: fixed passes, catalogue unchanged", unchanged(d)))
n2 = 'do $$ begin perform "evil""pg_catalog".set_config(\'role\', \'authenticated\', false); end $$;\n'
d = scratch("n41b", n2)
checks.append(("body: \"evil\"\"pg_catalog\".set_config: fixed passes", unchanged(d)))
checks.append(("execute'd literal calling \"evil\"\"pg_catalog\".set_config passes", unchanged(scratch("n41c", 'do $$ begin execute \'select "evil""pg_catalog".set_config(\'\'role\'\', \'\'authenticated\'\', false)\'; end $$;\n'))))
checks.append(("\"pg_catalog\".set_config('role', …) still refused", refuses(scratch("n41d", 'select "pg_catalog".set_config(\'role\', \'authenticated\', false);\n'), ROLE)))
checks.append(("\"pg_catalog\".\"set_config\"('role', …) still refused", refuses(scratch("n41e", 'select "pg_catalog"."set_config"(\'role\', \'authenticated\', false);\n'), ROLE)))
checks.append(("execute'd literal calling \"pg_catalog\".set_config still refused", refuses(scratch("n41f", 'do $$ begin execute \'select "pg_catalog".set_config(\'\'role\'\', \'\'authenticated\'\', false)\'; end $$;\n'), "does not read")))
checks.append(("bare pg_catalog.set_config('role', …) still refused", refuses(scratch("n41g", 'select pg_catalog.set_config(\'role\', \'authenticated\', false);\n'), ROLE)))
checks.append(("bare PG_CATALOG.set_config folds and is still refused", refuses(scratch("n41h", 'select PG_CATALOG.set_config(\'role\', \'authenticated\', false);\n'), ROLE)))
checks.append(("\"PG_CATALOG\".set_config is another schema (quoted keeps its case) and passes", unchanged(scratch("n41i", 'select "PG_CATALOG".set_config(\'role\', \'authenticated\', false);\n'))))
checks.append(("\"evil\".set_config still passes", unchanged(scratch("n41j", 'select "evil".set_config(\'role\', \'authenticated\', false);\n'))))
checks.append(("a qualifier ending in a doubled quote (\"evil\"\"\") passes", unchanged(scratch("n41k", 'select "evil""".set_config(\'role\', \'authenticated\', false);\n'))))
checks.append(("a qualifier beginning with a doubled quote (\"\"\"pg_catalog\") is not pg_catalog and passes", unchanged(scratch("n41l", 'select """pg_catalog".set_config(\'role\', \'authenticated\', false);\n'))))
checks.append(("two doubled pairs (\"a\"\"b\"\"c\") passes", unchanged(scratch("n41m", 'select "a""b""c".set_config(\'role\', \'authenticated\', false);\n'))))
checks.append(("unqualified set_config('role', …) still refused", refuses(scratch("n41n", 'select set_config(\'role\', \'authenticated\', false);\n'), ROLE)))
# --- round forty-two: the E'…' prefix uses the lexer's identifier boundary
r1 = "create domain foo$e as text;\nselect foo$e'x" + BS + "';\ncreate type public.ghost as enum ('x');\n"
d = scratch("r42a", r1)
checks.append(("foo$e'x\\' then create ghost: fixed catalogues ghost", run(d)[1].get("ghost") == ["x"]))
r2 = "create domain \"foo€e\" as text;\nselect foo€e'x" + BS + "';\ncreate type public.ghost as enum ('x');\n"
d = scratch("r42b", r2)
checks.append(("foo€e'x\\' then create ghost: fixed catalogues ghost", run(d)[1].get("ghost") == ["x"]))
checks.append(("fooe'x\\' (a letter before e) was never an E string: ghost catalogued", run(scratch("r42c", "create domain fooe as text;\nselect fooe'x" + BS + "';\ncreate type public.ghost as enum ('x');\n"))[1].get("ghost") == ["x"]))
checks.append(("_e'x\\' likewise", run(scratch("r42d", "create domain _e as text;\nselect _e'x" + BS + "';\ncreate type public.ghost as enum ('x');\n"))[1].get("ghost") == ["x"]))
checks.append(("a real E string with an escaped quote still ends where PostgreSQL ends it", run(scratch("r42e", "select e'x" + BS + "'y';\ncreate type public.ghost as enum ('x');\n"))[1].get("ghost") == ["x"]))
checks.append(("(e'x\\'y') — E after a parenthesis — likewise", run(scratch("r42f", "select (e'x" + BS + "'y');\ncreate type public.ghost as enum ('x');\n"))[1].get("ghost") == ["x"]))
checks.append(("upper-case E'…' likewise", run(scratch("r42g", "select E'x" + BS + "'y';\ncreate type public.ghost as enum ('x');\n"))[1].get("ghost") == ["x"]))
checks.append(("DDL inside a real E string stays a value (catalogue unchanged)", unchanged(scratch("r42h", "select E'x" + BS + "'; create type public.ghost as enum (''x'')';\n"))))
checks.append(("body: foo$e'x\\' then an EXECUTE'd create is still refused (the body rule)", refuses(scratch("r42i", "create domain foo$e as text;\ndo $$ begin perform foo$e'x" + BS + "'; execute 'create type public.ghost as enum (''x'')'; end $$;\n"), "does not read")))
checks.append(("a $e$ dollar tag is still a dollar quote, not an E string", unchanged(scratch("r42j", "comment on type payment_status is $e$has 'quotes' and a " + BS + " in it$e$;\n"))))
# --- round forty-three: the ALTER reader parses the head before the clause
SP = "moves search_path"; ROLE43 = "switches the current role"; SCS = "standard_conforming_strings off"
d = scratch("t43a", "alter role set set search_path = private;\n")
checks.append(("alter role set set search_path: fixed refuses", refuses(d, SP)))
d = scratch("t43b", "alter database set set search_path = private;\n")
checks.append(("alter database set set search_path: fixed refuses", refuses(d, SP)))
d = scratch("t43c", "alter role set in database d set role = authenticated;\n")
checks.append(("alter role set in database d set role: fixed refuses", refuses(d, ROLE43)))
d = scratch("t43d", "alter role set set standard_conforming_strings = off;\n")
checks.append(("alter role set set standard_conforming_strings = off: fixed refuses", refuses(d, SCS)))
checks.append(("alter user set set search_path refused", refuses(scratch("t43e", "alter user set set search_path = private;\n"), SP)))
checks.append(("alter role set reset search_path (a reset) allowed", unchanged(scratch("t43f", "alter role set reset search_path;\n"))))
checks.append(("alter role set set search_path to default (a reset) allowed", unchanged(scratch("t43g", "alter role set set search_path to default;\n"))))
checks.append(("alter role set set work_mem allowed", unchanged(scratch("t43h", "alter role set set work_mem = '4MB';\n"))))
checks.append(("alter role reset set search_path still refused (by design now, not first-match)", refuses(scratch("t43i", "alter role reset set search_path = private;\n"), SP)))
checks.append(("alter role reset reset search_path allowed", unchanged(scratch("t43j", "alter role reset reset search_path;\n"))))
checks.append(("alter role \"set\" set search_path still refused", refuses(scratch("t43k", 'alter role "set" set search_path = private;\n'), SP)))
checks.append(("alter role \"reset\" reset search_path allowed", unchanged(scratch("t43l", 'alter role "reset" reset search_path;\n'))))
checks.append(("in database d set search_path still refused", refuses(scratch("t43m", "alter role deploy in database d set search_path = private;\n"), SP)))
checks.append(("in database \"d\" set search_path refused", refuses(scratch("t43n", 'alter role deploy in database "d" set search_path = private;\n'), SP)))
checks.append(("in database d reset search_path allowed", unchanged(scratch("t43o", "alter role deploy in database d reset search_path;\n"))))
checks.append(("in database d set search_path to default allowed", unchanged(scratch("t43p", "alter role deploy in database d set search_path to default;\n"))))
checks.append(("alter role deploy set search_path still refused (control)", refuses(scratch("t43q", "alter role deploy set search_path = private;\n"), SP)))
checks.append(("alter role deploy set search_path from current still refused", refuses(scratch("t43r", "alter role deploy set search_path from current;\n"), SP)))
checks.append(("alter role all set search_path refused", refuses(scratch("t43s", "alter role all set search_path = private;\n"), SP)))
checks.append(("alter role current_user set search_path refused", refuses(scratch("t43t", "alter role current_user set search_path = private;\n"), SP)))
checks.append(("alter system set search_path still refused", refuses(scratch("t43u", "alter system set search_path = private;\n"), SP)))
checks.append(("alter system reset all allowed", unchanged(scratch("t43v", "alter system reset all;\n"))))
checks.append(("alter database x owner to y allowed", unchanged(scratch("t43w", "alter database x owner to y;\n"))))
checks.append(("alter user mapping for x server y options (…) allowed", unchanged(scratch("t43x", "alter user mapping for deploy server remote options (add user 'set');\n"))))
checks.append(("alter role set with password '…' allowed (the target is `set`, the clause is WITH)", unchanged(scratch("t43y", "alter role set with password 'set search_path = private';\n"))))
checks.append(("alter role deploy with password containing the phrase allowed", unchanged(scratch("t43z", "alter role deploy with password 'set search_path = private';\n"))))
checks.append(("an ALTER whose target cannot be read is refused by name", refuses(scratch("t43aa", "alter role 'set' set search_path = private;\n"), "target this generator cannot read")))
checks.append(("ALTER ROLE upper-case, role named SET, refused", refuses(scratch("t43ab", "ALTER ROLE SET SET SEARCH_PATH = private;\n"), SP)))
checks.append(("alter role set set \"search_path\" (quoted setting) refused", refuses(scratch("t43ac", 'alter role set set "search_path" = private;\n'), SP)))
checks.append(("alter role set set search_path.custom = 'v' (a custom setting) allowed", unchanged(scratch("t43ad", "alter role set set search_path.custom = 'v';\n"))))

TMP.cleanup()
failed = [n for n, ok in checks if not ok]
for n, ok in checks:
    print(("ok   " if ok else "FAIL ") + n)
print(f"{len(checks) - len(failed)} of {len(checks)} enum-catalogue proofs hold")
sys.exit(1 if failed else 0)
