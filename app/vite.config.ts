import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
// Extracted so it is reachable from a test at all: a rule that only runs
// inside a build is a rule nothing can prove. `scripts/today-plate-family.test.ts`
// drives these directly.
import {
  PLATE_SOURCE_VARIANT_RE,
  todayPlateFamily,
  type PlateFamily,
} from "./scripts/today-plate-family.ts";

// Stamp the service worker with a per-build version AND the build's hashed
// asset list so the shell precache is complete (phase 08; re-review fix —
// without the chunks, activate's cache wipe broke offline reload after
// every deploy: the new index.html referenced chunks no cache held).
//
// Images count as shell: the Today field and the brand lockups are part of
// what the operator sees on a cold offline start, and leaving them out left
// the primary screen rendering without its artwork.
const SHELL_ASSET_EXTENSIONS = [".js", ".css", ".woff2", ".webp", ".svg"];

/**
 * Which JS chunks belong in the precache.
 *
 * The precache used to be every `.js` in `dist/assets`, which swept in the
 * code-split `mapbox-gl` chunk: 1.8 MB of a 3.0 MB precache, 59% of every
 * install, downloaded again on every deploy, and executed only by the users
 * who open a map (review M6).
 *
 * The rule is STATIC REACHABILITY, not size. My first attempt was a byte
 * threshold and the build refuted it on the first run: at 512 KiB it also
 * excluded the app entry, which at 580 KiB is the one chunk without which
 * there is no offline shell at all. Size cannot tell "the shell" from "a lazy
 * chunk"; the module graph can, and it stays correct as both grow.
 *
 * So: start at the entry chunks and follow `imports` (static) transitively.
 * Anything reachable only through `dynamicImports` is left out and picked up
 * by the worker's cache-first rule the first time it is genuinely used. A
 * future lazy chunk is excluded automatically; a future static dependency is
 * included automatically. Nobody has to remember this.
 */
/**
 * Structural, rather than importing rollup's `OutputBundle`. `rollup` is not a
 * direct dependency of this package (Vite 8 bundles rolldown), so the import
 * does not resolve — and naming the three fields actually read is a more
 * honest contract than a type alias that hides them.
 */
interface BundleChunk {
  type: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
}

function staticallyReachableChunks(bundle: Record<string, BundleChunk>): Set<string> {
  const chunks = new Map<string, BundleChunk>();
  for (const [name, item] of Object.entries(bundle)) {
    if (item.type === "chunk") chunks.set(name, item);
  }
  // Bundle keys are output paths (`assets/index-abc.js`); the precache is
  // built from `readdirSync`, which yields bare filenames. Matching the two
  // forms directly produced an empty JS precache — a broken offline shell —
  // and did so silently, which is why `assertUsableShell` exists below.
  const base = (name: string) => name.slice(name.lastIndexOf("/") + 1);

  const keep = new Set<string>();
  const walk = (name: string) => {
    if (keep.has(base(name))) return;
    const chunk = chunks.get(name);
    if (!chunk) return;
    keep.add(base(name));
    for (const dep of chunk.imports ?? []) walk(dep);
  };
  for (const [name, chunk] of chunks) {
    // `isDynamicEntry` marks the target of an `import()`. An entry that is
    // both is still an entry, so the order of these tests matters.
    if (chunk.isEntry && !chunk.isDynamicEntry) walk(name);
  }
  return keep;
}

