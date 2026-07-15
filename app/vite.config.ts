import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";

interface ViteManifestEntry {
  file?: string;
  css?: string[];
  imports?: string[];
  isEntry?: boolean;
}

type ViteManifest = Record<string, ViteManifestEntry>;

function assetUrl(file: string): string {
  return file.startsWith("/") ? file : `/${file}`;
}

function collectInitialAssets(manifest: ViteManifest): string[] {
  const out = new Set<string>();
  const visit = (key: string) => {
    const entry = manifest[key];
    if (!entry) return;
    if (entry.file) out.add(assetUrl(entry.file));
    for (const css of entry.css ?? []) out.add(assetUrl(css));
    for (const imported of entry.imports ?? []) visit(imported);
  };
  for (const [key, entry] of Object.entries(manifest)) {
    if (entry.isEntry) visit(key);
  }
  return [...out];
}

// Stamp the service worker with a per-build version and the hashed assets
// needed by the initial app shell. Lazy feature chunks (notably Mapbox) are
// intentionally excluded so installing/updating the PWA does not download
// large code that may never be used.
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
          const manifest = JSON.parse(
            readFileSync(fileURLToPath(new URL("./dist/.vite/manifest.json", import.meta.url)), "utf8"),
          ) as ViteManifest;
          assets = collectInitialAssets(manifest);
        } catch {
          try {
            assets = readdirSync(assetsDir)
              .filter((f) => f.endsWith(".css") || (f.endsWith(".js") && f.startsWith("index-")))
              .map((f) => `/assets/${f}`);
          } catch {
            // no assets dir — precache the bare shell only
          }
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
  build: {
    manifest: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
