import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";

// Stamp the service worker with a per-build version AND the build's hashed
// asset list so the shell precache is complete (phase 08; re-review fix —
// without the chunks, activate's cache wipe broke offline reload after
// every deploy: the new index.html referenced chunks no cache held).
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
            .filter((f) => f.endsWith(".js") || f.endsWith(".css") || f.endsWith(".woff2"))
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

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), stampServiceWorker()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
