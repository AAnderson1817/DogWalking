#!/usr/bin/env python3
"""Probes for `gen-definer-catalog.py`: each writes one migration into a scratch
copy of the real set and asserts what the catalogue then says.

Two families. The first is each way the generator's old regex comment stripper
read the migrations wrong (spec-drift audit, PR A) — proven by running this
file against that version, where they fail. It now shares
`gen-enum-catalog.py`'s SQL reader and scans its skeleton, and these keep that
true: a change that brings a naive stripper back, or scans the clean text
instead of the skeleton, fails here by name.

The second is the ACL model (PR B). The generator used to collect GRANTs and
render **none** for any function nobody granted — four trigger functions that
PUBLIC and anon could execute among them. It now starts every function at the
platform default and applies CREATE, CREATE OR REPLACE, DROP, GRANT and REVOKE
in order, keyed by name and argument types, and refuses what it cannot read.
Each probe below is a rule of that model; gate 8e holds the whole model to a
live database.

The third family is PR B's own review, which read that model the way the audit
had read the regex: healthy SQL it misread, and statements that change a
function without naming it. A CREATE with unnamed arguments was refused; a
type PostgreSQL prints one way was spelt another (`float`, `dec`, `nchar`,
`interval day`, `int[3]`, `pg_catalog.char`); a default with a comma inside
brackets split one argument in two; a DROP … CASCADE on a type or a schema
dropped functions the model kept; and `revoke … from public, anon` — the
pattern spec 03 used to teach — leaves `authenticated` holding the platform
default, which the model now refuses by name. Each is below, and `main()` is
driven for the two refusals, so a check that is computed and never consulted
fails here too.

Every probe group runs inside `probe()`: a group that RAISES is one failed
proof carrying its title and the exception, and the groups after it still
run. Run against the grant-collecting generator this replaced, the first
version of this file died on a TypeError at the control and said nothing
about the thirty-seven probes behind it — a broken harness reading as a
broken rule, which the enum proofs had already paid for (PR #90).

Run by gate 10a (validate.sh) and by CI's "Spec 03's definer catalogue
matches the migrations" step. A FAIL line names the probe.
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import itertools
import pathlib
import re
import shutil
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
GENERATOR = ROOT / "scripts" / "gen-definer-catalog.py"
MIGRATIONS = ROOT / "supabase" / "migrations"
SHIM = ROOT / "scripts" / "local-stack" / "shim.sql"


def load(path: pathlib.Path):
    spec = importlib.util.spec_from_file_location("gen_definer", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


try:
    gen = load(GENERATOR)
except BaseException as e:  # noqa: BLE001 — the subject failing to import is the first thing to say
    print(f"FAIL: the generator could not be loaded: {type(e).__name__}: {e}", file=sys.stderr)
    sys.exit(1)

TMP = tempfile.TemporaryDirectory(prefix="definer-proofs-")
S = pathlib.Path(TMP.name)
RUNS = itertools.count()
# The probe sorts after the highest real migration, whatever that is — a
# hard-coded number is overtaken by the next real migration (the enum proofs
# learnt this on PR #90).
NEXT = max(int(p.name[:4]) for p in MIGRATIONS.glob("*.sql") if p.name[:4].isdigit()) + 1

failures: list[str] = []
passed = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global passed
    if ok:
        passed += 1
    else:
        failures.append(f"{label}{': ' + detail if detail else ''}")


@contextlib.contextmanager
def probe(title: str):
    """One probe group. An exception inside it — the generator's interface
    changed, a probe it refused unexpectedly — is a failed proof named after
    the group, and the next group runs."""
    try:
        yield
    except SystemExit as e:
        failures.append(f"{title} — the generator exited {e.code} (its own FAIL line is above)")
    except Exception as e:  # noqa: BLE001 — any exception is a failed proof
        failures.append(f"{title} — raised {type(e).__name__}: {e}")


def collect_with(probe_sql: str | None):
    """collect() over a scratch copy of the real migrations plus one probe."""
    d = S / f"run{next(RUNS)}"
    shutil.copytree(MIGRATIONS, d)
    if probe_sql is not None:
        (d / f"{NEXT:04d}_probe.sql").write_text(probe_sql)
    gen.MIGRATIONS = d
    try:
        return gen.collect()
    finally:
        gen.MIGRATIONS = MIGRATIONS


def refused(probe_sql: str) -> tuple[int | None, str]:
    """(exit code, stderr) of collect() over the real set plus a probe the
    generator is expected to refuse."""
    err = io.StringIO()
    code = None
    with contextlib.redirect_stderr(err):
        try:
            collect_with(probe_sql)
        except SystemExit as e:
            code = e.code
    return code, err.getvalue()


def held(model, name: str, *types: str) -> list[str]:
    key = (name, tuple(types))
    return gen.api_roles(model, key) if key in model.funcs else ["<absent>"]


FN = "create function public.{name}({args}) returns void language sql {definer} set search_path = public as $$ select 1 $$;\n"
REVOKE_ALL = "revoke all on function {name}({types}) from public, anon, authenticated;\n"


def fn(name: str, args: str = "", types: str = "", definer: str = "security definer", revoke: bool = True) -> str:
    out = FN.format(name=name, args=args, definer=definer)
    return out + (REVOKE_ALL.format(name=name, types=types) if revoke else "")


# ── Control: the real tree renders the committed block ───────────────────
with probe("control"):
    committed = re.search(re.escape(gen.BEGIN) + r".*?" + re.escape(gen.END), gen.SPEC.read_text(), re.S)
    check("control: spec 03 has the generated block", committed is not None)
    real = collect_with(None)
    if committed:
        check(
            "control: the real migrations render the committed catalogue",
            gen.render(real) == committed.group(0),
            "regenerate with scripts/gen-definer-catalog.py",
        )
    check("control: no definer function in the real migrations is executable by PUBLIC or anon",
          gen.open_to_anon(real) == [], f"{gen.open_to_anon(real)}")

# What a new function starts with is the platform's default, and the shim is
# where this repository models the platform: the two must say the same.
with probe("the default ACL"):
    shim_roles = set()
    for m in re.finditer(r"alter\s+default\s+privileges\s+in\s+schema\s+public\s+grant\s+all\s+on\s+functions"
                         r"\s+to\s+([^;]+);", SHIM.read_text(), re.I):
        shim_roles |= {r.strip().lower() for r in m.group(1).split(",")}
    check("the default ACL is PUBLIC plus what the shim's default privileges grant on functions",
          bool(shim_roles) and gen.DEFAULT_ACL == frozenset(shim_roles | {"public"}),
          f"shim grants {sorted(shim_roles) or 'nothing it could read'}, the model starts at {sorted(gen.DEFAULT_ACL)}")


# ═══ The reader: each way the regex stripper misread a migration ══════════

# ── A `--` inside a literal is not a comment ─────────────────────────────
# The regex pair cut the line at the `--` and the GRANT sharing it vanished.
with probe("a -- inside a literal"):
    model = collect_with(
        fn("fn_probe_dash")
        + "comment on function fn_probe_dash() is 'a -- b'; grant execute on function fn_probe_dash() to authenticated;\n"
    )
    check("a -- inside a literal keeps the grant on its line", held(model, "fn_probe_dash") == ["authenticated"],
          f"held by {held(model, 'fn_probe_dash')}")

# ── A nested block comment ends where PostgreSQL ends it ──────────────────
# The regex stopped at the first `*/` and read the rest of the outer comment
# as code: a commented-out definer function was catalogued.
with probe("a nested block comment"):
    model = collect_with("/* retired: /* the old one */\n" + fn("fn_probe_ghost") + "*/\n")
    check("a nested block comment hides the function inside it", ("fn_probe_ghost", ()) not in model.funcs)

# ── A `/*` inside a literal opens no comment ─────────────────────────────
# The regex read it as a comment that ran to the next `*/`, swallowing the
# statements in between.
with probe("a /* inside a literal"):
    model = collect_with(
        fn("fn_probe_slash")
        + "comment on function fn_probe_slash() is 'see /* the spec';\n"
        + "grant execute on function fn_probe_slash() to authenticated;\n"
        + "-- closes nothing: */\n"
    )
    check("a /* inside a literal swallows nothing", held(model, "fn_probe_slash") == ["authenticated"],
          f"held by {held(model, 'fn_probe_slash')}")

# ── A literal is not code ─────────────────────────────────────────────────
# Scanning the clean text rather than the skeleton would read these strings
# as the options and statements they describe.
with probe("a literal is not code"):
    model = collect_with(
        fn("fn_probe_plain", definer="")
        + "comment on function fn_probe_plain() is 'deliberately not security definer';\n"
        + "comment on function fn_probe_plain() is 'replaced by: create function fn_probe_phantom() returns void security definer';\n"
    )
    entry = model.funcs.get(("fn_probe_plain", ()))
    check("a comment saying 'security definer' makes no function a definer",
          entry is not None and entry["definer"] is False, f"read as {entry}")
    check("a literal saying 'create function' creates nothing", ("fn_probe_phantom", ()) not in model.funcs)
with probe("a default that says security definer"):
    model = collect_with("create function public.fn_probe_dflt(p text default 'security definer') returns void"
                         " language sql set search_path = public as $$ select 1 $$;\n")
    entry = model.funcs.get(("fn_probe_dflt", ("text",)))
    check("a parameter default saying 'security definer' makes no function a definer",
          entry is not None and entry["definer"] is False, f"read as {entry}")
with probe("a semicolon inside a literal"):
    model = collect_with(
        fn("fn_probe_semi")
        + "comment on function fn_probe_semi() is 'x; grant execute on function fn_probe_semi() to anon; y';\n"
    )
    check("a ; inside a literal ends no statement, and the grant it quotes is not made",
          held(model, "fn_probe_semi") == [], f"held by {held(model, 'fn_probe_semi')}")

# ── A quoted role is read as its name ─────────────────────────────────────
with probe("a quoted role"):
    model = collect_with(fn("fn_probe_quoted") + 'grant execute on function fn_probe_quoted() to "authenticated";\n')
    check("a quoted role is read as its name", held(model, "fn_probe_quoted") == ["authenticated"],
          f"held by {held(model, 'fn_probe_quoted')}")

# ── A migration the shared reader refuses is a named FAIL, not a traceback ─
with probe("a refused migration"):
    code, err = refused('do $$ begin perform 1 from U&"clients"; end $$;\n')
    check("a refused migration exits 1 with a sentence naming the file",
          code == 1 and f"{NEXT:04d}_probe.sql" in err and "refused" in err,
          f"exit {code}, stderr {err.strip()[:120]!r}")

# ═══ The ACL model ════════════════════════════════════════════════════════

# ── A function nobody grants is not a function nobody can call ────────────
# The defect this model exists for: reading only GRANTs, four trigger
# functions that PUBLIC and anon could execute were catalogued as none.
with probe("a function never revoked"):
    model = collect_with(fn("fn_probe_open", revoke=False))
    check("a definer function never revoked is held by PUBLIC, anon and authenticated",
          held(model, "fn_probe_open") == ["public", "anon", "authenticated"],
          f"held by {held(model, 'fn_probe_open')}")
    check("... and the generator refuses it, by name",
          any(f.startswith("fn_probe_open(") for f, _ in gen.open_to_anon(model)), f"{gen.open_to_anon(model)}")
    check("... and the catalogue shows PUBLIC, not none",
          "| `fn_probe_open` | `PUBLIC`, `anon`, `authenticated` |" in gen.render(model))

# ── REVOKE FROM PUBLIC leaves the roles the default privileges named ───────
with probe("revoking only PUBLIC"):
    model = collect_with(fn("fn_probe_half", revoke=False) + "revoke all on function fn_probe_half() from public;\n")
    check("revoking only PUBLIC leaves anon and authenticated holding their own grant",
          held(model, "fn_probe_half") == ["anon", "authenticated"], f"held by {held(model, 'fn_probe_half')}")
with probe("the house pattern"):
    model = collect_with(fn("fn_probe_rpc", revoke=False) + "revoke all on function fn_probe_rpc() from public, anon;\n")
    check("the house pattern (revoke public, anon) leaves authenticated from the default",
          held(model, "fn_probe_rpc") == ["authenticated"]
          and not any(f.startswith("fn_probe_rpc(") for f, _ in gen.open_to_anon(model)),
          f"held by {held(model, 'fn_probe_rpc')}")

# ── Order: a GRANT after a REVOKE, and a REVOKE after a GRANT ─────────────
with probe("a grant after a revoke"):
    model = collect_with(fn("fn_probe_regrant") + "grant execute on function fn_probe_regrant() to anon;\n")
    check("a grant after the revoke is held", held(model, "fn_probe_regrant") == ["anon"],
          f"held by {held(model, 'fn_probe_regrant')}")
with probe("a revoke after a grant"):
    model = collect_with(
        fn("fn_probe_order", revoke=False)
        + "grant execute on function fn_probe_order() to authenticated;\n"
        + "revoke execute on function fn_probe_order() from public, anon, authenticated;\n"
    )
    check("a revoke after a grant takes it away", held(model, "fn_probe_order") == [],
          f"held by {held(model, 'fn_probe_order')}")

# ── PUBLIC alone is open to anon ──────────────────────────────────────────
with probe("PUBLIC alone"):
    model = collect_with(fn("fn_probe_pub", revoke=False) + "revoke all on function fn_probe_pub() from anon, authenticated;\n")
    check("a function only PUBLIC holds is refused: anon is a member of PUBLIC",
          held(model, "fn_probe_pub") == ["public"]
          and any(f.startswith("fn_probe_pub(") for f, _ in gen.open_to_anon(model)),
          f"held by {held(model, 'fn_probe_pub')}, refused {gen.open_to_anon(model)}")

# ── authenticated by the platform default alone ──────────────────────────
# `revoke … from public, anon` was the pattern spec 03 taught. It leaves
# authenticated holding EXECUTE with no GRANT behind it: a function meant for
# the service role, callable by every signed-in user, with every other check
# green (PR B review).
with probe("authenticated by the default alone"):
    model = collect_with(fn("fn_probe_implicit", revoke=False) + "revoke all on function fn_probe_implicit() from public, anon;\n")
    check("authenticated holding a definer function only by the platform default is refused",
          "fn_probe_implicit()" in gen.default_only(model), f"{gen.default_only(model)}")
    model = collect_with(fn("fn_probe_explicit") + "grant execute on function fn_probe_explicit() to authenticated;\n")
    check("... and an explicit grant after the full revoke is not",
          held(model, "fn_probe_explicit") == ["authenticated"] and "fn_probe_explicit()" not in gen.default_only(model),
          f"held by {held(model, 'fn_probe_explicit')}, refused {gen.default_only(model)}")
    model = collect_with(fn("fn_probe_ontop", revoke=False) + "revoke all on function fn_probe_ontop() from public, anon;\n"
                         + "grant execute on function fn_probe_ontop() to authenticated;\n")
    check("... nor a grant to authenticated on top of the default", "fn_probe_ontop()" not in gen.default_only(model),
          f"{gen.default_only(model)}")
    model = collect_with(fn("fn_probe_dropped", revoke=False) + "grant execute on function fn_probe_dropped() to authenticated;\n"
                         + "revoke all on function fn_probe_dropped() from public, anon, authenticated;\n"
                         + "drop function fn_probe_dropped();\n" + fn("fn_probe_dropped", revoke=False)
                         + "revoke all on function fn_probe_dropped() from public, anon;\n")
    check("... and a grant to an earlier function of the same signature does not survive its drop",
          "fn_probe_dropped()" in gen.default_only(model), f"{gen.default_only(model)}")
    model = collect_with(fn("fn_probe_invoker", definer="", revoke=False) + "revoke all on function fn_probe_invoker() from public, anon;\n")
    check("... and an invoker function is no definer function", "fn_probe_invoker()" not in gen.default_only(model),
          f"{gen.default_only(model)}")


def run_main(probe_sql: str | None) -> tuple[int | None, str]:
    """main() over the real migrations plus one probe, writing a copy of the
    spec rather than the real one. -> (exit code, stdout + stderr)."""
    d = S / f"run{next(RUNS)}"
    shutil.copytree(MIGRATIONS, d)
    if probe_sql is not None:
        (d / f"{NEXT:04d}_probe.sql").write_text(probe_sql)
    spec = S / f"spec{next(RUNS)}.md"
    shutil.copyfile(gen.SPEC, spec)
    saved = gen.MIGRATIONS, gen.SPEC
    gen.MIGRATIONS, gen.SPEC = d, spec
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            code = gen.main()
    finally:
        gen.MIGRATIONS, gen.SPEC = saved
    return code, out.getvalue()


# A refusal computed and never consulted is no refusal: main() is what CI
# runs, so each check is driven through it.
with probe("main() on the real tree"):
    code, out = run_main(None)
    check("main() passes on the real migrations", code == 0, f"exit {code}: {out.strip()[:160]!r}")
with probe("main() refuses a definer function PUBLIC holds"):
    code, out = run_main(fn("fn_probe_mainopen", revoke=False))
    check("main() exits 1 naming a definer function PUBLIC and anon can execute",
          code == 1 and "fn_probe_mainopen()" in out and "PUBLIC or anon" in out, f"exit {code}: {out.strip()[-200:]!r}")
with probe("main() refuses the default-only leftover"):
    code, out = run_main(fn("fn_probe_mainimplicit", revoke=False)
                         + "revoke all on function fn_probe_mainimplicit() from public, anon;\n")
    check("main() exits 1 naming a definer function authenticated holds only by the default",
          code == 1 and "fn_probe_mainimplicit()" in out and "default privileges" in out,
          f"exit {code}: {out.strip()[-200:]!r}")

# ── DROP IF EXISTS: a signature it does not know ─────────────────────────
# A no-op, or a type this model spells differently from PostgreSQL — then the
# database drops the function the model keeps. It cannot tell, so it refuses.
with probe("drop if exists: an unknown signature of a known name"):
    code, err = refused(fn("fn_probe_amb", "p_a uuid", "uuid") + "drop function if exists fn_probe_amb(text);\n")
    check("refuses DROP IF EXISTS of a signature it does not know while the name exists with another",
          code == 1 and "a signature it does not know" in err, f"exit {code}, stderr {err.strip()[:160]!r}")
with probe("drop if exists: an unknown name"):
    model = collect_with("drop function if exists fn_probe_never(uuid);\n")
    check("... while DROP IF EXISTS of a name nothing created is the no-op it is",
          not any(name == "fn_probe_never" for name, _ in model.funcs))

# ── CREATE OR REPLACE keeps the ACL; DROP and CREATE reset it ─────────────
with probe("create or replace"):
    model = collect_with(fn("fn_probe_keep") + FN.format(name="fn_probe_keep", args="", definer="security definer")
                         .replace("create function", "create or replace function"))
    check("create or replace of the same signature keeps its revokes", held(model, "fn_probe_keep") == [],
          f"held by {held(model, 'fn_probe_keep')}")
with probe("drop and create"):
    model = collect_with(fn("fn_probe_reset") + "drop function fn_probe_reset();\n" + fn("fn_probe_reset", revoke=False))
    check("drop and create starts again at the default",
          held(model, "fn_probe_reset") == ["public", "anon", "authenticated"],
          f"held by {held(model, 'fn_probe_reset')}")

# ── A function is its name AND its argument types ─────────────────────────
# 0026's shape: a new overload, then the old one dropped. A name-keyed model
# keeps the old revokes for the new function, and then loses the function.
with probe("a new overload"):
    model = collect_with(
        fn("fn_probe_sig", "p_a uuid", "uuid")
        + FN.format(name="fn_probe_sig", args="p_a uuid, p_b boolean", definer="security definer")
          .replace("create function", "create or replace function")
        + "drop function if exists fn_probe_sig(uuid);\n"
    )
    check("a new overload starts at the default, whatever the old one's revokes",
          held(model, "fn_probe_sig", "uuid", "boolean") == ["public", "anon", "authenticated"],
          f"held by {held(model, 'fn_probe_sig', 'uuid', 'boolean')}")
    check("dropping the old overload leaves the new one", ("fn_probe_sig", ("uuid",)) not in model.funcs
          and ("fn_probe_sig", ("uuid", "boolean")) in model.funcs)

# ── One type, several spellings ───────────────────────────────────────────
with probe("type aliases"):
    model = collect_with(fn("fn_probe_alias", "p_n int, p_t time, p_f bool, p_u uuid[]",
                            "integer, time without time zone, boolean, uuid[]"))
    check("int/integer, time, bool and an array match across CREATE and REVOKE",
          held(model, "fn_probe_alias", "integer", "time without time zone", "boolean", "uuid[]") == [],
          f"held by {held(model, 'fn_probe_alias', 'integer', 'time without time zone', 'boolean', 'uuid[]')}")
with probe("multi-word types"):
    model = collect_with(fn("fn_probe_words", "p_d double precision, p_t timestamp(3) with time zone, p_v varchar(20)[]",
                            "float8, timestamptz, character varying[]"))
    check("a multi-word type, a typmod and an array match their short spellings",
          held(model, "fn_probe_words", "double precision", "timestamp with time zone", "character varying[]") == [],
          f"held by {held(model, 'fn_probe_words', 'double precision', 'timestamp with time zone', 'character varying[]')}")
with probe("a default"):
    model = collect_with(fn("fn_probe_default", "p_n int default 5, p_s text = 'a,b'", "int, text"))
    check("a default — with a comma inside a literal — is not part of the signature",
          held(model, "fn_probe_default", "integer", "text") == [],
          f"held by {held(model, 'fn_probe_default', 'integer', 'text')}")
with probe("unnamed arguments"):
    model = collect_with(fn("fn_probe_unnamed", "uuid, int", "uuid, integer"))
    check("a CREATE with unnamed arguments is read, as PostgreSQL reads it",
          held(model, "fn_probe_unnamed", "uuid", "integer") == [],
          f"held by {held(model, 'fn_probe_unnamed', 'uuid', 'integer')}")
with probe("type keywords"):
    model = collect_with(fn("fn_probe_kw", "interval day, double precision, p_i interval hour to minute",
                            "interval, float8, interval"))
    check("an argument that starts with a type keyword is all type, and an interval's fields are dropped",
          held(model, "fn_probe_kw", "interval", "double precision", "interval") == [],
          f"held by {held(model, 'fn_probe_kw', 'interval', 'double precision', 'interval')}")
with probe("a default with brackets"):
    model = collect_with(fn("fn_probe_arr", "p_a int[] default array[1, 2], p_b text", "int[], text"))
    check("a default with a comma inside brackets is one argument",
          held(model, "fn_probe_arr", "integer[]", "text") == [],
          f"held by {held(model, 'fn_probe_arr', 'integer[]', 'text')}")
with probe("the spellings format_type folds"):
    # Each pair measured against `format_type` on a database: float, float(p)
    # either side of 24 bits, dec, nchar, national, every array spelling, and
    # the one-byte internal "char".
    spelt = ("double precision", "real", "double precision", "numeric", "integer[]", "integer[]",
             "integer[]", '"char"', "character varying", "character")
    model = collect_with(fn(
        "fn_probe_spell",
        "p_a float, p_b float(10), p_c float(30), p_d dec, p_e int[][], p_f int[3], p_g integer array[4],"
        " p_h pg_catalog.char, p_i national character varying, p_j nchar",
        "float8, float4, double precision, numeric, int[], int[], int[], pg_catalog.char, varchar, char",
    ))
    check("every spelling of one type reads as the type format_type prints",
          held(model, "fn_probe_spell", *spelt) == [], f"held by {held(model, 'fn_probe_spell', *spelt)}")

# ── Two functions in one statement, and the grammar's other spellings ─────
with probe("two functions in one statement"):
    model = collect_with(
        fn("fn_probe_pair_a", revoke=False) + fn("fn_probe_pair_b", revoke=False)
        + "revoke all privileges on function public.fn_probe_pair_a(), fn_probe_pair_b() from public, anon, authenticated cascade;\n"
    )
    check("one REVOKE naming two functions, ALL PRIVILEGES, a schema and CASCADE",
          held(model, "fn_probe_pair_a") == [] and held(model, "fn_probe_pair_b") == [],
          f"held by {held(model, 'fn_probe_pair_a')} and {held(model, 'fn_probe_pair_b')}")

# ── What it cannot read, it refuses by name ───────────────────────────────
for label, sql, needle in (
    ("a grant on ALL FUNCTIONS IN SCHEMA", "grant execute on all functions in schema public to anon;\n", "shape"),
    ("ALTER DEFAULT PRIVILEGES", "alter default privileges in schema public grant execute on functions to anon;\n",
     "DEFAULT PRIVILEGES"),
    ("REVOKE GRANT OPTION FOR", fn("fn_probe_opt") + "revoke grant option for execute on function fn_probe_opt() from anon;\n",
     "shape"),
    ("WITH GRANT OPTION", fn("fn_probe_wgo") + "grant execute on function fn_probe_wgo() to anon with grant option;\n",
     "GRANT OPTION"),
    ("ALTER FUNCTION", fn("fn_probe_alter") + "alter function fn_probe_alter() owner to postgres;\n", "ALTER FUNCTION"),
    ("a procedure", "create procedure public.pr_probe() language sql as $$ select 1 $$;\n", "procedure"),
    ("a %TYPE reference", fn("fn_probe_ref", "p_x walks.id%type", "uuid"), "cannot read"),
    ("a parameter mode", fn("fn_probe_out", "out p_x int", "int"), "mode"),
    ("a function outside public", "create function private.fn_probe_elsewhere() returns void language sql as $$ select 1 $$;\n",
     "schema private"),
    ("a grant with no argument list", fn("fn_probe_bare") + "grant execute on function fn_probe_bare to anon;\n",
     "without an argument list"),
    ("a revoke naming a signature nobody created",
     fn("fn_probe_nosig") + "revoke all on function fn_probe_nosig(uuid) from public;\n", "no earlier migration creates"),
    ("a role only known at run time", fn("fn_probe_cu") + "grant execute on function fn_probe_cu() to current_user;\n",
     "run time"),
    ("a DROP naming a signature nobody created",
     fn("fn_probe_dropnone") + "drop function fn_probe_dropnone(uuid);\n", "no earlier migration creates"),
    ("a DROP TYPE … CASCADE", "drop type if exists probe_t cascade;\n", "CASCADE"),
    ("a DROP SCHEMA … CASCADE", "drop schema if exists probe_s cascade;\n", "CASCADE"),
    ("a DROP TABLE … CASCADE", "drop table if exists probe_tbl cascade;\n", "CASCADE"),
    ("a DROP OWNED … CASCADE", "drop owned by probe_role cascade;\n", "CASCADE"),
    ("a range type", "create type probe_r as range (subtype = int4);\n", "range type"),
):
    with probe(f"refuses {label}"):
        code, err = refused(sql)
        check(f"refuses {label}, naming the file", code == 1 and f"{NEXT:04d}_probe.sql" in err and needle in err,
              f"exit {code}, stderr {err.strip()[:160]!r}")


# ── Routine DDL inside a body is refused, not blanked (Codex, on #97) ─────
# The reader blanks every DO and routine body, so a function created and
# granted by dynamic SQL inside one was invisible here: the migration
# installed a publicly executable definer function while this catalogue and
# its invariant-5 check stayed green. A body may not create, alter or drop a
# routine, nor grant or revoke on one; a table grant in a body (0004's loop)
# is none of these, and is read. Each alternative of the rule has a probe
# only it refuses, so dropping one goes red here by name.
def collect_code(sql: str) -> tuple[int | None, str]:
    err = io.StringIO()
    code = None
    with contextlib.redirect_stderr(err):
        try:
            collect_with(sql)
        except SystemExit as e:
            code = e.code
    return code, err.getvalue()


for label, sql, *needle in (
    ("a DO block that creates and grants a definer function (Codex's case)",
     "do $$ begin\n"
     "  execute 'create function public.fn_probe_dyn() returns void language sql security definer as ''select 1''';\n"
     "  execute 'grant execute on function public.fn_probe_dyn() to public';\n"
     "end $$;\n"),
    ("a function body that creates a function when called",
     "create function public.fn_probe_maker() returns void language plpgsql set search_path = public as $$\n"
     "begin execute 'create or replace function public.fn_probe_made() returns void language sql "
     "security definer as ''select 1'''; end $$;\n"),
    ("a DO block that creates a definer procedure",
     "do $$ begin execute 'create procedure public.pr_probe() language sql security definer as ''select 1'''; end $$;\n"),
    ("a DO block that makes a function a definer",
     "do $$ begin execute 'alter function public.fn_walk_cost(uuid) security definer'; end $$;\n"),
    ("a DO block that alters a routine",
     "do $$ begin execute 'alter routine public.fn_walk_cost(uuid) security definer'; end $$;\n"),
    ("a DO block that drops a function",
     "do $$ begin execute 'drop function public.fn_job_health()'; end $$;\n"),
    ("a DO block that grants on a function through format()",
     "do $$ begin execute format('grant execute on function %s to anon', 'public.fn_book_walk(uuid)'); end $$;\n"),
    ("a DO block that grants on a procedure as static SQL, not through EXECUTE",
     "do $$ begin grant execute on procedure public.pr_probe() to anon; end $$;\n"),
    ("a DO block that revokes on every function",
     "do $$ begin execute 'revoke all on all functions in schema public from service_role'; end $$;\n"),
    ("a DO block that alters default privileges on functions",
     "do $$ begin execute 'alter default privileges in schema public grant execute on functions to anon'; end $$;\n"),
    # A comment inside the EXECUTE'd literal hides the phrase from the body's
    # clean text, which keeps a literal whole; the command, read as SQL of its
    # own, does not.
    ("a comment inside an EXECUTE'd grant",
     "do $$ begin execute 'grant execute on /*x*/ function public.fn_book_walk(uuid) to anon'; end $$;\n",
     "EXECUTE'd command"),
):
    code, err = collect_code(sql)
    check(f"{label} is refused by name",
          code == 1 and f"{NEXT:04d}_probe.sql" in err and "refused" in err
          and (needle[0] if needle else "in a body") in err,
          f"exit {code}, stderr {err.strip()[:160]!r}")
for label, sql in (
    ("a dynamic table grant in a body is read, not refused",
     "do $$ begin execute format('grant select on table %I to service_role', 'clients'); end $$;\n"),
    # A word that merely CONTAINS one of the rule's words is not that word,
    # even in the same statement: `can_revoke` fails the boundary before
    # `revoke`, `revoked` the one after it, `salon` the one before `on`, and
    # `functionality` the one after `function`.
    ("a body whose words merely contain grant, revoke, on or function is read, not refused",
     "do $$ begin raise notice 'can_revoke on function calls, revoked on function calls, "
     "grant access to the salon functions, and grant access on functionality'; end $$;\n"),
):
    code, err = collect_code(sql)
    check(label, code is None, f"exit {code}, stderr {err.strip()[:160]!r}")

# ── … and not the same statements without the part that decides it ──────
with probe("a drop without CASCADE, and a type that is no range"):
    model = collect_with(
        "drop type if exists probe_t;\ndrop table if exists probe_tbl restrict;\n"
        "create type probe_e as enum ('as range');\ncreate type probe_c as (a int);\n"
    )
    check("a DROP without CASCADE, an enum and a composite type are read without refusal",
          gen.render(model) == gen.render(collect_with(None)))

total = passed + len(failures)
for f in failures:
    print(f"FAIL: {f}", file=sys.stderr)
if failures:
    print(f"{passed}/{total} definer-catalogue probes passed", file=sys.stderr)
    sys.exit(1)
print(f"DEFINER CATALOGUE PROOFS PASS: {passed}/{total}")
