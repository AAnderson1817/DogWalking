#!/usr/bin/env python3
"""Every `[functions.<name>]` table in supabase/config.toml is one the CLI applies.

`supabase functions deploy` reads `[functions.<name>]` from config.toml, and
it IGNORES a key it does not know. Measured on CLI 2.109.1 and 2.117.0 alike,
while vetting the move from one to the other: with `verfy_jwt = false` on
stripe-webhook, `link` and `functions deploy --use-api` both exit 0 with no
warning, and the deploy sends the function with `verify_jwt` unset, which the
platform reads as on. Four functions here are public on purpose — two Stripe
webhooks, the unsubscribe link and claim-signup — and on any of them that
typo means the gateway answers every caller 401: webhooks stop reconciling
payments, and invited clients cannot sign up.

`verify-deployment.sh` cannot see that. Its probe authenticates with the
service-role key, which the gateway accepts whether or not `verify_jwt` is on.

A table named for a function that does not exist (`[functions.stripe_webhook]`)
is ignored the same way, and by every CLI version, so it is checked too.

The two rules, and nothing else:
  1. every key in a `[functions.<name>]` table is one the CLI's schema
     declares — read from CLI 2.117.0, `packages/config/src/functions.ts`;
  2. every `[functions.<name>]` table names a function this repository ships,
     as `scripts/repo-functions.sh` defines one.

VALUES are deliberately not checked. The CLI substitutes `env(VAR)` at any
scalar key and splits a string on commas where the schema wants a list, so a
type rule written here would refuse configs the CLI accepts, and a value it
cannot decode is a loud deploy failure anyway, first on staging. What this
adds is the one refusal the CLI has never made: a mistake that deploys
cleanly and quietly changes who may call a function.

`SCHEMA_FROM` ties the key list to the release it was read from. If the pinned
CLI moves, this refuses until someone re-reads the schema at the new tag, so
the list cannot quietly go stale behind a bump.

It re-checks its own probes on every run (the smoke.sql invariant-1 shape): a
rule no probe can break has nothing behind it, and a checker that refuses
nothing would report agreement.

Run: python3 scripts/check-function-config.py
  FUNCTION_CONFIG  override the config.toml path (tests)
  FUNCTIONS_DIR    passed through to scripts/repo-functions.sh (tests)
  WORKFLOWS_DIR    override .github/workflows (tests)
"""
from __future__ import annotations

import os
import pathlib
import subprocess
import sys
import tomllib

import yaml

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONFIG = pathlib.Path(os.environ.get("FUNCTION_CONFIG") or ROOT / "supabase" / "config.toml")
WORKFLOWS = pathlib.Path(os.environ.get("WORKFLOWS_DIR") or ROOT / ".github" / "workflows")

# The keys the CLI's `func` schema declares, read from the release pinned in
# the deploy workflows. Case matters: the schema's keys are exact.
SCHEMA_FROM = "2.117.0"
KEYS = ("enabled", "verify_jwt", "import_map", "entrypoint", "static_files", "env")


def problems(doc: dict, shipped: set[str]) -> list[str]:
    """Every `[functions.<name>]` setting in `doc` the CLI would not apply."""
    tables = doc.get("functions")
    if not isinstance(tables, dict):
        return []
    out = []
    for name, table in tables.items():
        where = f"[functions.{name}]"
        if name not in shipped:
            out.append(
                f"{where} names no function this repository ships (scripts/repo-functions.sh), "
                "so its settings apply to nothing"
            )
        if not isinstance(table, dict):
            continue
        for key in table:
            if key not in KEYS:
                out.append(
                    f"{where} has the key `{key}`, which the CLI ignores without a word — "
                    f"the keys it reads are {', '.join(KEYS)}"
                )
    return out


