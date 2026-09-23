import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Gate 12 (`scripts/check-css-tokens.mjs`) — every `var(--x)` names a custom
 * property something defines.
 *
 * Driven through the real CLI against throwaway trees, because the CLI is what
 * `validate.sh` and CI run: exit code, floors and messages are the contract.
 * Every case breaks ONE rule and requires the gate to notice; the reason is
 * that the first version of this gate scanned CSS only, and a `var(--s-5)` in
 * a TSX style object sat live with every gate green.
 */

const SCRIPT = resolve(__dirname, "check-css-tokens.mjs");

/** The minimal healthy tree: a stylesheet and a component with a literal. */
const CSS = ":root { --a: 4px; --a_b: 8px; }\n.x { padding: var(--a); }\n";
const TSX = 'export const Ok = () => <p className="ok" style={{ margin: "var(--a)" }} />;\n';

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "css-tokens-"));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
}

function run(root: string): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, root], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_ACTIONS: "" },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("gate 12: css tokens defined", () => {
  it("passes a healthy tree", () => {
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "screens/Ok.tsx": TSX }));
    expect(out).toContain("PASS:");
    expect(code).toBe(0);
  });

  it("fails a TSX style object naming an undefined token, with file and line", () => {
    // The Pricing.tsx shape exactly: the defect the CSS-only gate could not see.
    const screen = 'export const S = () => (\n  <ul style={{ paddingLeft: "var(--nope)" }} />\n);\n';
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "screens/S.tsx": screen }));
    expect(out).toMatch(/FAIL: --nope is used but never defined \(.*S\.tsx:2\)/);
    expect(code).toBe(1);
  });

  it("keeps the CSS half: a stylesheet naming an undefined token fails", () => {
    const css = `${CSS}.y {\n  margin: var(--gone);\n}\n`;
    const { code, out } = run(tree({ "styles/tokens.css": css, "screens/Ok.tsx": TSX }));
    expect(out).toMatch(/FAIL: --gone is used but never defined \(.*tokens\.css:4\)/);
    expect(code).toBe(1);
  });

  it("does not count a mention as a use: comments and JSX text are not styles", () => {
    // lib/today-plate.ts already mentions `var(--page-max)` in a doc comment,
    // and the note explaining a fix is where the missing name gets written.
    const mentions = [
      "// never write var(--nope): the scale skips 5",
      "/* var(--nope) in a block comment */",
      "/** doc: `.page { max-width: var(--nope) }` */",
      'export const S = () => <p className="x">write var(--nope) here</p>;',
    ].join("\n");
    const css = `${CSS}/* var(--nope) in stylesheet prose */\n`;
    const { code, out } = run(tree({ "styles/tokens.css": css, "screens/S.tsx": mentions, "screens/Ok.tsx": TSX }));
    expect(out).toContain("PASS:");
    expect(code).toBe(0);
  });

  it("reads template literals, including the text around a substitution", () => {
    const src = [
      "export const w = (n: number) => `calc(var(--whole) * 2)`;",
      "export const h = (n: number) => `calc(${n}px + var(--tail))`;",
    ].join("\n");
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "lib/sizes.ts": src, "screens/Ok.tsx": TSX }));
    expect(out).toContain("FAIL: --whole is used but never defined");
    expect(out).toContain("FAIL: --tail is used but never defined");
    expect(code).toBe(1);
  });

  it("reads a name that runs into a substitution as a prefix, not a whole name", () => {
    // `var(--s-${n})` reaches the scan as a template head ending in `--s-`;
    // checked as a whole name, that is "--s- is used but never defined" on a
    // healthy tree. Concatenation leaves the same fragment in a string literal.
    const src = [
      "export const t = (n: 1 | 2) => `var(--s-${n})`;",
      'export const c = (n: 1 | 2) => "var(--s-" + n + ")";',
      "export const m = (a: string, n: 1 | 2) => `${a} var(--s-${n})`;",
    ].join("\n");
    const css = ":root { --s-1: 4px; --s-2: 8px; }\n";
    const { code, out } = run(tree({ "styles/tokens.css": `${CSS}${css}`, "lib/space.ts": src, "screens/Ok.tsx": TSX }));
    expect(out).toContain("PASS:");
    expect(code).toBe(0);
  });

  it("fails a prefix that no defined token starts with", () => {
    const src = "export const t = (n: number) => `var(--nosuch-${n})`;";
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "lib/space.ts": src, "screens/Ok.tsx": TSX }));
    expect(out).toMatch(/FAIL: var\(--nosuch-…\) can name no defined custom property: none starts with --nosuch- \(.*space\.ts:1\)/);
    expect(code).toBe(1);
  });

  it("still reads a name finished before the substitution as a whole name", () => {
    // `--a_` is terminated by the comma, so it is a whole name — and an
    // undefined one — even though `--a_b` would satisfy it as a prefix.
    const src = "export const t = (fallback: string) => `var(--a_, ${fallback})`;";
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "lib/space.ts": src, "screens/Ok.tsx": TSX }));
    expect(out).toContain("FAIL: --a_ is used but never defined");
    expect(code).toBe(1);
  });

  it("counts a custom property set on a style from TS as defined", () => {
    // None exists today. Without this the gate goes red on a healthy tree the
    // day one does, which is how a gate gets deleted. Each shape here is one
    // the definition rule must recognise as a STYLE.
    const src = [
      'import type { CSSProperties } from "react";',
      'export const A = () => <div style={{ "--local": "1px", padding: "var(--local)" } as object} />;',
      'export const B = () => <div style={{ ["--comp" as string]: 1, margin: "var(--comp)" }} />;',
      'export const C = (on: boolean) => <div style={on ? { "--cond": "1px" } : undefined} className="var(--cond)" />;',
      'const vars = { "--viaType": "1px" } as CSSProperties;',
      'export const D = () => <div style={vars} className="var(--viaType)" />;',
      'const annotated: React.CSSProperties = { "--annot": "1px" };',
      'export const E = () => <div style={annotated} className="var(--annot)" />;',
      'export function f(el: HTMLElement) { el.style.setProperty("--set", "2px"); return "var(--set)"; }',
      'export function g() { document.documentElement.style.setProperty("--root", "2px"); return "var(--root)"; }',
      // Codex on PR #95, round 2: a spread into a style object, and a type
      // that includes CSSProperties without being exactly it.
      'export const F = () => <div style={{ ...{ "--spread": "1px" }, padding: "var(--spread)" }} />;',
      'export const G = (on: boolean) => <div style={{ ...(on ? { "--condSpread": "1px" } : {}), padding: "var(--condSpread)" }} />;',
      'const inter: React.CSSProperties & { "--gap": string } = { "--gap": "1px" };',
      'export const H = () => <div style={inter} className="var(--gap)" />;',
      'const maybe: (CSSProperties | undefined) = { "--maybe": "1px" };',
      'export const I = () => <div style={maybe} className="var(--maybe)" />;',
    ].join("\n");
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "screens/Local.tsx": src }));
    expect(out).toContain("PASS:");
    expect(code).toBe(0);
  });

  it("names an unrecognised style shape in the red, and still does not count it", () => {
    // The strict rule leaves most flows unrecognised on purpose — a plain
    // variable, a type alias, a function's return type. What makes that
    // affordable is a red that points at the key, so the fix is in the message.
    const src = [
      'const vars = { "--plain": "1px" };',
      'export const S = () => <p className="x" style={vars} />;',
      'export const T = () => <p className="x" style={{ margin: "var(--plain)" }} />;',
    ].join("\n");
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "screens/S.tsx": src }));
    expect(out).toMatch(
      /FAIL: --plain is used but never defined \(.*S\.tsx:3\) — --plain is set at .*S\.tsx:1, but not in a shape this gate reads as a style/,
    );
    expect(code).toBe(1);

    // The hint reads a prefix the way the check does: one rule for both.
    const built = [
      'const steps = { "--sp-1": "4px" };',
      "export const U = (n: 1) => <p className=\"x\" style={{ gap: `var(--sp-${n})` }} />;",
    ].join("\n");
    const r = run(tree({ "styles/tokens.css": CSS, "screens/U.tsx": built }));
    expect(r.out).toMatch(/FAIL: var\(--sp-…\) can name no defined custom property: none starts with --sp- \(.*U\.tsx:2\) — --sp-1 is set at .*U\.tsx:1/);
    expect(r.code).toBe(1);
  });

  it("does not count a --x key in an ordinary object as a definition", () => {
    // Codex on PR #95: counting ANY `--x`-shaped key let a config or payload
    // object "define" a token no stylesheet or style ever sets, so a real
    // `var(--missing)` elsewhere passed while computing to nothing at runtime.
    const config = 'export const payload = { "--missing": 1, kind: "config" };';
    const screen = 'export const S = () => <p className="x" style={{ margin: "var(--missing)" }} />;';
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "lib/config.ts": config, "screens/S.tsx": screen }));
    expect(out).toContain("FAIL: --missing is used but never defined");
    expect(code).toBe(1);
  });

  it("does not count setProperty on something that is not a style", () => {
    const src = [
      'declare const api: { setProperty(k: string, v: number): void };',
      'api.setProperty("--notstyle", 1);',
      'export const S = () => <p className="x" style={{ margin: "var(--notstyle)" }} />;',
    ].join("\n");
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "screens/S.tsx": src }));
    expect(out).toContain("FAIL: --notstyle is used but never defined");
    // The hint's remedy fits the call: "type it CSSProperties" cannot apply
    // to a setProperty, and a remedy that cannot apply is noise in a red.
    expect(out).toMatch(/--notstyle is set at .*S\.tsx:2, by setProperty on something that is not `….style`/);
    expect(code).toBe(1);
  });

  it("reads token names with underscores whole (the CI copy truncated them)", () => {
    // CI's inline copy read names as [a-zA-Z0-9-], so `var(--a_c)` was seen as
    // `--a`, which IS defined, and passed. validate.sh's copy allowed `_`.
    const ok = 'export const S = () => <p className="x" style={{ margin: "var(--a_b)" }} />;';
    expect(run(tree({ "styles/tokens.css": CSS, "screens/S.tsx": ok })).code).toBe(0);

    const bad = 'export const S = () => <p className="x" style={{ margin: "var(--a_c)" }} />;';
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "screens/S.tsx": bad }));
    expect(out).toContain("FAIL: --a_c is used but never defined");
    expect(code).toBe(1);
  });

  it("does not read test files: a fixture may name a token that does not exist", () => {
    const test = 'it("x", () => render(<p className="t" style={{ color: "var(--nope)" }} />));';
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "screens/Ok.tsx": TSX, "screens/Ok.test.tsx": test }));
    expect(out).toContain("PASS:");
    expect(code).toBe(0);
  });

  describe("refuses to pass having checked nothing", () => {
    it("an empty tree", () => {
      const { code, out } = run(tree({}));
      expect(out).toContain("FAIL: no .css files found");
      expect(out).toContain("FAIL: no .ts/.tsx files found");
      expect(code).toBe(1);
    });

    it("a tree with no TS at all — the shipped gate's whole blind spot", () => {
      const { code, out } = run(tree({ "styles/tokens.css": CSS }));
      expect(out).toContain("FAIL: no .ts/.tsx files found");
      expect(code).toBe(1);
    });

    it("a TS scan that reads no string literals", () => {
      const { code, out } = run(tree({ "styles/tokens.css": CSS, "lib/n.ts": "export const n = 1;\n" }));
      expect(out).toContain("FAIL: the TypeScript scan read no string literals");
      expect(code).toBe(1);
    });
  });
});
