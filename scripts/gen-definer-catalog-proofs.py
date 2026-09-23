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

total = passed + len(failures)
for f in failures:
    print(f"FAIL: {f}", file=sys.stderr)
if failures:
    print(f"{passed}/{total} definer-catalogue probes passed", file=sys.stderr)
    sys.exit(1)
print(f"DEFINER CATALOGUE PROOFS PASS: {passed}/{total}")