# (label, config.toml text, a fragment the refusal must contain — or None
# where the config is one the CLI applies as written). The probe tree ships
# one function, stripe-webhook.
PROBE_SHIPPED = {"stripe-webhook"}
PROBES = [
    ("a misspelt key", "[functions.stripe-webhook]\nverfy_jwt = false\n", "the key `verfy_jwt`"),
    ("a key in the wrong case", "[functions.stripe-webhook]\nVerify_JWT = false\n", "the key `Verify_JWT`"),
    ("a table for no function", "[functions.stripe_webhook]\nverify_jwt = false\n", "[functions.stripe_webhook] names no function"),
    ("a setting directly under [functions]", "[functions]\nverify_jwt = false\n", "[functions.verify_jwt] names no function"),
    (
        "every key the schema declares",
        '[functions.stripe-webhook]\nenabled = true\nverify_jwt = false\nimport_map = "./import_map.json"\n'
        'entrypoint = "./index.ts"\nstatic_files = "./a/*,./b/*"\n\n'
        '[functions.stripe-webhook.env]\nSTRIPE_KEY = "env(STRIPE_KEY)"\n',
        None,
    ),
    ("a value the CLI coerces", '[functions.stripe-webhook]\nverify_jwt = "env(VERIFY_JWT)"\n', None),
    ("no function tables at all", "[db]\nport = 54322\n", None),
]


def self_test() -> list[str]:
    failures = []
    for label, text, expected in PROBES:
        found = problems(tomllib.loads(text), PROBE_SHIPPED)
        if expected is None and found:
            failures.append(f"self-test: {label} is a config the CLI applies, and was refused: {found[0]}")
        if expected is not None and not any(expected in p for p in found):
            failures.append(f"self-test: {label} was not refused (expected a refusal naming {expected})")
    return failures


def shipped_functions() -> set[str]:
    """Ask the one definition, as check-status-counters.py and verify-deployment.sh do."""
    helper = ROOT / "scripts" / "repo-functions.sh"
    try:
        out = subprocess.run([str(helper)], cwd=ROOT, capture_output=True, text=True)
    except OSError as e:
        raise SystemExit(f"FAIL: could not run {helper.relative_to(ROOT)}: {e}")
    if out.returncode != 0:
        raise SystemExit(f"FAIL: scripts/repo-functions.sh exited {out.returncode}: {out.stderr.strip()}")
    return {n for n in out.stdout.split("\n") if n}


def pinned_versions() -> set[str]:
    """Every Supabase CLI version a workflow installs."""
    versions = set()
    for path in sorted(WORKFLOWS.glob("*.yml")):
        for job in (yaml.safe_load(path.read_text()) or {}).get("jobs", {}).values():
            for step in (job or {}).get("steps") or []:
                if isinstance(step, dict) and str(step.get("uses") or "").startswith("supabase/setup-cli@"):
                    versions.add(str((step.get("with") or {}).get("version") or ""))
    return versions


def main() -> int:
    failures = self_test()

    versions = pinned_versions()
    if not versions:
        failures.append(f"read no supabase/setup-cli step under {WORKFLOWS} — could not tell which CLI deploys")
    elif versions != {SCHEMA_FROM}:
        failures.append(
            f"the deploy workflows pin the Supabase CLI at {', '.join(sorted(versions))}, but the key list here "
            f"was read from {SCHEMA_FROM} — re-read packages/config/src/functions.ts at the pinned tag, "
            "then update KEYS and SCHEMA_FROM"
        )

    shipped = shipped_functions()
    if not shipped:
        failures.append("scripts/repo-functions.sh named no function — refusing rather than checking against nothing")

    try:
        doc = tomllib.loads(CONFIG.read_text())
    except (OSError, tomllib.TOMLDecodeError) as e:
        failures.append(f"could not read {CONFIG}: {e}")
        doc = {}
    tables = doc.get("functions") if isinstance(doc.get("functions"), dict) else {}
    if not tables:
        failures.append(f"read no [functions.<name>] table in {CONFIG} — refusing rather than reporting agreement")
    failures += problems(doc, shipped)

    if failures:
        for line in failures:
            print(f"::error::{line}")
        print(f"\nFAIL: {len(failures)} problem(s) with the function settings a deploy applies")
        return 1
    print(
        f"PASS: {len(tables)} [functions.<name>] tables name shipped functions and only keys "
        f"CLI {SCHEMA_FROM} reads ({len(PROBES)} probes re-checked)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
