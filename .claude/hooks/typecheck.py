#!/usr/bin/env python3
"""PostToolUse: after editing a .ts/.tsx under app/, run tsc --noEmit and
report the first errors back to Claude. Never blocks (always exit 0).
Remove this hook from .claude/settings.json if it slows large phases;
/validate remains the commit gate.
"""
import json
import os
import subprocess
import sys

try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(0)

tool_input = payload.get("tool_input", {}) or {}
path = (tool_input.get("file_path") or tool_input.get("path") or "").replace("\\", "/")

if "app/" not in path or not path.endswith((".ts", ".tsx")):
    sys.exit(0)
if not os.path.exists("app/tsconfig.json"):
    sys.exit(0)

try:
    result = subprocess.run(
        ["npx", "tsc", "--noEmit", "-p", "app"],
        capture_output=True,
        text=True,
        timeout=120,
    )
except Exception:
    sys.exit(0)

if result.returncode != 0:
    lines = (result.stdout or result.stderr or "").splitlines()
    print("tsc --noEmit reported errors after this edit:")
    for line in lines[:30]:
        print(line)
    if len(lines) > 30:
        print("… (%d more lines; run /validate for full output)" % (len(lines) - 30))

sys.exit(0)