function stampServiceWorker(): Plugin {
  let shellChunks = new Set<string>();
  return {
    name: "sanpo-sw-version",
    apply: "build",
    generateBundle(_options, bundle) {
      // The module graph is only available here; `closeBundle` sees the
      // filesystem, which no longer knows which import was static.
      shellChunks = staticallyReachableChunks(bundle as unknown as Record<string, BundleChunk>);
    },
    closeBundle() {
      const out = fileURLToPath(new URL("./dist/sw.js", import.meta.url));
      const assetsDir = fileURLToPath(new URL("./dist/assets", import.meta.url));

      // Review M6. This whole body used to sit in a `try {} catch {}` whose
      // comment claimed "no sw.js in this build". `sw.js` lives in `public/`
      // and is therefore ALWAYS copied, so that catch could only ever swallow
      // a real failure — and an unstamped worker fails in two silent ways at
      // once: `VERSION` stays the literal `__BUILD_VERSION__`, so the
      // activate-time sweep deletes nothing ever again, and `BUILD_ASSETS`
      // stays a string, so `Array.isArray` is false and the hashed chunks are
      // never precached, leaving no offline shell. Both with a green build.
      let assets: string[] = [];
      const skipped: string[] = [];
      let bytes = 0;
      let plate: PlateFamily | null = null;
      // How many plate variants the SOURCE carries, so the bundle is checked
      // against what exists rather than against a number written here that
      // would rot the day a width is added.
      //
      // Read OUTSIDE the try on purpose. The catch below exists to tolerate a
      // missing `dist/assets` — a `public`-only build — and `src/assets` is
      // source, so it is always there. Reading it inside would let an ENOENT
      // be swallowed by that tolerance and stamp a worker with no plate at
      // all, from a green build.
      const sourceVariantCount = readdirSync(
        fileURLToPath(new URL("./src/assets/illustrations", import.meta.url)),
      ).filter((f) => PLATE_SOURCE_VARIANT_RE.test(f)).length;

      try {
        const all = readdirSync(assetsDir);
        plate = todayPlateFamily(all, sourceVariantCount);

        const files = all.filter((f) => SHELL_ASSET_EXTENSIONS.some((ext) => f.endsWith(ext)));
        for (const f of files) {
          const size = statSync(join(assetsDir, f)).size;
          // Non-JS assets — CSS, fonts, the Today plate — are all shell: they
          // are what the operator sees on a cold offline start, and none of
          // them is lazily imported.
          if (f.endsWith(".js") && !shellChunks.has(f)) {
            skipped.push(`${f} (${(size / 1024).toFixed(0)} KiB)`);
            continue;
          }
          // ...except the plate's smaller candidates. Exactly one plate is
          // precached and the worker substitutes it for the rest; see
          // `todayPlateFamily`.
          if (plate.variants.includes(f)) {
            skipped.push(`${f} (${(size / 1024).toFixed(0)} KiB)`);
            continue;
          }
          assets.push(`/assets/${f}`);
          bytes += size;
        }
      } catch (error) {
        // A missing assets dir is a `public`-only build, and a bare shell is
        // still a correct precache. A plate that could not be resolved is NOT
        // that, and must not be swallowed by the same catch — the whole point
        // of `todayPlateFamily` throwing is that it stops the build.
        if (error instanceof Error && error.message.includes("Today plate")) throw error;
        assets = [];
        plate = null;
      }
      // Said out loud rather than silently decided, in both directions: what
      // was left out, and how big what stayed in actually is.
      this.warn(
        `sw precache: ${assets.length} files, ${(bytes / 1024).toFixed(0)} KiB`
          + (skipped.length > 0
            ? ` — runtime-cached instead: ${skipped.join(", ")}`
            : ""),
      );

      // A precache with no JS in it is not a shell, it is an empty cache that
      // reports success — the exact failure this repository keeps finding, and
      // the one the basename mismatch above produced on the first run of this
      // very change. Excluding a lazy chunk is the point; excluding the entry
      // is a broken offline start, so it fails the build rather than warning.
      const hasEntryScript = assets.some((a) => a.endsWith(".js"));
      if (!hasEntryScript && skipped.length > 0) {
        throw new Error(
          `sw precache contains no JavaScript — every chunk was treated as lazily imported `
            + `(${skipped.join(", ")}). The offline shell would not start.`,
        );
      }

      const src = readFileSync(out, "utf8");
      if (
        !src.includes("__BUILD_VERSION__")
        || !src.includes("\"__BUILD_ASSETS__\"")
        || !src.includes("\"__PLATE_FAMILY__\"")
      ) {
        throw new Error(
          "sw.js is missing its build placeholders — the service worker would ship unstamped, "
            + "with no cache versioning, no offline shell and no plate fallback.",
        );
      }
      // A `public`-only build has no plate to name; every real build does, and
      // `todayPlateFamily` has already thrown if it could not resolve one.
      const plateStamp = plate ? { stem: plate.stem, fallback: plate.fallback } : null;
      if (plate && !assets.includes(plate.fallback)) {
        throw new Error(
          `the Today plate fallback ${plate.fallback} is not in the precache, so the worker would `
            + "substitute a file it does not hold and the plate would be blank on a cold offline start.",
        );
      }
      const stamped = src
        .replace("__BUILD_VERSION__", Date.now().toString(36))
        .replace("\"__BUILD_ASSETS__\"", JSON.stringify(assets))
        .replace("\"__PLATE_FAMILY__\"", JSON.stringify(plateStamp));
      writeFileSync(out, stamped);
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
  /**
   * Two projects, because review H18 found that the whole suite ran in
   * `environment: "node"` and every `.test.tsx` rendered through
   * `renderToStaticMarkup`. Nothing that a component actually DOES was
   * reachable: no effect body, no cleanup, no subscription, no event handler,
   * no focus behaviour, no state transition. The harness could not express a
   * test for Walk Mode's lifecycle or the vault's reveal-and-expire, so the
   * gap was not "under-covered" — those tests were unwritable.
   *
   * `node` keeps the pure layer honest and fast; a DOM global leaking into
   * `lib/` would hide a real dependency on `window` that the edge functions
   * and the service worker do not have. `dom` is where behaviour lives.
   */
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/lib/**/*.test.ts", "scripts/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "happy-dom",
          setupFiles: ["./src/test/setup.ts"],
          include: [
            "src/components/**/*.test.ts",
            "src/components/**/*.test.tsx",
            "src/screens/**/*.test.ts",
            "src/screens/**/*.test.tsx",
            "src/hooks/**/*.test.ts",
            "src/hooks/**/*.test.tsx",
            // `lib/` is the node project's territory, EXCEPT for `.tsx`:
            // `auth-context.tsx` genuinely contains components (the reauth
            // sheet), so a behavioural test for it belongs here. Without this
            // line `src/lib/*.test.tsx` matched no project at all and ran
            // nowhere — silently, which is the failure mode H18 was about.
            // The CI orphan check fails any test file no project claims.
            "src/lib/**/*.test.tsx",
            // Prototypes (review L21) are components even though no route
            // renders them, so their tests belong in the DOM project. Listed
            // rather than left out: a prototype whose test runs nowhere is a
            // prototype that has quietly stopped compiling.
            "src/prototypes/**/*.test.ts",
            "src/prototypes/**/*.test.tsx",
          ],
        },
      },
    ],
  },
});
