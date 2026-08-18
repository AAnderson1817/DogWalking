import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * This lives in `scripts/` rather than beside the stylesheets, with the other
 * build-time checks, for two reasons that turned out to be the same reason: it
 * analyses CSS text rather than exercising a component, and `src` is typed by
 * `tsconfig.app.json`, which has no Node types. `?raw` was the first attempt
 * and reads as the obvious answer — but Vitest defaults to `css: false`, so the
 * import resolves to an empty string and every assertion passes vacuously.
 * Measured, not assumed: the probe returned `len: 0`.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const COMPONENTS = read("../src/styles/components.css");
const VENDOR = read("../src/styles/vendor/sanpo-product-color-tokens-r1.css");

/**
 * Review H24: the palette's own text roles cannot pass AA on the palette's own
 * tint surfaces. `text-secondary` scores 3.71:1 on the Kaki tint against a
 * 4.5:1 floor, and the tint surfaces ARE the attention states — the walk card
 * that failed was the in-progress one, the calendar column that failed was
 * today's.
 *
 * Two tests, because there are two ways to get this wrong:
 *
 *   1. a token whose value does not clear the floor (the matrix), and
 *   2. a surface that paints a tint without escalating (the coverage check).
 *
 * Both parse the real stylesheets. Restating the values here would only prove
 * that this file agrees with itself.
 */

/** Braces appear inside comments. Strip them first or the scan derails. */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

type Rgb = [number, number, number];

function luminance([r, g, b]: Rgb): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function hex(value: string): Rgb {
  const h = value.trim().replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const at = (i: number) => Number.parseInt(full.slice(i, i + 2), 16);
  return [at(0), at(2), at(4)];
}

/** `color-mix(in srgb, A p%, B)` — the only mix form the stylesheets use. */
function mix(a: Rgb, b: Rgb, percentA: number): Rgb {
  const p = percentA / 100;
  const at = (i: 0 | 1 | 2) => a[i] * p + b[i] * (1 - p);
  return [at(0), at(1), at(2)];
}

/**
 * The token layer, resolved by following `var()` and `color-mix()`.
 *
 * Harvested from `:root` rules ONLY — including the ones inside `@supports`,
 * excluding the ones inside `@media`. That restriction is the whole model and
 * it is not incidental: component rules also declare `--sanpo-color-*` names,
 * but those are SCOPED overrides, not definitions. A first draft read every
 * declaration in the file and promptly found a cycle, because the escalation
 * rule sets `--sanpo-color-text-secondary: var(--…-on-tint)` on a descendant
 * while `-on-tint` is defined on `:root` from the base role. There is no cycle
 * in the cascade; there was one in the model.
 *
 * Last declaration wins, because `components.css` deliberately re-points a few
 * vendor roles on `:root` and reading the first would test a value the product
 * does not use. `@media (prefers-contrast: more)` is a different rendering
 * state and is asserted separately.
 */
function buildTokenTable(): Map<string, string> {
  const table = new Map<string, string>();
  for (const css of [VENDOR, COMPONENTS]) {
    const base = stripComments(css).replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    for (const block of base.matchAll(/(^|[{}])\s*:root\s*\{([^{}]*)\}/g)) {
      for (const m of (block[2] ?? "").matchAll(/(--sanpo-color-[a-z0-9-]+)\s*:\s*([^;}]+)/g)) {
        if (m[1] && m[2]) table.set(m[1], m[2].trim());
      }
    }
  }
  return table;
}

function resolve(name: string, table: Map<string, string>, seen = new Set<string>()): Rgb {
  if (seen.has(name)) throw new Error(`cycle resolving ${name}`);
  seen.add(name);
  const raw = table.get(name);
  if (!raw) throw new Error(`${name} is never defined`);
  return resolveValue(raw, table, seen);
}

function resolveValue(raw: string, table: Map<string, string>, seen: Set<string>): Rgb {
  const value = raw.trim();
  if (value.startsWith("#")) return hex(value);

  const varOnly = value.match(/^var\(\s*(--[a-z0-9-]+)\s*\)$/);
  if (varOnly?.[1]) return resolve(varOnly[1], table, seen);

  const cm = value.match(/^color-mix\(\s*in srgb\s*,\s*(.+?)\s+([\d.]+)%\s*,\s*(.+?)\s*\)$/s);
  if (cm?.[1] && cm[2] && cm[3]) {
    return mix(
      resolveValue(cm[1], table, new Set(seen)),
      resolveValue(cm[3], table, new Set(seen)),
      Number(cm[2]),
    );
  }
  throw new Error(`cannot resolve "${value}"`);
}

const TEXT_ROLES = [
  "text-primary",
  "text-secondary",
  "text-success",
  "text-attention",
  "text-relationship",
  "text-link",
] as const;

const TINT_SURFACES = [
  "surface-attention",
  "surface-information",
  "surface-success",
  "surface-relationship",
  "surface-milestone",
] as const;

