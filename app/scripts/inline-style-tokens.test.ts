import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The gate that was missing when two screens shipped invisible text.
 *
 * `Roster`'s client invite link and `Booking`'s cost card both did
 * `background: "var(--mist)"`. `--mist` resolves through `--hairline` to
 * `--sanpo-color-border-subtle` — a BORDER role — and the vendor palette
 * darkens border roles to Indigo under `prefers-contrast: more`, while the
 * inherited `--sanpo-color-text-primary` IS Indigo. Measured in a real browser:
 * background rgb(12,71,116), colour rgb(12,71,116). 1.00:1, on the operator's
 * client-onboarding handoff and on the client's default booking path.
 *
 * Two existing checks should have caught it and structurally could not:
 *
 *   - `role-contrast.test.ts` reads `components.css` + the vendor palette. It
 *     never reads `tokens.css`, so the alias chain `--mist -> --hairline ->
 *     --sanpo-color-border-subtle` is not a chain it can follow — and the
 *     defect was in TSX, which it does not read at all.
 *   - the H24 escalation coverage check fails any `components.css` rule that
 *     paints a tint without joining the escalation list. A tint expressed in a
 *     style object gets no such check.
 *
 * So the rule this file enforces is about SEMANTICS, not tidiness: a role has a
 * job, and using a border role as a fill inverts under an override that was
 * written to help. It reads `tokens.css` precisely because that is the file the
 * other check cannot see.
 */

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel: string) => readFileSync(here(rel), "utf8");

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Every `--x: value` declaration across the three stylesheets, so a `var()`
 * chain can be walked to whatever it finally names.
 *
 * Declarations inside `@media (prefers-contrast: more)` are collected
 * SEPARATELY. That block is the whole point: a role can be benign at
 * `:root` and hostile under the override, and a resolver that flattens the two
 * would report the benign answer — which is what every check here did before.
 */
function tokenTable(): { base: Map<string, string>; contrast: Map<string, string> } {
  const base = new Map<string, string>();
  const contrast = new Map<string, string>();
  for (const file of [
    "../src/styles/vendor/sanpo-product-color-tokens-r1.css",
    "../src/styles/tokens.css",
    "../src/styles/components.css",
  ]) {
    const css = stripComments(read(file));
    // Split on the high-contrast block so declarations inside it are attributed
    // to `contrast` rather than overwriting the base value.
    const marker = /@media\s*\(\s*prefers-contrast:\s*more\s*\)\s*\{/g;
    let cursor = 0;
    let m: RegExpExecArray | null;
    while ((m = marker.exec(css)) !== null) {
      collect(css.slice(cursor, m.index), base);
      // Walk braces to find the end of the media block.
      let depth = 1;
      let i = m.index + m[0].length;
      for (; i < css.length && depth > 0; i++) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}") depth--;
      }
      collect(css.slice(m.index, i), contrast);
      cursor = i;
      marker.lastIndex = i;
    }
    collect(css.slice(cursor), base);
  }
  return { base, contrast };
}

function collect(css: string, into: Map<string, string>): void {
  for (const [, name, value] of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+);/gi)) {
    into.set(name.trim(), value.trim());
  }
}

/**
 * Every token name a `var()` chain passes THROUGH, in order.
 *
 * Returning only the endpoint is wrong and this function was written that way
 * first: the chain `--mist -> --hairline -> --sanpo-color-border-subtle ->
 * --sanpo-color-brand-indigo -> #0C4774` ends at a hex literal, so a test
 * asking "does this resolve to a border role?" matched nothing and the gate
 * passed against the exact defect it exists for. The sabotage caught it.
 *
 * The question is not what the chain ends at — two roles with opposite meanings
 * can end at the same colour, which is precisely how the inversion happens. The
 * question is what it goes through.
 */
