import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";

// Stamp the service worker with a per-build version AND the build's hashed
// asset list so the shell precache is complete (phase 08; re-review fix —
// without the chunks, activate's cache wipe broke offline reload after
// every deploy: the new index.html referenced chunks no cache held).
//
// Images count as shell: the Today field and the brand lockups are part of
// what the operator sees on a cold offline start, and leaving them out left
// the primary screen rendering without its artwork. Safe to precache only
// because the background is now WebP (437 KiB, was a 2.25 MiB PNG) — if a
// future asset lands here at multiple megabytes, revisit rather than
// silently growing every install.
const SHELL_ASSET_EXTENSIONS = [".js", ".css", ".woff2", ".webp", ".svg"];
function stampServiceWorker(): Plugin {
  return {
    name: "pawtrail-sw-version",
    apply: "build",
    closeBundle() {
      const out = fileURLToPath(new URL("./dist/sw.js", import.meta.url));
      const assetsDir = fileURLToPath(new URL("./dist/assets", import.meta.url));
      try {
        let assets: string[] = [];
        try {
          assets = readdirSync(assetsDir)
            .filter((f) => SHELL_ASSET_EXTENSIONS.some((ext) => f.endsWith(ext)))
            .map((f) => `/assets/${f}`);
        } catch {
          // no assets dir — precache the bare shell only
        }
        const src = readFileSync(out, "utf8");
        writeFileSync(
          out,
          src
            .replace("__BUILD_VERSION__", Date.now().toString(36))
            .replace("\"__BUILD_ASSETS__\"", JSON.stringify(assets)),
        );
      } catch {
        // no sw.js in this build — nothing to stamp
      }
    },
  };
}

/**
 * Emit `dist/version.json` naming the commit this bundle was built from.
 *
 * Two jobs. The deploy workflows poll it to confirm the frontend they just
 * released is the one actually being served — pushing a git ref that Vercel
 * builds is otherwise fire-and-forget, and a deploy step that cannot observe
 * its own outcome is the green-but-empty failure this repository keeps finding
 * (review H16). And it answers "which build is this user on?", which nothing
 * could before.
 *
 * The SHA comes from the builder: Vercel sets VERCEL_GIT_COMMIT_SHA, GitHub
 * Actions sets GITHUB_SHA. A local build says "dev" rather than guessing —
 * shelling out to git would make the file differ between a clean checkout and
 * a dirty tree, and a deploy check has to compare against something exact.
 */
function stampVersion(): Plugin {
  return {
    name: "sanpo-version-stamp",
    apply: "build",
    closeBundle() {
      const commit = process.env.VERCEL_GIT_COMMIT_SHA
        ?? process.env.GITHUB_SHA
        ?? "dev";
      const out = fileURLToPath(new URL("./dist/version.json", import.meta.url));
      try {
        writeFileSync(
          out,
          JSON.stringify({ commit, built_at: new Date().toISOString() }) + "\n",
        );
      } catch {
        // no dist yet — nothing to stamp
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), stampServiceWorker(), stampVersion()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.ts"],
  },
});
