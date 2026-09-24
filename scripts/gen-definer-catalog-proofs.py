#!/usr/bin/env python3
"""Probes for `gen-definer-catalog.py`: each writes one migration into a scratch
copy of the real set and asserts what the catalogue then says.

The generator stripped comments with a regex pair until the spec-drift audit,
and each probe below is a way that pair read the migrations wrong — proven by
running this file against the regex version, where they fail. It now shares
`gen-enum-catalog.py`'s SQL reader and scans its skeleton, and these keep that
true: a change that brings a naive stripper back, or scans the clean text
instead of the skeleton, fails here by name.

Run by gate 10a (validate.sh) and by CI's "Spec 03's definer catalogue
matches the migrations" step. A FAIL line names the probe.
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import pathlib
import re
import shutil
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
GENERATOR = ROOT / "scripts" / "gen-definer-catalog.py"
MIGRATIONS = ROOT / "supabase" / "migrations"


def load(path: pathlib.Path):
    spec = importlib.util.spec_from_file_location("gen_definer", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


try:
    gen = load(GENERATOR)
except Exception as e:  # noqa: BLE001 — the subject failing to import is the first thing to say
    print(f"FAIL: the generator could not be loaded: {type(e).__name__}: {e}", file=sys.stderr)
    sys.exit(1)

TMP = tempfile.TemporaryDirectory(prefix="definer-proofs-")
S = pathlib.Path(TMP.name)
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


def collect_with(probe_sql: str | None):
    """collect() over a scratch copy of the real migrations plus one probe."""
    d = S / f"run{len(failures) + passed}"
    shutil.copytree(MIGRATIONS, d)
    if probe_sql is not None:
        (d / f"{NEXT:04d}_probe.sql").write_text(probe_sql)
    gen.MIGRATIONS = d
    try:
        return gen.collect()
    finally:
        gen.MIGRATIONS = MIGRATIONS


# ── Control: the real tree renders the committed block ───────────────────
committed = re.search(re.escape(gen.BEGIN) + r".*?" + re.escape(gen.END), gen.SPEC.read_text(), re.S)
check("control: spec 03 has the generated block", committed is not None)
if committed:
    check(
        "control: the real migrations render the committed catalogue",
        gen.render(*collect_with(None)) == committed.group(0),
        "regenerate with scripts/gen-definer-catalog.py",
    )

FN = "create function public.{name}() returns void language sql {definer} set search_path = public as $$ select 1 $$;\n"

# ── A `--` inside a literal is not a comment ─────────────────────────────
# The regex pair cut the line at the `--` and the GRANT sharing it vanished.
definer, grants, _ = collect_with(
    FN.format(name="fn_probe_dash", definer="security definer")
    + "comment on function fn_probe_dash() is 'a -- b'; grant execute on function fn_probe_dash() to authenticated;\n"
)
check("a -- inside a literal keeps the grant on its line", "authenticated" in grants.get("fn_probe_dash", set()),
      f"granted to {sorted(grants.get('fn_probe_dash', set())) or 'nothing'}")

# ── A nested block comment ends where PostgreSQL ends it ──────────────────
# The regex stopped at the first `*/` and read the rest of the outer comment
# as code: a commented-out definer function was catalogued.
definer, grants, _ = collect_with(
    "/* retired: /* the old one */\n" + FN.format(name="fn_probe_ghost", definer="security definer") + "*/\n"
)
check("a nested block comment hides the function inside it", "fn_probe_ghost" not in definer)

# ── A `/*` inside a literal opens no comment ─────────────────────────────
# The regex read it as a comment that ran to the next `*/`, swallowing the
# statements in between.
definer, grants, _ = collect_with(
    FN.format(name="fn_probe_slash", definer="security definer")
    + "comment on function fn_probe_slash() is 'see /* the spec';\n"
    + "grant execute on function fn_probe_slash() to authenticated;\n"
    + "-- closes nothing: */\n"
)
check("a /* inside a literal swallows nothing", "authenticated" in grants.get("fn_probe_slash", set()),
      f"granted to {sorted(grants.get('fn_probe_slash', set())) or 'nothing'}")

# ── A literal is not code ─────────────────────────────────────────────────
# Scanning the clean text rather than the skeleton would read these strings
# as the options and statements they describe.
definer, grants, _ = collect_with(
    FN.format(name="fn_probe_plain", definer="")
    + "comment on function fn_probe_plain() is 'deliberately not security definer';\n"
    + "comment on function fn_probe_plain() is 'replaced by: create function fn_probe_phantom() returns void security definer';\n"
)
check("a comment saying 'security definer' makes no function a definer", definer.get("fn_probe_plain") is False,
      f"read as {definer.get('fn_probe_plain')}")
check("a literal saying 'create function' creates nothing", "fn_probe_phantom" not in definer)

# ── A quoted role is read as its name ─────────────────────────────────────
definer, grants, _ = collect_with(
    FN.format(name="fn_probe_quoted", definer="security definer")
    + 'grant execute on function fn_probe_quoted() to "authenticated";\n'
)
check('a quoted role is read as its name', "authenticated" in grants.get("fn_probe_quoted", set()),
      f"granted to {sorted(grants.get('fn_probe_quoted', set())) or 'nothing'}")

# ── A role is read as PostgreSQL resolves it (Codex, on #97) ──────────────
# An unquoted name folds to lower case, so `TO PUBLIC` and `TO Anon` grant
# exactly `public` and `anon` (measured). A quoted name is exact, doubled
# quotes read as one, and a comma inside one separates nothing: `"PUBLIC"` is
# not the PUBLIC pseudo-role (PostgreSQL refuses it as a role that does not
# exist). Stored as written, `PUBLIC` rendered as **none** and passed the
# invariant-5 check.
# A refusal here is a reading gone wrong (a quoted name split at its comma
# reads as an unreadable fragment), so it is reported as a named failure and
# every check below fails with it, rather than ending the run as a traceback.
err = io.StringIO()
try:
    with contextlib.redirect_stderr(err):
        definer, grants, order = collect_with(
            FN.format(name="fn_probe_upper", definer="security definer")
            + "grant execute on function fn_probe_upper() to PUBLIC;\n"
            + FN.format(name="fn_probe_mixed", definer="security definer")
            + "grant execute on function fn_probe_mixed() to Anon;\n"
            + FN.format(name="fn_probe_qpublic", definer="security definer")
            + 'grant execute on function fn_probe_qpublic() to "public";\n'
            + FN.format(name="fn_probe_exact", definer="security definer")
            + 'grant execute on function fn_probe_exact() to "PUBLIC", "we""ird", "a,b";\n'
        )
except SystemExit:
    definer, grants, order = {}, {}, []
check("the role probes are read, not refused", bool(order), err.getvalue().strip()[:160])
for name, want in (("fn_probe_upper", {"public"}), ("fn_probe_mixed", {"anon"}), ("fn_probe_qpublic", {"public"}),
                   ("fn_probe_exact", {"PUBLIC", 'we"ird', "a,b"})):
    check(f"{name} is granted to {sorted(want)}", grants.get(name) == want,
          f"read as {sorted(grants.get(name, set()))}")
check("a definer function granted TO PUBLIC renders public, not none",
      "| `fn_probe_upper` | `public` |" in gen.render(definer, grants, order))
exposed = getattr(gen, "exposed", None)
check("the invariant-5 check names the definer functions TO PUBLIC and TO Anon expose",
      callable(exposed) and {"fn_probe_upper", "fn_probe_mixed", "fn_probe_qpublic"} <= set(exposed(definer, grants, order))
      and "fn_probe_exact" not in exposed(definer, grants, order),
      "no exposed()" if not callable(exposed) else f"named {sorted(exposed(definer, grants, order))}")

# ── A grantee the reader cannot read is refused, not read as some role ────
# `GROUP` is noise PostgreSQL accepts and `WITH GRANT OPTION` is a clause, so
# each read as a role no check recognises; the ACL reader that replaces this
# one refuses both, and so does this one.
for label, tail in (("GROUP", "to group anon"), ("WITH GRANT OPTION", "to anon with grant option")):
    err = io.StringIO()
    code = None
    with contextlib.redirect_stderr(err):
        try:
            collect_with(FN.format(name="fn_probe_refused", definer="security definer")
                         + f"grant execute on function fn_probe_refused() {tail};\n")
        except SystemExit as e:
            code = e.code
    check(f"a grantee with {label} is refused by name",
          code == 1 and "grantee" in err.getvalue() and f"{NEXT:04d}_probe.sql" in err.getvalue(),
          f"exit {code}, stderr {err.getvalue().strip()[:120]!r}")

# ── A migration the shared reader refuses is a named FAIL, not a traceback ─
err = io.StringIO()
code = None
with contextlib.redirect_stderr(err):
    try:
        collect_with('do $$ begin perform 1 from U&"clients"; end $$;\n')
    except SystemExit as e:
        code = e.code
check("a refused migration exits 1 with a sentence naming the file",
      code == 1 and f"{NEXT:04d}_probe.sql" in err.getvalue() and "refused" in err.getvalue(),
      f"exit {code}, stderr {err.getvalue().strip()[:120]!r}")


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

total = passed + len(failures)
for f in failures:
    print(f"FAIL: {f}", file=sys.stderr)
if failures:
    print(f"{passed}/{total} definer-catalogue probes passed", file=sys.stderr)
    sys.exit(1)
print(f"DEFINER CATALOGUE PROOFS PASS: {passed}/{total}")
