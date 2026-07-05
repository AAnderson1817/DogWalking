#!/usr/bin/env python3
"""PreToolUse guard: supabase/migrations/ is append-only.

Deny (exit 2): Edit/MultiEdit on any file under supabase/migrations/,
or Write to a migration file that already exists.
Allow (exit 0): everything else, including Write of a NEW migration file.
Fails closed only for migration paths; malformed input allows (exit 0)
so the guard never blocks unrelated work.
"""
import json
import os
import sys

try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(0)

tool = payload.get("tool_name", "")
tool_input = payload.get("tool_input", {}) or {}
path = tool_input.get("file_path") or tool_input.get("path") or ""

if not path:
    sys.exit(0)

norm = os.path.normpath(path)
if "supabase/migrations/" not in norm.replace("\\", "/"):
    sys.exit(0)

if tool in ("Edit", "MultiEdit", "NotebookEdit"):
    print(
        "BLOCKED: migrations are append-only (CLAUDE.md invariant 6). "
        "Create a new migration file instead of editing %s" % norm,
        file=sys.stderr,
    )
    sys.exit(2)

if tool == "Write" and os.path.exists(norm):
    print(
        "BLOCKED: %s already exists; migrations are append-only. "
        "Create a new migration file." % norm,
        file=sys.stderr,
    )
    sys.exit(2)

sys.exit(0)