const FLAT_SURFACES = ["surface-canvas", "surface-raised"] as const;

const AA_TEXT = 4.5;

describe("CT-1 role x surface contrast", () => {
  const table = buildTokenTable();

  it("every text role clears AA on the flat surfaces", () => {
    const failures: string[] = [];
    for (const role of TEXT_ROLES) {
      for (const surface of FLAT_SURFACES) {
        const ratio = contrast(resolve(`--sanpo-color-${role}`, table), resolve(`--sanpo-color-${surface}`, table));
        if (ratio < AA_TEXT) failures.push(`${role} on ${surface}: ${ratio.toFixed(2)}:1`);
      }
    }
    expect(failures).toEqual([]);
  });

  /**
   * The finding itself. This fails against the unescalated roles — which is
   * how it was confirmed: run it with `-on-tint` pointing at the bare role and
   * five of six roles come back red on all five tints.
   */
  it("every text role clears AA on every tint, via its -on-tint variant", () => {
    const failures: string[] = [];
    for (const role of TEXT_ROLES) {
      // text-primary is Indigo and passes everywhere; it has no -on-tint
      // variant precisely because it never needed one.
      const name = table.has(`--sanpo-color-${role}-on-tint`)
        ? `--sanpo-color-${role}-on-tint`
        : `--sanpo-color-${role}`;
      for (const surface of TINT_SURFACES) {
        const ratio = contrast(resolve(name, table), resolve(`--sanpo-color-${surface}`, table));
        if (ratio < AA_TEXT) failures.push(`${role} on ${surface}: ${ratio.toFixed(2)}:1`);
      }
    }
    expect(failures).toEqual([]);
  });

  /**
   * An escalation that is not actually darker is the failure mode a copy-paste
   * produces: the token exists, the surfaces reference it, and it changes
   * nothing. Guards the `@supports` block being dropped, too.
   */
  it("each -on-tint variant is materially darker than the role it escalates", () => {
    for (const role of TEXT_ROLES) {
      const name = `--sanpo-color-${role}-on-tint`;
      if (!table.has(name)) continue;
      const base = luminance(resolve(`--sanpo-color-${role}`, table));
      const escalated = luminance(resolve(name, table));
      expect(escalated, `${name} is not darker than ${role}`).toBeLessThan(base * 0.85);
    }
  });
});

/**
 * Find every top-level rule that paints one of the CT-1 tints, and return its
 * individual selectors.
 */
function tintPaintingSelectors(css: string): Map<string, string> {
  const src = stripComments(css);
  const found = new Map<string, string>();
  let depth = 0;
  let selectorStart = 0;
  let bodyStart = 0;
  let selector = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "{") {
      if (depth === 0) {
        selector = src.slice(selectorStart, i);
        bodyStart = i + 1;
      }
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        const body = src.slice(bodyStart, i);
        const paints = TINT_SURFACES.find((t) => body.includes(`var(--sanpo-color-${t})`));
        if (paints && /\bbackground(-color)?\s*:/.test(body)) {
          for (const s of selector.split(",")) {
            const trimmed = s.replace(/\s+/g, " ").trim();
            if (trimmed) found.set(trimmed, paints);
          }
        }
        selectorStart = i + 1;
      }
    }
  }
  return found;
}

/** The selector list of the one rule that re-points the roles. */
function escalatingSelectors(css: string): Set<string> {
  const src = stripComments(css);
  const marker = "--sanpo-color-text-secondary: var(--sanpo-color-text-secondary-on-tint)";
  const at = src.indexOf(marker);
  expect(at, "no rule re-points --sanpo-color-text-secondary to its on-tint variant").toBeGreaterThan(-1);
  const open = src.lastIndexOf("{", at);
  const prevClose = Math.max(src.lastIndexOf("}", open), src.lastIndexOf(";", open));
  return new Set(
    src
      .slice(prevClose + 1, open)
      .split(",")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean),
  );
}

describe("tint surfaces escalate their text roles", () => {
  it("every rule that paints a tint is in the escalation list", () => {
    const painters = tintPaintingSelectors(COMPONENTS);
    const escalating = escalatingSelectors(COMPONENTS);
    const missing = [...painters]
      .filter(([sel]) => !escalating.has(sel))
      .map(([sel, tint]) => `${sel} paints ${tint} but does not escalate its text roles`);
    expect(missing).toEqual([]);
  });

  it("the escalation list has no selectors that paint nothing", () => {
    const painters = tintPaintingSelectors(COMPONENTS);
    const stale = [...escalatingSelectors(COMPONENTS)].filter((s) => !painters.has(s));
    expect(stale).toEqual([]);
  });

  /** Sanity check on the parser: if it finds nothing, both tests above pass vacuously. */
  it("the parser actually finds the tint surfaces", () => {
    expect(tintPaintingSelectors(COMPONENTS).size).toBeGreaterThan(20);
  });
});
