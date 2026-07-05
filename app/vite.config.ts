import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";

// Stamp the service worker with a per-build version so caches bust on
// deploy (phase 08).
function stampServiceWorker(): Plugin {
  return {
    name: "pawtrail-sw-version",
    apply: "build",
    closeBundle() {
      const out = fileURLToPath(new URL("./dist/sw.js", import.meta.url));
      try {
        const src = readFileSync(out, "utf8");
        writeFileSync(out, src.replace("__BUILD_VERSION__", Date.now().toString(36)));
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
