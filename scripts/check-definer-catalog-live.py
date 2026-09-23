#!/usr/bin/env python3
"""Gate 8e: the definer catalogue's model agrees with the database it describes.

`gen-definer-catalog.py` reads the migrations and models each function's ACL
from its reading of PostgreSQL's rules: what a new function starts with, what
CREATE OR REPLACE keeps, what DROP and a new overload reset. A model written
from a reading of the rules shares that reading's mistakes, and so does a test
written from the same reading — the `check-auth-posture` lesson, where a
fixture the author invented passed while the gate it tested could never pass.
So this asks PostgreSQL.

After a reset to the migrations, every function in `public` that the
migrations create must be in the model with the same argument types, the same
SECURITY DEFINER flag, and the same API roles holding EXECUTE (PUBLIC, anon,
authenticated); and the model may name nothing the database lacks. That also
covers the one thing the generator cannot see — a GRANT or REVOKE made by
dynamic SQL inside a body, which the shared SQL reader blanks — because the
database has applied it and the model has not, and they then disagree here,
by name.

Functions an extension installed (pgcrypto's live in `public`) are not the
migrations' and are left out by `pg_depend`, not by name.

Needs LOCAL_DB_URL, reset to the migrations: validate gate 7, or CI's reset
step. Exit 0 agreement, 1 disagreement, 2 could not ask.
"""
from __future__ import annotations

import importlib.util
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

LIVE = r"""
select p.proname,
       coalesce(array_to_string(array(
         select format_type(t, null) from unnest(p.proargtypes) with ordinality u(t, i) order by i), '|'), ''),
       p.prosecdef,
       coalesce(array_to_string(array(
         select distinct case when a.grantee = 0 then 'public' else r.rolname end
           from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           left join pg_roles r on r.oid = a.grantee
          where a.privilege_type = 'EXECUTE'
            and (a.grantee = 0 or r.rolname in ('anon', 'authenticated'))), '|'), '')
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.prokind = 'f'
   and not exists (select 1 from pg_depend d
                    where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
"""


def load_generator():
    path = ROOT / "scripts" / "gen-definer-catalog.py"
    spec = importlib.util.spec_from_file_location("gen_definer_catalog", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    url = os.environ.get("LOCAL_DB_URL")
    if not url:
        print("FAIL: LOCAL_DB_URL is unset — gate 8e compares the model with a reset database", file=sys.stderr)
        return 2
    gen = load_generator()
    model = gen.collect()
    want = {
        (name, sig): (entry["definer"], tuple(gen.api_roles(model, (name, sig))))
        for (name, sig), entry in model.funcs.items()
    }

    run = subprocess.run(
        ["psql", url, "-X", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-c", LIVE],
        capture_output=True, text=True,
    )
    if run.returncode != 0:
        print(f"FAIL: the catalogue query failed — {run.stderr.strip()[:300]}", file=sys.stderr)
        return 2
    have = {}
    for line in run.stdout.splitlines():
        name, args, definer, holders = line.split("\t")
        sig = tuple(a for a in args.split("|") if a)
        held = tuple(r for r in gen.API_ROLES if r in holders.split("|"))
        have[(name, sig)] = (definer == "t", held)

    # Preconditions: two empty sides agree with each other.
    if len(want) < 50 or len(have) < 50:
        print(
            f"FAIL: the model holds {len(want)} functions and the database {len(have)} — one side is not"
            " looking where the functions are",
            file=sys.stderr,
        )
        return 1

    problems = []
    for key in sorted(want.keys() - have.keys()):
        problems.append(f"{gen.fmt(key)} is in the model and not in the database — a DROP the model missed,"
                        " or an argument type it spells differently from format_type")
    for key in sorted(have.keys() - want.keys()):
        problems.append(f"{gen.fmt(key)} is in the database and not in the model — created by a statement"
                        " the generator does not read")
    for key in sorted(want.keys() & have.keys()):
        (w_def, w_roles), (h_def, h_roles) = want[key], have[key]
        if w_def != h_def:
            problems.append(f"{gen.fmt(key)}: the model says SECURITY {'DEFINER' if w_def else 'INVOKER'},"
                            f" the database {'DEFINER' if h_def else 'INVOKER'}")
        if w_roles != h_roles:
            show = lambda rs: ", ".join(gen.SHOWN.get(r, r) for r in rs) or "none"  # noqa: E731
            problems.append(f"{gen.fmt(key)}: the model says EXECUTE is held by {show(w_roles)},"
                            f" the database by {show(h_roles)} — a grant or revoke the generator"
                            " cannot see, such as one made by dynamic SQL in a body")
    if problems:
        for p in problems:
            print(f"FAIL: {p}", file=sys.stderr)
        return 1
    definers = sum(1 for d, _ in want.values() if d)
    print(f"DEFINER CATALOGUE LIVE PASS: the {len(want)} functions the migrations create are in the database"
          f" as the model says ({definers} SECURITY DEFINER)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