function resolveChain(value: string, table: Map<string, string>, override: Map<string, string>): string[] {
  const chain: string[] = [];
  let current = value.trim();
  for (let hop = 0; hop < 12; hop++) {
    const match = /^var\(\s*(--[a-z0-9-]+)/i.exec(current);
    if (!match) break;
    const name = match[1];
    chain.push(name);
    const next = override.get(name) ?? table.get(name);
    if (next === undefined) break;
    current = next;
  }
  return chain;
}

/** Every `style={{ … }}` object literal in the app, with its file and line. */
function inlineStyleObjects(): { file: string; line: number; body: string }[] {
  const root = here("../src");
  const out: { file: string; line: number; body: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".tsx")) continue;
      const text = readFileSync(full, "utf8");
      const rel = full.slice(root.length + 1);
      for (const match of text.matchAll(/style=\{\{/g)) {
        const start = match.index ?? 0;
        // Brace-match rather than regex to the closing `}}` — a nested object
        // or a template literal would defeat a lazy match.
        let depth = 0;
        let i = start + "style={".length;
        for (; i < text.length; i++) {
          if (text[i] === "{") depth++;
          else if (text[i] === "}") {
            depth--;
            if (depth === 0) break;
          }
        }
        out.push({
          file: rel,
          line: text.slice(0, start).split("\n").length,
          body: text.slice(start, i + 1),
        });
      }
    }
  };
  walk(root);
  return out;
}

/** `background` / `backgroundColor` values from one style object. */
function backgroundsIn(body: string): string[] {
  const values: string[] = [];
  for (const [, value] of body.matchAll(/\bbackground(?:Color)?\s*:\s*([^,\n]+)/g)) {
    // A ternary supplies two candidates; both are painted in some state.
    for (const part of value.split("?").flatMap((p) => p.split(":"))) {
      // Take the `var(...)` expression itself rather than trimming quotes off
      // the ends — a value can be followed by `" }` or a trailing comma, and
      // carrying that into the failure message makes the offender harder to
      // read at exactly the moment somebody is reading it.
      const expression = /var\(\s*--[a-z0-9-]+[^)]*\)/i.exec(part);
      if (expression) values.push(expression[0]);
    }
  }
  return values;
}

const { base, contrast } = tokenTable();
const objects = inlineStyleObjects();

describe("inline style objects", () => {
  it("finds the style objects it is supposed to be checking", () => {
    // A scanner that matches nothing passes every rule below. This repository
    // has shipped a typecheck over zero files and a `?raw` import that resolved
    // to an empty string; a guard whose corpus is empty is the same shape.
    expect(objects.length).toBeGreaterThan(100);
    expect(objects.some((o) => o.file.includes("Booking"))).toBe(true);
  });

  it("never fills a background with a border role", () => {
    // The defect. A border role darkens to Indigo under `prefers-contrast:
    // more` so the RULE gets more visible; as a fill it collides with the text.
    const offenders: string[] = [];
    for (const object of objects) {
      for (const value of backgroundsIn(object.body)) {
        const chain = resolveChain(value, base, contrast);
        const role = chain.find((name) => /^--sanpo-color-border-/.test(name));
        if (role) {
          offenders.push(`${object.file}:${object.line} — ${value} resolves through ${role}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never fills a background with a CT-1 tint", () => {
    // A tint needs the H24 `-on-tint` escalation, and that list is a set of
    // CSS selectors — an inline tint can never join it. So a tint belongs in
    // `components.css`, where `role-contrast.test.ts` will insist on it.
    const offenders: string[] = [];
    for (const object of objects) {
      for (const value of backgroundsIn(object.body)) {
        const chain = resolveChain(value, base, contrast);
        const role = chain.find((name) => /tint$/.test(name));
        if (role) {
          offenders.push(`${object.file}:${object.line} — ${value} resolves through ${role}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never writes a raw colour literal", () => {
    // Green today, so this is a forward guard: a literal bypasses the palette
    // and its `prefers-contrast` overrides entirely, which is the same class of
    // bug one layer lower (review M37).
    const offenders: string[] = [];
    for (const object of objects) {
      // `ConfigError` is the one exemption, and it is a stated one: spec
      // 06:526-527 requires it to render with no stylesheet at all, because it
      // is what shows when the build has no environment and CSS may not load.
      if (object.file.includes("ConfigError")) continue;
      const literal = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.exec(object.body);
      if (literal) offenders.push(`${object.file}:${object.line} — ${literal[0]}`);
    }
    expect(offenders).toEqual([]);
  });
});
