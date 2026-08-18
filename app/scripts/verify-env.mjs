#!/usr/bin/env node
/**
 * Fail a PRODUCTION build that has no Supabase configuration (review H22).
 *
 * Spec 06 has claimed "build fails on missing required keys" since phase 02.
 * It did not. `env.ts` threw at first *access*, not at build time, and because
 * it read `import.meta.env[name]` through a variable key Vite could not
 * statically replace it — so there was no build-time warning either. A Vercel
 * deploy with a mistyped variable passed typecheck, lint, tests, build and
 * brand verification, then served a blank page to every user.
 *
 * The runtime half is fixed separately (`ConfigError`), and that panel is the
 * safety net rather than the plan. This is the plan: a misconfigured build
 * should not be produced at all.
 *
 * Skipped when `--dev` is passed, because `env.ts` has a deliberate local-stack
 * fallback and requiring real values to run `vite dev` would be hostile.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REQUIRED = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"];

/**
 * Vite loads `.env`, `.env.production` and `.env.local` itself, so a key set
 * there is genuinely present at build time even though it is absent from
 * `process.env`. Checking only `process.env` would fail builds that are
 * correctly configured — the false-positive direction, which is how a gate
 * gets disabled.
 */
function fromEnvFiles() {
  const found = new Set();
  for (const file of [".env", ".env.production", ".env.local", ".env.production.local"]) {
    const path = fileURLToPath(new URL(`../${file}`, import.meta.url));
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
      // A key present but empty is not configured. `FOO=` is the exact shape a
      // half-finished deployment leaves behind.
      if (m && m[2].trim().replace(/^["']|["']$/g, "") !== "") found.add(m[1]);
    }
  }
  return found;
}

const fromFiles = fromEnvFiles();
const missing = REQUIRED.filter((k) => !process.env[k] && !fromFiles.has(k));

if (missing.length > 0) {
  console.error(`\nFAIL: production build is missing ${missing.join(", ")}.`);
  console.error("");
  console.error("A build without these produces a bundle that cannot reach Supabase.");
  console.error("Set them in the environment or app/.env.production — see app/.env.example.");
  console.error("For a local build against the local stack, copy app/.env.example to");
  console.error("app/.env.local first.\n");
  process.exit(1);
}

console.log(`PASS: ${REQUIRED.join(", ")} present`);
